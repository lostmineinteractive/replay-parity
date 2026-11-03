import {
  ConfigError,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseThresholds,
  type Exchange,
} from '@replay-parity/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRule, shrink } from '../src/index.js';
import { sendJson, startStandIn, type StandIn } from './stand-in.js';

const stands: StandIn[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

/**
 * Sixteen fast reads and six slow ones. The slow route answers each request
 * after 20 ms times the number of slow requests since the last reset, so its
 * worst latency passes 70 ms only when a replay contains four of them.
 */
const exchanges: Exchange[] = [];
for (let i = 0; i < 22; i += 1) {
  const slow = i % 2 === 1 && exchanges.filter((e) => e.tags[0] === 'slow').length < 6;
  exchanges.push(
    makeExchange({
      index: i,
      request: makeRequest({ path: slow ? '/slow' : '/fast' }),
      response: jsonResponse({ ok: true }),
      tags: [slow ? 'slow' : 'fast'],
    }),
  );
}
const slowCount = exchanges.filter((e) => e.tags[0] === 'slow').length;

async function degradingCandidate(): Promise<{ stand: StandIn; reset: () => Promise<void> }> {
  let slowSeen = 0;
  const stand = await startStandIn(async (req, res) => {
    if (req.path === '/slow') {
      slowSeen += 1;
      await new Promise((r) => setTimeout(r, 40 * slowSeen));
    }
    sendJson(res, { ok: true });
  });
  stands.push(stand);
  return {
    stand,
    reset: () => {
      slowSeen = 0;
      return Promise.resolve();
    },
  };
}

// Three slow requests peak at 120 ms and four at 160 ms, 20 ms either side of the limit, so a
// machine stall cannot make a three step subset look like a breach.
const thresholds = parseThresholds('latency:\n  by_tag:\n    slow: { max_ms: 140 }\n');

describe('shrink to a latency breach', () => {
  // Retried because the judgement rests on real latencies; see the margin note above.
  it(
    'keeps the slow steps whose pooled sample still breaches, and says it is statistical',
    { retry: 2, timeout: 60_000 },
    async () => {
      expect(slowCount).toBe(6);
      const { stand, reset } = await degradingCandidate();
      const { reproduction } = await shrink({
        exchanges,
        target: stand.url,
        reset,
        rule: parseRule('latency:slow:max'),
        thresholds,
        repeat: 2,
        maxAttempts: 100,
      });
      expect(reproduction.rule).toBe('latency:slow:max');
      expect(reproduction.label).toBe('reduced reproduction (statistical)');
      expect(reproduction.repeat).toBe(2);
      expect(reproduction.successful).toBe(true);
      // Only the slow route matters, and four of its requests are needed to pass 70 ms.
      expect(reproduction.steps.every((s) => s.path === '/slow')).toBe(true);
      expect(reproduction.reduced_steps).toBe(4);
      // Every attempt replayed its subset twice.
      const replays = stand.requests.length;
      expect(replays).toBeGreaterThanOrEqual(2 * reproduction.attempts);
    },
  );

  it('judges the sample of all the repeats, not one replay', async () => {
    const { stand, reset } = await degradingCandidate();
    const seenResets: number[] = [];
    const { reproduction } = await shrink({
      exchanges: exchanges.slice(0, 8),
      target: stand.url,
      reset: async () => {
        seenResets.push(stand.requests.length);
        await reset();
      },
      rule: parseRule('latency:slow:p50'),
      // The median of the pooled sample of a short subset passes 10 ms.
      thresholds: parseThresholds('latency:\n  by_tag:\n    slow: { p50_ms: 10 }\n'),
      repeat: 3,
    });
    expect(reproduction.repeat).toBe(3);
    expect(seenResets.length).toBe(3 * reproduction.attempts);
  }, 60_000);

  it('reports an unsuccessful reduction when the breach does not reproduce', async () => {
    const { stand, reset } = await degradingCandidate();
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset,
      rule: parseRule('latency:slow:max'),
      thresholds: parseThresholds('latency:\n  by_tag:\n    slow: { max_ms: 5000 }\n'),
      repeat: 1,
    });
    expect(reproduction.successful).toBe(false);
    expect(reproduction.label).toBe('reduction unsuccessful');
    expect(reproduction.attempts).toBe(1);
    expect(reproduction.repeat).toBe(1);
  }, 60_000);

  it('needs the thresholds and a limit for the tag and metric', async () => {
    const { stand, reset } = await degradingCandidate();
    const base = { exchanges, target: stand.url, reset };
    await expect(shrink({ ...base, rule: parseRule('latency:slow:max') })).rejects.toThrow(
      'rule latency:slow:max needs the thresholds of the run for its limit',
    );
    await expect(
      shrink({ ...base, rule: parseRule('latency:slow:p99'), thresholds }),
    ).rejects.toThrow(
      "rule latency:slow:p99: the run's thresholds set no p99_ms limit under latency.by_tag.slow",
    );
    await expect(
      shrink({ ...base, rule: parseRule('latency:fast:max'), thresholds }),
    ).rejects.toThrow(ConfigError);
    await expect(
      shrink({ ...base, rule: parseRule('latency:slow:max'), thresholds, repeat: 0 }),
    ).rejects.toThrow('repeat must be a positive integer, got 0');
  });

  it('does not repeat attempts for other rules', async () => {
    const stand = await startStandIn((_req, res) => sendJson(res, { ok: false }));
    stands.push(stand);
    const { reproduction } = await shrink({
      exchanges: exchanges.slice(0, 2),
      target: stand.url,
      reset: () => Promise.resolve(),
      rule: { kind: 'mismatch', exchangeId: (exchanges[1] as Exchange).id },
      repeat: 5,
    });
    expect(reproduction.repeat).toBeUndefined();
    expect(reproduction.label).toBe('reduced reproduction');
  });
});
