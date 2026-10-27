import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exactSummary } from './histogram.js';

/**
 * Property based tests for the exact summary. Fixed seed, see
 * ../differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

const samplesArb = fc.array(fc.double({ min: 0, max: 10_000, noNaN: true }), {
  minLength: 1,
  maxLength: 60,
});

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe('exactSummary properties', () => {
  it('has monotone percentiles and a mean between min and max for any non empty sample', () => {
    fc.assert(
      fc.property(samplesArb, (values) => {
        const s = exactSummary(values);
        const min = round3(Math.min(...values));
        const max = round3(Math.max(...values));
        expect(s.count).toBe(values.length);
        expect(s.p50_ms).toBeGreaterThanOrEqual(min);
        expect(s.p50_ms).toBeLessThanOrEqual(s.p90_ms);
        expect(s.p90_ms).toBeLessThanOrEqual(s.p99_ms);
        expect(s.p99_ms).toBeLessThanOrEqual(s.p999_ms);
        expect(s.p999_ms).toBeLessThanOrEqual(s.max_ms);
        expect(s.max_ms).toBe(max);
        // The mean is rounded to three decimals after the division, so allow one unit of rounding.
        expect(s.mean_ms).toBeGreaterThanOrEqual(min - 0.001);
        expect(s.mean_ms).toBeLessThanOrEqual(max + 0.001);
      }),
      params,
    );
  });

  it('does not depend on the order of the samples, and every percentile is one of them', () => {
    fc.assert(
      fc.property(samplesArb, fc.nat(), (values, seed) => {
        const s = exactSummary(values);
        const cut = seed % values.length;
        const rotated = [...values.slice(cut), ...values.slice(0, cut)];
        expect(exactSummary(rotated)).toEqual(s);
        expect(exactSummary([...values].reverse())).toEqual(s);
        const rounded = new Set(values.map(round3));
        for (const p of [s.p50_ms, s.p90_ms, s.p99_ms, s.p999_ms, s.max_ms]) {
          expect(rounded.has(p)).toBe(true);
        }
      }),
      params,
    );
  });

  it('a single sample is its own every percentile', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10_000, noNaN: true }), (v) => {
        const r = round3(v);
        expect(exactSummary([v])).toEqual({
          count: 1,
          p50_ms: r,
          p90_ms: r,
          p99_ms: r,
          p999_ms: r,
          max_ms: r,
          mean_ms: r,
        });
      }),
      params,
    );
  });
});
