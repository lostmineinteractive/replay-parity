import { setTimeout as sleep } from 'node:timers/promises';
import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { replay, type Adapter } from '../src/index.js';
import { logFailedAttempt, writeRecording } from './helpers.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

const echo: Adapter = {
  name: 'fake',
  send(req) {
    return Promise.resolve(jsonResponse({ echo: req.path }, 200, 1));
  },
};

/** Six exchanges recorded 100 ms apart, each answered long before the next began. */
function spaced() {
  return Array.from({ length: 6 }, (_, i) =>
    makeExchange({
      index: i,
      offset_ms: 1000 + i * 100,
      request: makeRequest({ path: `/g/${i}` }),
      response: jsonResponse({ echo: `/g/${i}` }, 200, 1),
    }),
  );
}

describe('the speed factor', () => {
  it('divides the recorded gaps under as-recorded pacing', { retry: 2 }, async () => {
    const recording = await writeRecording(spaced());
    const normal = await replay({ recording, target: 'fake://', adapter: echo });
    const fast = await replay({ recording, target: 'fake://', adapter: echo, speed: 2 });
    logFailedAttempt(normal, fast);
    expect(normal.pacing.speed).toBe(1);
    expect(fast.pacing.speed).toBe(2);
    expect(fast.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 50, 100, 150, 200, 250]);
    expect(normal.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(fast.pacing.requested_rps).toBe(20);
    expect(normal.pacing.requested_rps).toBe(10);
    for (const e of fast.exchanges) {
      // Timer granularity: a send may start a fraction of a millisecond early.
      expect(e.sent_at_ms).toBeGreaterThanOrEqual(e.scheduled_at_ms - 2);
    }
    // The sends span at least the scaled schedule.
    expect(fast.exchanges[5]!.sent_at_ms).toBeGreaterThanOrEqual(248);
    expect(fast.stats.overall.matches).toBe(6);
    expect(validate(fast), validate.errors ?? '').toBe(true);
  });

  it('applies the gap cap before the factor', async () => {
    const exchanges = spaced().map((e, i) => ({ ...e, offset_ms: i === 5 ? 60_000 : e.offset_ms }));
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter: echo,
      maxGapMs: 200,
      speed: 4,
    });
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 25, 50, 75, 100, 150]);
    expect(run.pacing.gaps_capped).toBe(1);
  });

  it('is rejected outside as-recorded pacing and when it is not a positive number', async () => {
    const recording = await writeRecording(spaced());
    await expect(
      replay({ recording, target: 'fake://', adapter: echo, pace: 'max', speed: 2 }),
    ).rejects.toThrow(/--speed scales recorded gaps under as-recorded pacing only, not max/);
    await expect(replay({ recording, target: 'fake://', adapter: echo, speed: 0 })).rejects.toThrow(
      /--speed must be a positive number/,
    );
    const max = await replay({ recording, target: 'fake://', adapter: echo, pace: 'max' });
    expect(max.pacing.speed).toBeNull();
  });
});

describe('looping', () => {
  const rules = parseDiffRules(
    'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
  );

  /** A create and a read of what it created, recorded with the reference's id. */
  const exchanges = [
    makeExchange({
      index: 0,
      tags: ['create-order'],
      request: makeRequest({ method: 'POST', path: '/orders' }),
      response: jsonResponse({ order_id: 'ref-1' }, 201, 2),
    }),
    makeExchange({
      index: 1,
      tags: ['get-order'],
      request: makeRequest({ path: '/orders/ref-1' }),
      response: jsonResponse({ order_id: 'ref-1' }, 200, 2),
    }),
    makeExchange({
      index: 2,
      tags: ['list'],
      request: makeRequest({ path: '/orders' }),
      response: jsonResponse({ count: 1 }, 200, 2),
    }),
  ];

  /** Assigns a new id on every create, as a real system does. */
  function counter(): Adapter & { paths: string[] } {
    let next = 0;
    const adapter = {
      name: 'fake',
      paths: [] as string[],
      async send(req: { method: string; path: string }) {
        adapter.paths.push(`${req.method} ${req.path}`);
        await sleep(2);
        if (req.method === 'POST') {
          next += 1;
          return jsonResponse({ order_id: `cand-${next}` }, 201, 2);
        }
        if (req.path === '/orders') return jsonResponse({ count: 1 }, 200, 2);
        return jsonResponse({ order_id: req.path.split('/').pop() ?? '' }, 200, 2);
      },
    };
    return adapter;
  }

  it('replays the selection n times with suffixed ids and a fresh substitution table each time', async () => {
    const adapter = counter();
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
      loop: 3,
      rules,
    });
    expect(run.exchanges.map((e) => e.id)).toEqual(
      [1, 2, 3].flatMap((k) => exchanges.map((e) => `${e.id}#${k}`)),
    );
    // Each iteration's read uses the id its own create returned, which is only possible when
    // the table starts empty: a kept table would map ref-1 to cand-1 forever.
    expect(adapter.paths).toEqual([
      'POST /orders',
      'GET /orders/cand-1',
      'GET /orders',
      'POST /orders',
      'GET /orders/cand-2',
      'GET /orders',
      'POST /orders',
      'GET /orders/cand-3',
      'GET /orders',
    ]);
    expect(run.exchanges.every((e) => e.diff?.verdict !== 'mismatch')).toBe(true);
    expect(run.pacing.loop).toBe(3);
    expect(run.recording.selected).toBe(3);
    expect(run.stats.overall.count).toBe(9);
    // An iteration starts once the previous one is acknowledged.
    for (const k of [3, 6]) {
      expect(run.exchanges[k]!.sent_at_ms).toBeGreaterThanOrEqual(
        Math.max(...run.exchanges.slice(0, k).map((e) => e.acked_at_ms ?? Infinity)),
      );
    }
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('counts warmup over the whole run and names every iteration in a stop', async () => {
    const controller = new AbortController();
    const adapter: Adapter = {
      name: 'fake',
      async send(req, ctx) {
        if (ctx.id.endsWith('#2') && req.path === '/orders') controller.abort();
        await sleep(2);
        return jsonResponse({ count: 1 }, 200, 2);
      },
    };
    const run = await replay({
      recording: await writeRecording(exchanges.slice(2)),
      target: 'fake://',
      adapter,
      pace: 'max',
      loop: 4,
      warmup: 1,
      signal: controller.signal,
    });
    expect(run.inconclusive[0]?.detail).toBe('stopped by signal after 2 of 4 exchanges');
    expect(run.exchanges.map((e) => e.warmup)).toEqual([true, false]);
  });

  it('rejects a loop that is not a positive integer and a loop with the invariants', async () => {
    const recording = await writeRecording(exchanges);
    await expect(replay({ recording, target: 'fake://', adapter: echo, loop: 0 })).rejects.toThrow(
      /--loop must be a positive integer/,
    );
    await expect(
      replay({ recording, target: 'fake://', adapter: echo, loop: 2, invariants: true }),
    ).rejects.toThrow(/cannot be combined with --loop/);
    const once = await replay({ recording, target: 'fake://', adapter: echo, pace: 'max' });
    expect(once.pacing.loop).toBe(1);
    expect(once.exchanges.map((e) => e.id)).toEqual(exchanges.map((e) => e.id));
  });
});
