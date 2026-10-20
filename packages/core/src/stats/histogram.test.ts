import { describe, expect, it } from 'vitest';
import {
  HISTOGRAM_BIN_COUNT,
  HISTOGRAM_EDGES_MS,
  HISTOGRAM_MAX_MS,
  HISTOGRAM_MIN_MS,
  LatencyAccumulator,
  binIndex,
  emptySummary,
  exactSummary,
} from './histogram.js';

describe('bins', () => {
  it('has one more edge than bins, from 0.1 ms to 10 s', () => {
    expect(HISTOGRAM_EDGES_MS).toHaveLength(HISTOGRAM_BIN_COUNT + 1);
    expect(HISTOGRAM_EDGES_MS[0]).toBe(HISTOGRAM_MIN_MS);
    expect(HISTOGRAM_EDGES_MS[HISTOGRAM_BIN_COUNT]).toBe(HISTOGRAM_MAX_MS);
    for (let i = 1; i < HISTOGRAM_EDGES_MS.length; i += 1) {
      expect(HISTOGRAM_EDGES_MS[i]).toBeGreaterThan(HISTOGRAM_EDGES_MS[i - 1] as number);
    }
  });

  it('places values in the expected bin', () => {
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.05)).toBe(0);
    expect(binIndex(0.1)).toBe(0);
    expect(binIndex(99_999)).toBe(HISTOGRAM_BIN_COUNT - 1);
    expect(binIndex(10_000)).toBe(HISTOGRAM_BIN_COUNT - 1);
    const ms = 12.5;
    const idx = binIndex(ms);
    expect(HISTOGRAM_EDGES_MS[idx]).toBeLessThanOrEqual(ms);
    expect(HISTOGRAM_EDGES_MS[idx + 1]).toBeGreaterThan(ms);
  });
});

describe('LatencyAccumulator', () => {
  it('returns zeros when empty', () => {
    const acc = new LatencyAccumulator();
    expect(acc.count).toBe(0);
    expect(acc.summary()).toEqual(emptySummary());
    expect(acc.binCounts().reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('summarizes a small sample by exact nearest rank percentiles', () => {
    expect(exactSummary([])).toEqual(emptySummary());
    expect(exactSummary([7])).toEqual({
      count: 1,
      p50_ms: 7,
      p90_ms: 7,
      p99_ms: 7,
      p999_ms: 7,
      max_ms: 7,
      mean_ms: 7,
    });
    const ten = [40, 1, 41, 2, 42, 3, 43, 4, 44, 5];
    expect(exactSummary(ten)).toEqual({
      count: 10,
      p50_ms: 5,
      p90_ms: 43,
      p99_ms: 44,
      p999_ms: 44,
      max_ms: 44,
      mean_ms: 22.5,
    });
  });

  it('computes percentiles of a uniform distribution within hdr precision', () => {
    const acc = new LatencyAccumulator();
    for (let v = 1; v <= 1000; v += 1) acc.record(v);
    const s = acc.summary();
    expect(s.count).toBe(1000);
    expect(s.p50_ms).toBeGreaterThanOrEqual(499);
    expect(s.p50_ms).toBeLessThanOrEqual(501);
    expect(s.p90_ms).toBeGreaterThanOrEqual(899);
    expect(s.p90_ms).toBeLessThanOrEqual(901);
    expect(s.p99_ms).toBeGreaterThanOrEqual(989);
    expect(s.p99_ms).toBeLessThanOrEqual(991);
    expect(s.p999_ms).toBeGreaterThanOrEqual(998);
    expect(s.p999_ms).toBeLessThanOrEqual(1000);
    expect(s.max_ms).toBe(1000);
    expect(s.mean_ms).toBe(500.5);
    expect(acc.binCounts().reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('reports a constant distribution exactly', () => {
    const acc = new LatencyAccumulator();
    for (let i = 0; i < 50; i += 1) acc.record(42.25);
    const s = acc.summary();
    expect(s.p50_ms).toBeCloseTo(42.25, 1);
    expect(s.p99_ms).toBeCloseTo(42.25, 1);
    expect(s.max_ms).toBe(42.25);
    expect(s.mean_ms).toBe(42.25);
  });

  it('separates a two point distribution', () => {
    const acc = new LatencyAccumulator();
    for (let i = 0; i < 95; i += 1) acc.record(1);
    for (let i = 0; i < 5; i += 1) acc.record(100);
    const s = acc.summary();
    expect(s.p50_ms).toBeCloseTo(1, 1);
    expect(s.p90_ms).toBeCloseTo(1, 1);
    expect(s.p99_ms).toBeCloseTo(100, 0);
    expect(s.max_ms).toBe(100);
  });

  it('handles sub millisecond and very large values', () => {
    const acc = new LatencyAccumulator();
    acc.record(0.0001);
    acc.record(120_000);
    const s = acc.summary();
    expect(s.max_ms).toBe(120_000);
    expect(s.count).toBe(2);
  });

  it('rejects invalid values', () => {
    const acc = new LatencyAccumulator();
    expect(() => acc.record(-1)).toThrow(RangeError);
    expect(() => acc.record(Number.NaN)).toThrow(RangeError);
    expect(() => acc.record(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
