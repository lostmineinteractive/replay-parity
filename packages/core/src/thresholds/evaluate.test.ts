import { describe, expect, it } from 'vitest';
import { StatsCollector } from '../stats/collector.js';
import type { RunStats } from '../stats/schema.js';
import { evaluateThresholds } from './evaluate.js';
import { emptyThresholds, parseThresholds } from './schema.js';

function statsFrom(
  samples: { tag: string; cand: number | null; ref: number; verdict?: 'match' | 'mismatch' }[],
): RunStats {
  const c = new StatsCollector();
  for (const s of samples) {
    c.record({
      tags: [s.tag],
      verdict: s.cand === null ? null : (s.verdict ?? 'match'),
      candidateLatencyMs: s.cand,
      referenceLatencyMs: s.ref,
    });
  }
  return c.finish();
}

const baseline = statsFrom([
  { tag: 'a', cand: 10, ref: 8 },
  { tag: 'a', cand: 12, ref: 8 },
  { tag: 'a', cand: 14, ref: 8, verdict: 'mismatch' },
  { tag: 'b', cand: 50, ref: 40 },
]);

describe('evaluateThresholds', () => {
  it('passes with no thresholds configured', () => {
    expect(evaluateThresholds(emptyThresholds(), baseline)).toEqual({
      verdict: 'pass',
      results: [],
    });
  });

  it('evaluates absolute latency limits overall and by tag', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p50_ms: 20, max_ms: 20 }\n  by_tag:\n    b: { p99_ms: 100 }\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('fail');
    expect(results.map((r) => [r.id, r.pass])).toEqual([
      ['latency.overall.p50_ms', true],
      ['latency.overall.max_ms', false],
      ['latency.by_tag.b.p99_ms', true],
    ]);
    expect(results[1]).toMatchObject({
      section: 'latency',
      scope: 'overall',
      metric: 'max_ms',
      limit: 20,
      measured: 50,
    });
  });

  it('fails a by_tag limit whose tag has no samples', () => {
    const t = parseThresholds(
      'latency:\n  by_tag:\n    ghost: { p99_ms: 100 }\ncorrectness:\n  by_tag:\n    ghost: { mismatch_rate_max: 0 }\n',
    );
    const { results } = evaluateThresholds(t, baseline);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.pass).toBe(false);
      expect(r.measured).toBeNull();
      expect(r.detail).toBe('no samples for tag "ghost"');
    }
  });

  it('evaluates ratios against the reference', () => {
    const t = parseThresholds(
      'latency:\n  relative_to_reference: { max_ratio_max: 1.5, p50_ratio_max: 1.2 }\n',
    );
    const { results } = evaluateThresholds(t, baseline);
    expect(results.map((r) => r.id)).toEqual([
      'latency.relative_to_reference.p50_ratio_max',
      'latency.relative_to_reference.max_ratio_max',
    ]);
    expect(results[0]?.measured).toBeCloseTo(12 / 8, 2);
    expect(results[0]?.pass).toBe(false);
    expect(results[1]?.measured).toBe(1.25);
    expect(results[1]?.pass).toBe(true);
  });

  it('handles a zero reference value in ratios', () => {
    const t = parseThresholds('latency:\n  relative_to_reference: { max_ratio_max: 2 }\n');
    const bothZero = statsFrom([{ tag: 'a', cand: 0, ref: 0 }]);
    expect(evaluateThresholds(t, bothZero).results[0]).toMatchObject({ measured: 1, pass: true });
    const candOnly = statsFrom([{ tag: 'a', cand: 5, ref: 0 }]);
    expect(evaluateThresholds(t, candOnly).results[0]).toMatchObject({
      measured: null,
      pass: false,
      detail: 'reference value is zero',
    });
  });

  it('fails latency and ratio rows when there are no samples', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p99_ms: 10 }\n  relative_to_reference: { p99_ratio_max: 2 }\nerrors:\n  rate_max: 0\n',
    );
    const empty = new StatsCollector().finish();
    const { results } = evaluateThresholds(t, empty);
    expect(results.map((r) => [r.pass, r.detail])).toEqual([
      [false, 'no candidate samples'],
      [false, 'no samples'],
      [false, 'no samples'],
    ]);
  });

  it('evaluates correctness overall and by tag', () => {
    const t = parseThresholds(
      'correctness:\n  mismatch_rate_max: 0.3\n  by_tag:\n    a: { mismatch_rate_max: 0 }\n    b: { mismatch_rate_max: 0 }\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('fail');
    expect(results.map((r) => [r.id, r.pass, r.measured])).toEqual([
      ['correctness.mismatch_rate_max', true, 0.25],
      ['correctness.by_tag.a.mismatch_rate_max', false, baseline.by_tag.a?.mismatch_rate],
      ['correctness.by_tag.b.mismatch_rate_max', true, 0],
    ]);
  });

  it('fails correctness when nothing was compared', () => {
    const t = parseThresholds('correctness:\n  mismatch_rate_max: 1\n');
    const allErrors = statsFrom([{ tag: 'a', cand: null, ref: 1 }]);
    expect(evaluateThresholds(t, allErrors).results[0]).toMatchObject({
      pass: false,
      measured: null,
      detail: 'no compared exchanges',
    });
  });

  it('evaluates the error rate', () => {
    const t = parseThresholds('errors:\n  rate_max: 0.1\n');
    expect(evaluateThresholds(t, baseline).results[0]).toMatchObject({
      id: 'errors.rate_max',
      pass: true,
      measured: 0,
    });
    const withErrors = statsFrom([
      { tag: 'a', cand: null, ref: 1 },
      { tag: 'a', cand: 1, ref: 1 },
    ]);
    expect(evaluateThresholds(t, withErrors).results[0]).toMatchObject({
      pass: false,
      measured: 0.5,
    });
  });

  it('passes only when every row passes', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p99_ms: 100 }\ncorrectness:\n  mismatch_rate_max: 0.5\nerrors:\n  rate_max: 0\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline);
    expect(results.every((r) => r.pass)).toBe(true);
    expect(verdict).toBe('pass');
  });
});
