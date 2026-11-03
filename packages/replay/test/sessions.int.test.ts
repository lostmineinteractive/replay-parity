import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  compileRunValidator,
  jsonResponse,
  loadDiffRules,
  makeExchange,
  makeRequest,
  parseDiffRules,
  type Exchange,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { replay, type Adapter } from '../src/index.js';
import { logFailedAttempt, writeRecording } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = resolve(ROOT, 'demo/recording.jsonl');
const BASELINE = resolve(import.meta.dirname, 'fixtures/demo-baseline.jsonl');

let validate: RunValidator;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function startCandidate(divergences: DivergenceSetting): Promise<string> {
  const app = buildApp({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

interface BaselineRow {
  divergences: string;
  id: string;
  method: string;
  path: string;
  error: boolean;
  verdict: string | null;
  findings: [string, boolean, string | null][];
}

function rowsOf(run: Run, divergences: string): BaselineRow[] {
  return run.exchanges.map((e) => ({
    divergences,
    id: e.id,
    method: e.method,
    path: e.path,
    error: e.error !== null,
    verdict: e.diff?.verdict ?? null,
    findings: (e.diff?.findings ?? []).map((f) => [f.path, f.tolerated, f.rule ?? null]),
  }));
}

/**
 * A recording of `sessions` clients that each sent `perSession` requests one after another.
 * The whole recording is sequential: every response arrived before the next request of any
 * session began, so without a session key nothing may overlap. The rows are grouped by
 * session, so a scheduler without look ahead would serve one session at a time.
 */
function sessionRecording(sessions: number, perSession: number): Exchange[] {
  const out: Exchange[] = [];
  for (let s = 0; s < sessions; s += 1) {
    for (let k = 0; k < perSession; k += 1) {
      const index = out.length;
      out.push(
        makeExchange({
          index,
          offset_ms: index * 10,
          tags: ['step'],
          request: makeRequest({ path: `/s${s}/${k}`, headers: { 'x-session': `s${s}` } }),
          response: jsonResponse({ ok: true }, 200, 5),
        }),
      );
    }
  }
  return out;
}

/** A candidate that answers every request after a fixed delay and counts what is in flight. */
function delayAdapter(delayMs: number): Adapter & { peak: number } {
  let inflight = 0;
  const adapter = {
    name: 'fake',
    peak: 0,
    async send() {
      inflight += 1;
      adapter.peak = Math.max(adapter.peak, inflight);
      await sleep(delayMs);
      inflight -= 1;
      return jsonResponse({ ok: true }, 200, delayMs);
    },
  };
  return adapter;
}

describe('session parallelism', () => {
  it('replays the demo without a session key exactly as before', async () => {
    const expected = (await readFile(BASELINE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as BaselineRow);
    const rules = await loadDiffRules(resolve(ROOT, 'demo/diff-rules.yaml'));
    const actual: BaselineRow[] = [];
    for (const divergences of ['off', 'on'] as const) {
      const run = await replay({
        recording: RECORDING,
        target: await startCandidate(divergences),
        pace: 'max',
        concurrency: 1,
        rules,
        barrierTags: ['list-ledger'],
      });
      expect(run.pacing.session_key).toBeNull();
      expect(run.pacing.sessions).toBe(1);
      actual.push(...rowsOf(run, divergences));
    }
    // The baseline was written by the engine before sessions existed: the same exchanges in
    // the same order, with the same verdicts and the same findings.
    expect(actual).toEqual(expected);
  });

  it(
    'reaches about ten times the sequential rate with ten independent sessions and keeps order within each',
    { retry: 2 },
    async () => {
      const recording = await writeRecording(sessionRecording(10, 12));
      const sequentialAdapter = delayAdapter(20);
      const sequential = await replay({
        recording,
        target: 'fake://',
        adapter: sequentialAdapter,
        pace: 'max',
        concurrency: 10,
      });
      const parallelAdapter = delayAdapter(20);
      const parallel = await replay({
        recording,
        target: 'fake://',
        adapter: parallelAdapter,
        pace: 'max',
        concurrency: 10,
        sessionKey: 'header:x-session',
      });
      logFailedAttempt(sequential, parallel);
      expect(sequentialAdapter.peak).toBe(1);
      expect(parallelAdapter.peak).toBe(10);
      expect(parallel.pacing).toMatchObject({ session_key: 'header:x-session', sessions: 10 });
      expect(parallel.stats.overall.matches).toBe(120);
      // Ten sessions of twelve sequential 20 ms requests take about 240 ms against about
      // 2400 ms for the sequential run on a quiet machine, a ratio near 10. The ratio is read
      // from the runs' own achieved_rps, and the bound of 5 leaves room for a stall of the
      // worker during the shorter run, which the retry covers as well.
      expect(parallel.pacing.achieved_rps / sequential.pacing.achieved_rps).toBeGreaterThan(5);
      // Order within a session: each request is sent after the previous one of its session
      // was acknowledged, and the results stay in recording order.
      expect(parallel.exchanges.map((e) => e.path)).toEqual(
        sequential.exchanges.map((e) => e.path),
      );
      for (let s = 0; s < 10; s += 1) {
        const mine = parallel.exchanges.filter((e) => e.path.startsWith(`/s${s}/`));
        expect(mine).toHaveLength(12);
        for (let k = 1; k < mine.length; k += 1) {
          expect(mine[k]?.sent_at_ms).toBeGreaterThanOrEqual(mine[k - 1]?.acked_at_ms ?? Infinity);
        }
      }
      expect(validate(parallel), validate.errors ?? '').toBe(true);
    },
  );

  it('keeps barriers and controls in order across every session', async () => {
    const log: string[] = [];
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        log.push(`start ${req.path}`);
        await sleep(req.path.includes('slow') ? 30 : 2);
        log.push(`end ${req.path}`);
        return jsonResponse({ ok: true }, 200, 1);
      },
    };
    const exchanges = [
      makeExchange({
        index: 0,
        request: makeRequest({ path: '/a/slow', headers: { 'x-session': 'a' } }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
      makeExchange({
        index: 1,
        tags: ['snapshot'],
        request: makeRequest({ path: '/b/snapshot', headers: { 'x-session': 'b' } }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
      makeExchange({
        index: 2,
        request: makeRequest({ path: '/c/after', headers: { 'x-session': 'c' } }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
      makeExchange({
        index: 3,
        tags: ['admin-restart'],
        request: makeRequest({ method: 'POST', path: '/admin/restart' }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
      makeExchange({
        index: 4,
        request: makeRequest({ path: '/a/last', headers: { 'x-session': 'a' } }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
    ];
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 8,
      sessionKey: 'header:x-session',
      barrierTags: ['snapshot'],
      rules: parseDiffRules('controls:\n  tags: [admin-restart]\n'),
    });
    // The snapshot of session b waits for the slow request of session a and runs alone, and
    // nothing of session c starts before it is acknowledged. The control does the same.
    expect(log).toEqual([
      'start /a/slow',
      'end /a/slow',
      'start /b/snapshot',
      'end /b/snapshot',
      'start /c/after',
      'end /c/after',
      'start /admin/restart',
      'end /admin/restart',
      'start /a/last',
      'end /a/last',
    ]);
    expect(run.pacing.barrier_waits).toBe(2);
    expect(run.pacing.sessions).toBe(4);
    expect(run.verdict).toBe('pass');
  });

  it('waits for a substituted value produced in another session', async () => {
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        if (req.method === 'POST') {
          await sleep(40);
          return jsonResponse({ order_id: 'cand-1' }, 201, 40);
        }
        return jsonResponse({ order_id: req.path.split('/').pop() ?? '' }, 200, 1);
      },
    };
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['create-order'],
        request: makeRequest({ method: 'POST', path: '/orders', headers: { 'x-session': 'a' } }),
        response: jsonResponse({ order_id: 'ref-1' }, 201, 5),
      }),
      makeExchange({
        index: 1,
        tags: ['get-order'],
        request: makeRequest({ path: '/orders/ref-1', headers: { 'x-session': 'b' } }),
        response: jsonResponse({ order_id: 'ref-1' }, 200, 5),
      }),
    ];
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
      sessionKey: 'header:x-session',
      rules: parseDiffRules(
        'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
      ),
    });
    const [create, read] = run.exchanges;
    expect(read?.sent_at_ms).toBeGreaterThanOrEqual(create?.acked_at_ms ?? Infinity);
    expect(read?.diff?.verdict).toBe('tolerated');
    expect(run.pacing.sessions).toBe(2);
  });

  it('keeps the exchanges without a session value in one session of their own', async () => {
    let inflight = 0;
    let peak = 0;
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        if (req.headers['x-session'] === undefined) {
          inflight += 1;
          peak = Math.max(peak, inflight);
        }
        await sleep(5);
        if (req.headers['x-session'] === undefined) inflight -= 1;
        return jsonResponse({ ok: true }, 200, 1);
      },
    };
    // Sequential in the recording: six without a value and six of session a, interleaved.
    const exchanges = Array.from({ length: 12 }, (_, i) =>
      makeExchange({
        index: i,
        request: makeRequest({
          path: `/n/${i}`,
          headers: i % 2 === 0 ? {} : { 'x-session': 'a' },
        }),
        response: jsonResponse({ ok: true }, 200, 1),
      }),
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 8,
      sessionKey: 'header:x-session',
    });
    expect(peak).toBe(1);
    expect(run.pacing.sessions).toBe(2);
    const loose = run.exchanges.filter((_, i) => i % 2 === 0);
    for (let k = 1; k < loose.length; k += 1) {
      expect(loose[k]?.sent_at_ms).toBeGreaterThanOrEqual(loose[k - 1]?.acked_at_ms ?? Infinity);
    }
  });

  it('rejects a session key it cannot read', async () => {
    await expect(
      replay({ recording: RECORDING, target: 'x', sessionKey: 'session-id' }),
    ).rejects.toThrow(/--session-key session-id/);
  });
});
