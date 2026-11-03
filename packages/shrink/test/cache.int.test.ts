import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  readRecording,
  type Exchange,
} from '@replay-parity/core';
import { buildApp } from '@replay-parity/demo-candidate';
import { replayExchanges } from '@replay-parity/replay';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryAttemptCache,
  defaultRule,
  openAttemptCache,
  shrink,
  type ShrinkRule,
} from '../src/index.js';
import { orderExchange, sendJson, startStandIn, type StandIn } from './stand-in.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');
const RULES = parseDiffRules(`
ignore: ["$.created_at"]
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function demoCandidate(): Promise<string> {
  const app = buildApp({ divergences: ['shipment-applied-twice'], seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

const resetter = (url: string) => async (): Promise<void> => {
  await fetch(`${url}/admin/reset`, { method: 'POST' });
};

describe('attempt memoization', () => {
  it('answers a second shrink of the same run from the cache with no new attempts', async () => {
    const url = await demoCandidate();
    const recording = await readRecording(RECORDING);
    await resetter(url)();
    const run = await replayExchanges(recording, {
      recording: RECORDING,
      target: url,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      invariants: true,
    });
    const rule = defaultRule(run) as ShrinkRule;
    const dir = await mkdtemp(join(tmpdir(), 'rp-cache-int-'));
    const path = join(dir, 'attempts.jsonl');
    const options = { exchanges: recording, target: url, reset: resetter(url), rule };

    const first = await shrink({
      ...options,
      replay: { rules: RULES },
      cache: await openAttemptCache(path),
    });
    expect(first.reproduction.attempts).toBeGreaterThan(1);
    // Lowering asks about a state it has judged already, and the cache answers within the run.
    const judged = first.reproduction.attempts + (first.reproduction.cache_hits ?? 0);
    const stored = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    expect(stored).toHaveLength(first.reproduction.attempts);

    let resets = 0;
    const second = await shrink({
      ...options,
      reset: async () => {
        resets += 1;
        await resetter(url)();
      },
      replay: { rules: RULES },
      cache: await openAttemptCache(path),
    });
    expect(resets).toBe(0);
    expect(second.reproduction.attempts).toBe(0);
    expect(second.reproduction.cache_hits).toBe(judged);
    expect(second.reproduction.successful).toBe(true);
    expect(second.reproduction.steps).toEqual(first.reproduction.steps);
    expect(second.exchanges.map((e) => e.id)).toEqual(first.exchanges.map((e) => e.id));
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toEqual(stored);
  }, 60_000);

  it('reports a cached verdict to onAttempt without counting an attempt', async () => {
    const stand = await startStandIn((_req, res) => sendJson(res, { ok: false }));
    cleanups.push(() => stand.close());
    const exchanges = [orderExchange(0, { n: 0 })];
    const cache = new MemoryAttemptCache();
    const rule = { kind: 'mismatch' as const, exchangeId: (exchanges[0] as Exchange).id };
    await shrink({ exchanges, target: stand.url, reset: () => Promise.resolve(), rule, cache });
    const events: { attempt: number; cached?: boolean | undefined }[] = [];
    const again = await shrink({
      exchanges,
      target: stand.url,
      reset: () => Promise.resolve(),
      rule,
      cache,
      onAttempt: (e) => events.push({ attempt: e.attempt, cached: e.cached }),
    });
    expect(events).toEqual([{ attempt: 0, cached: true }]);
    expect(again.reproduction.attempts).toBe(0);
    expect(stand.requests).toHaveLength(1);
  });

  it('does not keep a verdict from an attempt the harness could not complete', async () => {
    // The control exchange gets a 500, so every attempt is inconclusive.
    const stand: StandIn = await startStandIn((req, res) => {
      if (req.path === '/control') sendJson(res, { error: 'down' }, 500);
      else sendJson(res, { ok: false });
    });
    cleanups.push(() => stand.close());
    const exchanges: Exchange[] = [
      orderExchange(0, { n: 0 }),
      makeExchange({
        index: 1,
        request: makeRequest({ method: 'POST', path: '/control' }),
        response: jsonResponse({ ok: true }),
        tags: ['ctl'],
      }),
      orderExchange(2, { n: 2 }),
    ];
    const cache = new MemoryAttemptCache();
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset: () => Promise.resolve(),
      rule: { kind: 'mismatch', exchangeId: (exchanges[2] as Exchange).id },
      replay: { rules: parseDiffRules('controls:\n  tags: [ctl]\n') },
      cache,
    });
    expect(reproduction.successful).toBe(false);
    expect(reproduction.attempts).toBe(1);
    expect(cache.size).toBe(0);
  });
});
