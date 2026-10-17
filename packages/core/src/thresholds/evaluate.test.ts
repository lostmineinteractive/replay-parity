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
      inconclusive: [],
    });
  });

  it('evaluates absolute latency limits overall and by tag', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p50_ms: 20, max_ms: 20 }\n  by_tag:\n    b: { p99_ms: 100 }\n',
    );
    const { verdict, results, inconclusive } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('fail');
    expect(inconclusive).toEqual([]);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ['latency.overall.p50_ms', 'pass'],
      ['latency.overall.max_ms', 'fail'],
      ['latency.by_tag.b.p99_ms', 'pass'],
    ]);
    expect(results[1]).toMatchObject({
      section: 'latency',
      scope: 'overall',
      metric: 'max_ms',
      limit: 20,
      measured: 50,
    });
  });

  it('is inconclusive for a by_tag limit whose tag has no samples', () => {
    const t = parseThresholds(
      'latency:\n  by_tag:\n    ghost: { p99_ms: 100 }\ncorrectness:\n  by_tag:\n    ghost: { mismatch_rate_max: 0 }\n',
    );
    const { verdict, results, inconclusive } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('inconclusive');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.outcome).toBe('inconclusive');
      expect(r.measured).toBeNull();
      expect(r.detail).toBe('no samples for tag "ghost"');
    }
    expect(inconclusive).toEqual([
      {
        kind: 'insufficient_samples',
        detail: 'latency.by_tag.ghost.p99_ms: no samples for tag "ghost"',
      },
      {
        kind: 'insufficient_samples',
        detail: 'correctness.by_tag.ghost.mismatch_rate_max: no samples for tag "ghost"',
      },
    ]);
  });

  it('applies min_samples with the per block override', () => {
    const t = parseThresholds(
      'latency:\n  min_samples: 3\n  overall: { p99_ms: 100 }\n  by_tag:\n    a: { p99_ms: 100 }\n    b: { p99_ms: 100 }\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('inconclusive');
    expect(results.map((r) => [r.id, r.outcome, r.detail])).toEqual([
      ['latency.overall.p99_ms', 'pass', undefined],
      ['latency.by_tag.a.p99_ms', 'pass', undefined],
      ['latency.by_tag.b.p99_ms', 'inconclusive', '1 successful sample, minimum 3'],
    ]);

    const overridden = parseThresholds(
      'latency:\n  min_samples: 3\n  by_tag:\n    b: { p99_ms: 100, min_samples: 1 }\n',
    );
    expect(evaluateThresholds(overridden, baseline).results[0]?.outcome).toBe('pass');

    const strictOverall = parseThresholds(
      'latency:\n  overall: { p99_ms: 100, min_samples: 5 }\n  relative_to_reference: { p99_ratio_max: 9 }\n',
    );
    const rows = evaluateThresholds(strictOverall, baseline).results;
    expect(rows.map((r) => [r.outcome, r.detail])).toEqual([
      ['inconclusive', '4 successful samples, minimum 5'],
      ['inconclusive', '4 successful samples, minimum 5'],
    ]);
  });

  it('counts only successful candidate samples toward min_samples', () => {
    const t = parseThresholds('latency:\n  min_samples: 2\n  overall: { p99_ms: 100 }\n');
    const mostlyErrors = statsFrom([
      { tag: 'a', cand: null, ref: 1 },
      { tag: 'a', cand: null, ref: 1 },
      { tag: 'a', cand: 5, ref: 1 },
    ]);
    expect(evaluateThresholds(t, mostlyErrors).results[0]).toMatchObject({
      outcome: 'inconclusive',
      detail: '1 successful sample, minimum 2',
    });
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
    expect(results[0]?.outcome).toBe('fail');
    expect(results[1]?.measured).toBe(1.25);
    expect(results[1]?.outcome).toBe('pass');
  });

  it('fails, not inconclusive, on a zero reference value in ratios', () => {
    const t = parseThresholds('latency:\n  relative_to_reference: { max_ratio_max: 2 }\n');
    const bothZero = statsFrom([{ tag: 'a', cand: 0, ref: 0 }]);
    expect(evaluateThresholds(t, bothZero).results[0]).toMatchObject({
      measured: 1,
      outcome: 'pass',
    });
    const candOnly = statsFrom([{ tag: 'a', cand: 5, ref: 0 }]);
    const evaluation = evaluateThresholds(t, candOnly);
    expect(evaluation.results[0]).toMatchObject({
      measured: null,
      outcome: 'fail',
      detail: 'reference value is zero',
    });
    expect(evaluation.verdict).toBe('fail');
  });

  it('is inconclusive on every row when there are no samples', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p99_ms: 10 }\n  relative_to_reference: { p99_ratio_max: 2 }\nerrors:\n  rate_max: 0\n',
    );
    const empty = new StatsCollector().finish();
    const { verdict, results } = evaluateThresholds(t, empty);
    expect(verdict).toBe('inconclusive');
    expect(results.map((r) => [r.outcome, r.detail])).toEqual([
      ['inconclusive', '0 successful samples, minimum 1'],
      ['inconclusive', '0 successful samples, minimum 1'],
      ['inconclusive', 'no samples'],
    ]);
  });

  it('evaluates correctness overall and by tag', () => {
    const t = parseThresholds(
      'correctness:\n  mismatch_rate_max: 0.3\n  by_tag:\n    a: { mismatch_rate_max: 0 }\n    b: { mismatch_rate_max: 0 }\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline);
    expect(verdict).toBe('fail');
    expect(results.map((r) => [r.id, r.outcome, r.measured])).toEqual([
      ['correctness.mismatch_rate_max', 'pass', 0.25],
      ['correctness.by_tag.a.mismatch_rate_max', 'fail', baseline.by_tag.a?.mismatch_rate],
      ['correctness.by_tag.b.mismatch_rate_max', 'pass', 0],
    ]);
  });

  it('is inconclusive on correctness when nothing was compared', () => {
    const t = parseThresholds('correctness:\n  mismatch_rate_max: 1\n');
    const allErrors = statsFrom([{ tag: 'a', cand: null, ref: 1 }]);
    expect(evaluateThresholds(t, allErrors).results[0]).toMatchObject({
      outcome: 'inconclusive',
      measured: null,
      detail: 'no compared exchanges',
    });
  });

  it('evaluates the error rate', () => {
    const t = parseThresholds('errors:\n  rate_max: 0.1\n');
    expect(evaluateThresholds(t, baseline).results[0]).toMatchObject({
      id: 'errors.rate_max',
      outcome: 'pass',
      measured: 0,
    });
    const withErrors = statsFrom([
      { tag: 'a', cand: null, ref: 1 },
      { tag: 'a', cand: 1, ref: 1 },
    ]);
    expect(evaluateThresholds(t, withErrors).results[0]).toMatchObject({
      outcome: 'fail',
      measured: 0.5,
    });
  });

  it('checks the schedule slip against pacing.slip_max_ms', () => {
    const t = parseThresholds('pacing:\n  slip_max_ms: 250\n');
    const held = evaluateThresholds(t, baseline, { slip_max_ms: 40 });
    expect(held.verdict).toBe('pass');
    expect(held.results).toEqual([
      {
        id: 'pacing.slip_max_ms',
        section: 'pacing',
        scope: 'overall',
        metric: 'slip_max_ms',
        limit: 250,
        measured: 40,
        outcome: 'pass',
      },
    ]);

    const slipped = evaluateThresholds(t, baseline, { slip_max_ms: 312 });
    expect(slipped.verdict).toBe('inconclusive');
    expect(slipped.results[0]).toMatchObject({
      measured: 312,
      outcome: 'inconclusive',
      detail: 'schedule slip of 312 ms exceeds 250 ms',
    });
    expect(slipped.inconclusive).toEqual([
      {
        kind: 'schedule_not_held',
        detail: 'pacing.slip_max_ms: schedule slip of 312 ms exceeds 250 ms',
      },
    ]);

    const unmeasured = evaluateThresholds(t, baseline);
    expect(unmeasured.results[0]).toMatchObject({
      measured: null,
      outcome: 'inconclusive',
      detail: 'schedule slip was not measured',
    });
  });

  it('gates invariant violations per system unless demoted', () => {
    const gated = evaluateThresholds(emptyThresholds(), baseline, {
      invariant_violations: { reference: 0, candidate: 2 },
    });
    expect(gated.verdict).toBe('fail');
    expect(gated.results).toEqual([
      {
        id: 'invariants.reference.violations',
        section: 'invariants',
        scope: 'reference',
        metric: 'violations',
        limit: 0,
        measured: 0,
        outcome: 'pass',
      },
      {
        id: 'invariants.candidate.violations',
        section: 'invariants',
        scope: 'candidate',
        metric: 'violations',
        limit: 0,
        measured: 2,
        outcome: 'fail',
      },
    ]);
    const demoted = evaluateThresholds(
      parseThresholds('invariants:\n  fail_on_violation: false\n'),
      baseline,
      { invariant_violations: { reference: 1, candidate: 0 } },
    );
    expect(demoted.verdict).toBe('pass');
    expect(demoted.results[0]).toMatchObject({ outcome: 'pass', detail: 'reported, not gated' });
    expect(evaluateThresholds(emptyThresholds(), baseline).results).toEqual([]);
  });

  it('reports slip but never triggers when pacing.slip_max_ms is unset', () => {
    const t = parseThresholds('latency:\n  overall: { p99_ms: 100 }\n');
    const evaluation = evaluateThresholds(t, baseline, { slip_max_ms: 5_000 });
    expect(evaluation.verdict).toBe('pass');
    expect(evaluation.results.map((r) => r.id)).toEqual(['latency.overall.p99_ms']);
  });

  it('applies the precedence rule across rows', () => {
    // A failed row beats an insufficient sample row.
    const failAndThin = parseThresholds(
      'latency:\n  overall: { max_ms: 20 }\n  by_tag:\n    ghost: { p99_ms: 1 }\n',
    );
    expect(evaluateThresholds(failAndThin, baseline).verdict).toBe('fail');

    // A schedule that was not held beats a failed row.
    const slipAndFail = parseThresholds(
      'latency:\n  overall: { max_ms: 20 }\npacing:\n  slip_max_ms: 1\n',
    );
    expect(evaluateThresholds(slipAndFail, baseline, { slip_max_ms: 2 }).verdict).toBe(
      'inconclusive',
    );
  });

  it('passes only when every row passes', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p99_ms: 100 }\ncorrectness:\n  mismatch_rate_max: 0.5\nerrors:\n  rate_max: 0\npacing:\n  slip_max_ms: 10\n',
    );
    const { verdict, results } = evaluateThresholds(t, baseline, { slip_max_ms: 3 });
    expect(results.every((r) => r.outcome === 'pass')).toBe(true);
    expect(verdict).toBe('pass');
  });
});
