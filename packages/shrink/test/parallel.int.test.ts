import type { Exchange } from '@replay-parity/core';
import { afterEach, describe, expect, it } from 'vitest';
import { shrink } from '../src/index.js';
import { orderExchange, sendJson, startStandIn, type StandIn } from './stand-in.js';

const stands: StandIn[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

/** Sixty four orders numbered by index. */
const exchanges: Exchange[] = Array.from({ length: 64 }, (_, n) => orderExchange(n, { n }));
const NEEDED = [5, 13, 29, 41];
const WITNESS = 57;

interface Candidate {
  stand: StandIn;
  reset: () => Promise<void>;
  resets: () => number;
}

/**
 * A stateful candidate. It remembers the order numbers it has seen since the
 * last reset and answers `{ ok: false }` to order 57 only when it has seen all
 * of the needed ones, so a reproduction needs five scattered steps.
 */
async function candidate(resetMs: number): Promise<Candidate> {
  let seen = new Set<number>();
  let resets = 0;
  const stand = await startStandIn((req, res) => {
    const n = (req.body as { n: number }).n;
    seen.add(n);
    const broken = n === WITNESS && NEEDED.every((x) => seen.has(x));
    sendJson(res, { ok: !broken });
  });
  stands.push(stand);
  return {
    stand,
    resets: () => resets,
    reset: async () => {
      await new Promise((r) => setTimeout(r, resetMs));
      resets += 1;
      seen = new Set();
    },
  };
}

const rule = {
  kind: 'mismatch' as const,
  exchangeId: (exchanges[WITNESS] as Exchange).id,
  path: '$.ok',
};

describe('parallel attempts', () => {
  it('give the same reduction and attempt count as one target in less wall time', async () => {
    const a = await candidate(40);
    const b = await candidate(40);

    const t0 = Date.now();
    const single = await shrink({
      exchanges,
      target: a.stand.url,
      reset: a.reset,
      rule,
      maxAttempts: 200,
    });
    const singleMs = Date.now() - t0;
    expect(single.reproduction.successful).toBe(true);
    expect(single.reproduction.reduced_steps).toBe(NEEDED.length + 1);
    expect(single.speculative).toBe(0);
    expect(a.resets()).toBe(single.reproduction.attempts);

    const aBefore = a.resets();
    const t1 = Date.now();
    const both = await shrink({
      exchanges,
      target: a.stand.url,
      reset: a.reset,
      extraTargets: [{ target: b.stand.url, reset: b.reset }],
      rule,
      maxAttempts: 200,
    });
    const bothMs = Date.now() - t1;

    expect(both.reproduction.steps).toEqual(single.reproduction.steps);
    expect(both.reproduction.reduced_steps).toBe(single.reproduction.reduced_steps);
    expect(both.reproduction.attempts).toBe(single.reproduction.attempts);
    expect(both.exchanges.map((e) => e.id)).toEqual(single.exchanges.map((e) => e.id));
    // Both candidates took attempts. The replays run ahead are counted apart from the attempts.
    expect(a.resets() - aBefore).toBeGreaterThan(0);
    expect(b.resets()).toBeGreaterThan(0);
    expect(a.resets() - aBefore + b.resets()).toBe(both.reproduction.attempts + both.speculative);
    expect(bothMs).toBeLessThan(singleMs * 0.8);
  }, 120_000);

  it('spend no more of the attempt budget than one target does', async () => {
    const a = await candidate(0);
    const b = await candidate(0);
    for (const maxAttempts of [3, 7, 12]) {
      const single = await shrink({
        exchanges,
        target: a.stand.url,
        reset: a.reset,
        rule,
        maxAttempts,
      });
      const both = await shrink({
        exchanges,
        target: a.stand.url,
        reset: a.reset,
        extraTargets: [{ target: b.stand.url, reset: b.reset }],
        rule,
        maxAttempts,
      });
      expect(both.reproduction.attempts, `budget ${maxAttempts}`).toBe(
        single.reproduction.attempts,
      );
      expect(both.reproduction.steps, `budget ${maxAttempts}`).toEqual(single.reproduction.steps);
    }
  }, 60_000);
});
