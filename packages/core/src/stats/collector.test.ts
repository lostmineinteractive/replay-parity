import { describe, expect, it } from 'vitest';
import { StatsCollector } from './collector.js';
import { HISTOGRAM_EDGES_MS } from './histogram.js';

describe('StatsCollector', () => {
  it('aggregates overall and per tag, counting errors separately', () => {
    const c = new StatsCollector();
    c.record({ tags: ['a'], verdict: 'match', candidateLatencyMs: 10, referenceLatencyMs: 5 });
    c.record({ tags: ['a'], verdict: 'mismatch', candidateLatencyMs: 20, referenceLatencyMs: 5 });
    c.record({ tags: ['b'], verdict: 'tolerated', candidateLatencyMs: 30, referenceLatencyMs: 5 });
    c.record({ tags: ['b'], verdict: null, candidateLatencyMs: null, referenceLatencyMs: 7 });
    const stats = c.finish();

    expect(stats.histogram_edges_ms).toEqual([...HISTOGRAM_EDGES_MS]);
    expect(stats.overall).toMatchObject({
      count: 4,
      errors: 1,
      error_rate: 0.25,
      compared: 3,
      matches: 1,
      tolerated: 1,
      mismatches: 1,
    });
    expect(stats.overall.mismatch_rate).toBeCloseTo(1 / 3, 6);
    expect(stats.overall.candidate.count).toBe(3);
    expect(stats.overall.reference.count).toBe(4);
    expect(stats.overall.candidate.max_ms).toBe(30);
    expect(stats.overall.histogram.candidate.reduce((x, y) => x + y, 0)).toBe(3);
    expect(stats.overall.histogram.reference.reduce((x, y) => x + y, 0)).toBe(4);

    expect(Object.keys(stats.by_tag)).toEqual(['a', 'b']);
    expect(stats.by_tag.a).toMatchObject({
      count: 2,
      errors: 0,
      compared: 2,
      mismatches: 1,
      mismatch_rate: 0.5,
    });
    expect(stats.by_tag.b).toMatchObject({
      count: 2,
      errors: 1,
      error_rate: 0.5,
      compared: 1,
      tolerated: 1,
      mismatch_rate: 0,
    });
  });

  it('counts a multi tag exchange once overall and once per tag, and untagged only overall', () => {
    const c = new StatsCollector();
    c.record({
      tags: ['x', 'y', 'x'],
      verdict: 'match',
      candidateLatencyMs: 1,
      referenceLatencyMs: 1,
    });
    c.record({ tags: [], verdict: 'match', candidateLatencyMs: 1, referenceLatencyMs: 1 });
    const stats = c.finish();
    expect(stats.overall.count).toBe(2);
    expect(stats.by_tag.x?.count).toBe(1);
    expect(stats.by_tag.y?.count).toBe(1);
  });

  it('reports zero rates with no samples', () => {
    const stats = new StatsCollector().finish();
    expect(stats.overall).toMatchObject({ count: 0, error_rate: 0, mismatch_rate: 0, compared: 0 });
    expect(stats.by_tag).toEqual({});
  });
});
