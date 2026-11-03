import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  type Exchange,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SendError, replay, type Adapter, type SendErrorKind } from '../src/index.js';
import { writeRecording } from './helpers.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

/** Fails the first `failures` sends of every path with `kind`, then answers. */
function flaky(failures: number, kind: SendErrorKind): Adapter & { sends: Map<string, number> } {
  const adapter = {
    name: 'fake',
    sends: new Map<string, number>(),
    send(req: { path: string }) {
      const n = (adapter.sends.get(req.path) ?? 0) + 1;
      adapter.sends.set(req.path, n);
      if (n <= failures) return Promise.reject(new SendError(kind, `attempt ${n} failed`));
      return Promise.resolve(jsonResponse({ ok: true }, 200, 1));
    },
  };
  return adapter;
}

function one(method = 'GET', tags = ['read']): Exchange[] {
  return [
    makeExchange({
      index: 0,
      tags,
      request: makeRequest({ method, path: '/x' }),
      response: jsonResponse({ ok: true }, 200, 1),
    }),
  ];
}

describe('retries', () => {
  it('retries a timeout, records the attempts and the first error, and counts it as retried', async () => {
    const adapter = flaky(2, 'timeout');
    const run = await replay({
      recording: await writeRecording(one()),
      target: 'fake://',
      adapter,
      pace: 'max',
      retry: 3,
      retryBaseMs: 1,
      random: () => 0,
    });
    const [e] = run.exchanges;
    expect(e).toMatchObject({
      attempts: 3,
      first_error: 'timeout: attempt 1 failed',
      error: null,
      diff: { verdict: 'match' },
    });
    expect(run.stats.overall.errors).toBe(0);
    // A pass on a retry is still visible in the statistics.
    expect(run.stats.retried).toEqual({ overall: 1, by_tag: { read: 1 } });
    expect(run.pacing.retry).toEqual({
      max: 3,
      on: ['connection', 'timeout'],
      base_ms: 1,
      unsafe: false,
    });
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('records the last failure when every attempt fails', async () => {
    const adapter = flaky(10, 'connection');
    const run = await replay({
      recording: await writeRecording(one()),
      target: 'fake://',
      adapter,
      pace: 'max',
      retry: 2,
      retryBaseMs: 1,
    });
    expect(adapter.sends.get('/x')).toBe(3);
    expect(run.exchanges[0]).toMatchObject({
      attempts: 3,
      first_error: 'connection: attempt 1 failed',
      error: 'connection: attempt 3 failed',
      candidate: null,
    });
    expect(run.stats.overall.errors).toBe(1);
    expect(run.stats.retried?.overall).toBe(1);
  });

  it('never retries a method that is not idempotent unless told to', async () => {
    const recording = await writeRecording(one('POST', ['create']));
    const safe = flaky(1, 'timeout');
    const refused = await replay({
      recording,
      target: 'fake://',
      adapter: safe,
      pace: 'max',
      retry: 3,
      retryBaseMs: 1,
    });
    expect(safe.sends.get('/x')).toBe(1);
    expect(refused.exchanges[0]?.attempts).toBeUndefined();
    expect(refused.exchanges[0]?.error).toBe('timeout: attempt 1 failed');
    expect(refused.stats.retried).toEqual({ overall: 0, by_tag: {} });

    const unsafe = flaky(1, 'timeout');
    const allowed = await replay({
      recording,
      target: 'fake://',
      adapter: unsafe,
      pace: 'max',
      retry: 3,
      retryBaseMs: 1,
      retryUnsafe: true,
    });
    expect(unsafe.sends.get('/x')).toBe(2);
    expect(allowed.exchanges[0]).toMatchObject({ attempts: 2, error: null });
    expect(allowed.pacing.retry?.unsafe).toBe(true);
  });

  it('retries only the kinds it is told to', async () => {
    const adapter = flaky(1, 'connection');
    const run = await replay({
      recording: await writeRecording(one()),
      target: 'fake://',
      adapter,
      pace: 'max',
      retry: 3,
      retryOn: ['timeout'],
      retryBaseMs: 1,
    });
    expect(adapter.sends.get('/x')).toBe(1);
    expect(run.exchanges[0]?.error).toBe('connection: attempt 1 failed');
    // A protocol error is the candidate's behavior and is never retried.
    const protocol = flaky(1, 'protocol');
    await replay({
      recording: await writeRecording(one()),
      target: 'fake://',
      adapter: protocol,
      pace: 'max',
      retry: 3,
      retryBaseMs: 1,
    });
    expect(protocol.sends.get('/x')).toBe(1);
  });

  it('waits a doubling backoff between attempts', async () => {
    const adapter = flaky(2, 'timeout');
    const run = await replay({
      recording: await writeRecording(one()),
      target: 'fake://',
      adapter,
      pace: 'max',
      retry: 2,
      retryBaseMs: 40,
      random: () => 1,
    });
    const e = run.exchanges[0]!;
    // 40 ms and then 80 ms with the jitter factor at its top. Only the lower bound is judged.
    expect((e.acked_at_ms ?? 0) - e.sent_at_ms).toBeGreaterThanOrEqual(118);
  });

  it('sends once by default and rejects a bad policy', async () => {
    const adapter = flaky(1, 'timeout');
    const recording = await writeRecording(one());
    const run = await replay({ recording, target: 'fake://', adapter, pace: 'max' });
    expect(adapter.sends.get('/x')).toBe(1);
    expect(run.pacing.retry).toBeNull();
    expect(run.stats.retried).toBeUndefined();
    expect(run.exchanges[0]?.attempts).toBeUndefined();
    await expect(replay({ recording, target: 'fake://', adapter, retry: -1 })).rejects.toThrow(
      /--retry must be a non negative integer/,
    );
    await expect(
      replay({ recording, target: 'fake://', adapter, retry: 1, retryOn: [] }),
    ).rejects.toThrow(/--retry-on needs/);
    await expect(
      replay({ recording, target: 'fake://', adapter, retry: 1, retryBaseMs: -5 }),
    ).rejects.toThrow(/--retry-base-ms/);
  });
});
