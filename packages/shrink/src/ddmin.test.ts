import { makeRun, parseDiffRules, type Exchange } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { AttemptBudgetExceeded, chunk, ddmin } from './ddmin.js';
import { Prerequisites } from './prerequisites.js';
import { defaultRule, formatRule, parseRule, reproduces } from './rule.js';

describe('ddmin', () => {
  const items = Array.from({ length: 20 }, (_, i) => i + 1);

  it('reduces to the items the failure needs, in order', async () => {
    let attempts = 0;
    const result = await ddmin(items, {
      closure: (s) => [...s],
      test: (s) => {
        attempts += 1;
        return Promise.resolve(s.includes(3) && s.includes(11));
      },
    });
    expect(result).toEqual([3, 11]);
    expect(attempts).toBeLessThan(40);
  });

  it('keeps the whole list when nothing can be removed', async () => {
    const result = await ddmin([1, 2, 3], {
      closure: (s) => [...s],
      test: (s) => Promise.resolve(s.length === 3),
    });
    expect(result).toEqual([1, 2, 3]);
  });

  it('applies the closure and skips candidates that do not get smaller', async () => {
    const tried: number[][] = [];
    const result = await ddmin([1, 2, 3, 4], {
      // 4 needs 1; 3 needs 2.
      closure: (s) => {
        const set = new Set(s);
        if (set.has(4)) set.add(1);
        if (set.has(3)) set.add(2);
        return [...set].sort((a, b) => a - b);
      },
      test: (s) => {
        tried.push([...s]);
        return Promise.resolve(s.includes(4));
      },
    });
    expect(result).toEqual([1, 4]);
    for (const t of tried) if (t.includes(4)) expect(t).toContain(1);
  });

  it('propagates a budget error from the test', async () => {
    await expect(
      ddmin(items, {
        closure: (s) => [...s],
        test: () => Promise.reject(new AttemptBudgetExceeded()),
      }),
    ).rejects.toBeInstanceOf(AttemptBudgetExceeded);
  });

  describe('with a window of parallel tests', () => {
    const needs =
      (...wanted: number[]) =>
      (s: readonly number[]): Promise<boolean> =>
        Promise.resolve(wanted.every((w) => s.includes(w)));

    it('gives the sequential result for several predicates and widths', async () => {
      for (const wanted of [[3, 11], [1], [20], [2, 9, 17], [5, 6]]) {
        const sequential = await ddmin(items, { closure: (s) => [...s], test: needs(...wanted) });
        for (const parallel of [2, 3, 4, 8]) {
          const result = await ddmin(items, {
            closure: (s) => [...s],
            test: needs(...wanted),
            parallel,
          });
          expect(result, `${wanted.join(',')} x${parallel}`).toEqual(sequential);
        }
      }
    });

    it('runs the tests of a window at the same time and takes the first that reproduces', async () => {
      let inFlight = 0;
      let peak = 0;
      const discarded: number[][][] = [];
      const result = await ddmin(items, {
        closure: (s) => [...s],
        test: async (s) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return s.includes(3) && s.includes(11);
        },
        parallel: 4,
        onDiscard: (d) => discarded.push(d.map((x) => [...x])),
      });
      expect(result).toEqual([3, 11]);
      expect(peak).toBe(4);
      expect(discarded.length).toBeGreaterThan(0);
    });

    it('narrows the window to the limit and always runs at least one test', async () => {
      let peak = 0;
      let inFlight = 0;
      await ddmin(items, {
        closure: (s) => [...s],
        test: async (s) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight -= 1;
          return s.includes(3);
        },
        parallel: 6,
        limit: () => 0,
      });
      expect(peak).toBe(1);
    });

    it('throws the error of a test before the first reproducing one and ignores a later one', async () => {
      const early = ddmin(items, {
        closure: (s) => [...s],
        test: () => Promise.reject(new AttemptBudgetExceeded()),
        parallel: 2,
      });
      await expect(early).rejects.toBeInstanceOf(AttemptBudgetExceeded);
      // The first candidate of every window reproduces and the second would have failed.
      const late = await ddmin([1, 2, 3, 4], {
        closure: (s) => [...s],
        test: (s) =>
          s.includes(4) ? Promise.resolve(true) : Promise.reject(new AttemptBudgetExceeded()),
        parallel: 2,
      });
      expect(late).toEqual([4]);
    });
  });

  it('chunks evenly', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(chunk([1, 2, 3], 3)).toEqual([[1], [2], [3]]);
  });
});

describe('rules', () => {
  it('parses and formats both rule forms', () => {
    expect(parseRule('invariant:candidate:stock-on-hand')).toEqual({
      kind: 'invariant',
      system: 'candidate',
      name: 'stock-on-hand',
    });
    expect(parseRule('mismatch:01ABC')).toEqual({ kind: 'mismatch', exchangeId: '01ABC' });
    expect(parseRule('mismatch:01ABC:$.items[0].total')).toEqual({
      kind: 'mismatch',
      exchangeId: '01ABC',
      path: '$.items[0].total',
    });
    expect(formatRule(parseRule('mismatch:x:$.a'))).toBe('mismatch:x:$.a');
    expect(formatRule({ kind: 'invariant', system: 'reference', name: 'n', witness: 'w' })).toBe(
      'invariant:reference:n',
    );
    expect(() => parseRule('invariant:other:n')).toThrow(/expected invariant/);
    expect(() => parseRule('mismatch:')).toThrow(/expected/);
    expect(() => parseRule('nope')).toThrow(/expected/);
  });

  it('derives the default rule from a run and judges reproduction', () => {
    const run = makeRun();
    const rule = defaultRule(run);
    expect(rule).toEqual({ kind: 'mismatch', exchangeId: run.exchanges[1]?.id, path: '$.total' });
    expect(reproduces(run, rule!)).toBe(true);
    expect(reproduces(run, { kind: 'mismatch', exchangeId: run.exchanges[0]!.id })).toBe(false);
    expect(
      reproduces(run, { kind: 'mismatch', exchangeId: run.exchanges[1]!.id, path: '$.x' }),
    ).toBe(false);
    expect(
      reproduces({ ...run, inconclusive: [{ kind: 'barrier_timeout', detail: 'x' }] }, rule!),
    ).toBe(false);
    expect(reproduces(run, { kind: 'invariant', system: 'candidate', name: 'x' })).toBe(false);
    expect(defaultRule(makeRun({ exchanges: [] }))).toBeNull();
  });
});

describe('Prerequisites', () => {
  const exchanges: Exchange[] = [
    {
      id: 'a',
      ts: '2026-10-16T00:00:00.000Z',
      offset_ms: 0,
      adapter: 'http',
      request: {
        method: 'POST',
        path: '/v1/orders',
        query: {},
        headers: {},
        body: { sku: 'A', qty: 1 },
      },
      response: { status: 201, headers: {}, latency_ms: 1, body: { order_id: 'o-1' } },
      tags: ['create-order'],
    },
    {
      id: 'b',
      ts: '2026-10-16T00:00:00.100Z',
      offset_ms: 100,
      adapter: 'http',
      request: { method: 'GET', path: '/v1/ledger', query: {}, headers: {} },
      response: { status: 200, headers: {}, latency_ms: 1, body: {} },
      tags: ['list-ledger'],
    },
    {
      id: 'c',
      ts: '2026-10-16T00:00:00.200Z',
      offset_ms: 200,
      adapter: 'http',
      request: {
        method: 'POST',
        path: '/v1/orders/o-1/cancel',
        query: {},
        headers: {},
        body: { originated_at: 'T' },
      },
      response: { status: 200, headers: {}, latency_ms: 1, body: { order_id: 'o-1' } },
      tags: ['cancel-order'],
    },
    {
      id: 'd',
      ts: '2026-10-16T00:00:00.300Z',
      offset_ms: 300,
      adapter: 'http',
      request: { method: 'GET', path: '/v1/orders/o-9', query: {}, headers: {} },
      response: { status: 404, headers: {}, latency_ms: 1, body: {} },
      tags: ['get-order'],
    },
  ];

  it('keeps the create for any request on the order and the always set', () => {
    const p = new Prerequisites(exchanges, parseDiffRules(''));
    expect(p.of(2)).toEqual([0]);
    expect(p.of(3)).toEqual([]);
    expect(p.closure([2])).toEqual([0, 2]);
    expect(p.closure([1], [3])).toEqual([1, 3]);
  });

  it('also follows substitution dependencies', () => {
    const rules = parseDiffRules(
      'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
    );
    const p = new Prerequisites(exchanges, rules);
    expect(p.of(2)).toEqual([0]);
  });
});
