import { describe, expect, it } from 'vitest';
import type { RunFinding } from '../run/schema.js';
import { StatsCollector } from '../stats/collector.js';
import { makeExchangeResult, makeRun } from '../testing.js';
import type { RunStats } from '../stats/schema.js';
import { evaluateThresholds } from './evaluate.js';
import { emptyThresholds, parseThresholds } from './schema.js';

function statsFrom(
  samples: {
    tag: string;
    cand: number | null;
    ref: number;
    verdict?: 'match' | 'mismatch';
    status?: number;
  }[],
): RunStats {
  const c = new StatsCollector();
  for (const s of samples) {
    c.record({
      tags: [s.tag],
      verdict: s.cand === null ? null : (s.verdict ?? 'match'),
      candidateLatencyMs: s.cand,
      referenceLatencyMs: s.ref,
      ...(s.status === undefined ? {} : { candidateStatus: s.cand === null ? null : s.status }),
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

  it('evaluates ratios to the reference per tag', () => {
    const t = parseThresholds(
      'latency:\n  by_tag:\n    a: { min_samples: 3 }\n  relative_to_reference:\n    by_tag:\n      a: { p50_ratio_max: 1.6 }\n      b: { max_ratio_max: 1.2 }\n      ghost: { p99_ratio_max: 2 }\n',
    );
    const { verdict, results, inconclusive } = evaluateThresholds(t, baseline);
    expect(results.map((r) => [r.id, r.section, r.scope, r.outcome, r.measured])).toEqual([
      ['latency.relative_to_reference.by_tag.a.p50_ratio_max', 'latency', 'a', 'pass', 1.5003],
      ['latency.relative_to_reference.by_tag.b.max_ratio_max', 'latency', 'b', 'fail', 1.25],
      [
        'latency.relative_to_reference.by_tag.ghost.p99_ratio_max',
        'latency',
        'ghost',
        'inconclusive',
        null,
      ],
    ]);
    expect(verdict).toBe('fail');
    expect(inconclusive).toEqual([
      {
        kind: 'insufficient_samples',
        detail:
          'latency.relative_to_reference.by_tag.ghost.p99_ratio_max: no samples for tag "ghost"',
      },
    ]);
    // The per tag min_samples of the latency block applies to the tag's ratio rows.
    const strict = parseThresholds(
      'latency:\n  by_tag:\n    b: { min_samples: 2 }\n  relative_to_reference:\n    by_tag:\n      b: { max_ratio_max: 2 }\n',
    );
    expect(evaluateThresholds(strict, baseline).results[0]).toMatchObject({
      outcome: 'inconclusive',
      detail: '1 successful sample, minimum 2',
    });
  });

  it('evaluates the error rate per tag', () => {
    const t = parseThresholds(
      'errors:\n  by_tag:\n    a: { rate_max: 0.4 }\n    b: { rate_max: 0.4 }\n    ghost: { rate_max: 0 }\n',
    );
    const stats = statsFrom([
      { tag: 'a', cand: null, ref: 1 },
      { tag: 'a', cand: 1, ref: 1 },
      { tag: 'b', cand: 1, ref: 1 },
    ]);
    const { results } = evaluateThresholds(t, stats);
    expect(results.map((r) => [r.id, r.section, r.scope, r.outcome, r.measured])).toEqual([
      ['errors.by_tag.a.rate_max', 'errors', 'a', 'fail', 0.5],
      ['errors.by_tag.b.rate_max', 'errors', 'b', 'pass', 0],
      ['errors.by_tag.ghost.rate_max', 'errors', 'ghost', 'inconclusive', null],
    ]);
  });

  it('gates the achieved request rate', () => {
    const t = parseThresholds('throughput:\n  achieved_rps_min: 50\n');
    const fast = evaluateThresholds(t, baseline, { achieved_rps: 80 });
    expect(fast.results).toEqual([
      {
        id: 'throughput.achieved_rps_min',
        section: 'throughput',
        scope: 'overall',
        metric: 'achieved_rps_min',
        limit: 50,
        measured: 80,
        outcome: 'pass',
      },
    ]);
    expect(evaluateThresholds(t, baseline, { achieved_rps: 49.9 }).verdict).toBe('fail');
    const unmeasured = evaluateThresholds(t, baseline);
    expect(unmeasured.results[0]).toMatchObject({
      outcome: 'inconclusive',
      detail: 'achieved rate was not measured',
    });
    expect(unmeasured.inconclusive).toEqual([
      {
        kind: 'not_measured',
        detail: 'throughput.achieved_rps_min: achieved rate was not measured',
      },
    ]);
    const empty = evaluateThresholds(t, new StatsCollector().finish(), { achieved_rps: 0 });
    expect(empty.results[0]).toMatchObject({ outcome: 'inconclusive', detail: 'no samples' });
  });

  it('gates the share of a status code per tag over compared exchanges', () => {
    const t = parseThresholds(
      "status:\n  by_tag:\n    get-order: { '404': { rate_max: 0.25 }, '500': { rate_max: 0 } }\n    ghost: { '404': { rate_max: 0 } }\n",
    );
    const stats = statsFrom([
      { tag: 'get-order', cand: 1, ref: 1, status: 200 },
      { tag: 'get-order', cand: 1, ref: 1, status: 404 },
      { tag: 'get-order', cand: 1, ref: 1, status: 200 },
      { tag: 'get-order', cand: 1, ref: 1, status: 200 },
      // An error is not a compared exchange and has no status.
      { tag: 'get-order', cand: null, ref: 1, status: 0 },
    ]);
    expect(stats.by_tag['get-order']?.candidate_status).toEqual({ '200': 3, '404': 1 });
    const { verdict, results } = evaluateThresholds(t, stats);
    expect(results).toEqual([
      {
        id: 'status.by_tag.get-order.404.rate_max',
        section: 'status',
        scope: 'get-order',
        metric: 'status_404_rate_max',
        limit: 0.25,
        measured: 0.25,
        outcome: 'pass',
        detail: '1 of 4 compared exchanges answered 404',
      },
      {
        id: 'status.by_tag.get-order.500.rate_max',
        section: 'status',
        scope: 'get-order',
        metric: 'status_500_rate_max',
        limit: 0,
        measured: 0,
        outcome: 'pass',
        detail: '0 of 4 compared exchanges answered 500',
      },
      {
        id: 'status.by_tag.ghost.404.rate_max',
        section: 'status',
        scope: 'ghost',
        metric: 'status_404_rate_max',
        limit: 0,
        measured: null,
        outcome: 'inconclusive',
        detail: 'no samples for tag "ghost"',
      },
    ]);
    expect(verdict).toBe('inconclusive');
    const strict = parseThresholds(
      "status:\n  by_tag:\n    get-order: { '404': { rate_max: 0.2 } }\n",
    );
    expect(evaluateThresholds(strict, stats).verdict).toBe('fail');
  });

  it('is inconclusive on a status row it cannot decide', () => {
    const t = parseThresholds("status:\n  by_tag:\n    a: { '404': { rate_max: 0 } }\n");
    // Statistics collected without statuses, as in a run written before they existed.
    const noStatuses = evaluateThresholds(t, baseline);
    expect(noStatuses.results[0]).toMatchObject({
      outcome: 'inconclusive',
      detail: 'candidate statuses were not recorded',
    });
    expect(noStatuses.inconclusive[0]?.kind).toBe('not_measured');
    const allErrors = statsFrom([{ tag: 'a', cand: null, ref: 1, status: 0 }]);
    expect(evaluateThresholds(t, allErrors).results[0]).toMatchObject({
      outcome: 'inconclusive',
      detail: 'no compared exchanges',
    });
  });

  it('keeps the rows of a file that uses no new key', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p99_ms: 100 }\n  relative_to_reference: { p99_ratio_max: 9 }\ncorrectness:\n  mismatch_rate_max: 0.5\nerrors:\n  rate_max: 0\npacing:\n  slip_max_ms: 10\n',
    );
    const { results } = evaluateThresholds(t, baseline, { slip_max_ms: 3, achieved_rps: 1 });
    expect(results.map((r) => r.id)).toEqual([
      'latency.overall.p99_ms',
      'latency.relative_to_reference.p99_ratio_max',
      'correctness.mismatch_rate_max',
      'errors.rate_max',
      'pacing.slip_max_ms',
    ]);
  });

  describe('noise aware gating', () => {
    const noiseFinding: RunFinding = {
      path: '$.updated_at',
      kind: 'value',
      tolerated: true,
      rule: 'noise:reference',
      noise: true,
      reference: 'a',
      candidate: 'b',
    };
    const realFinding: RunFinding = {
      path: '$.total',
      kind: 'value',
      tolerated: false,
      reference: 1,
      candidate: 2,
    };
    // Built the way the engine records noise: noise findings are tolerated and the verdict
    // is recomputed, so an exchange whose only differences are noise is tolerated.
    const run = makeRun({
      exchanges: [
        makeExchangeResult({
          id: 'noise-only',
          diff: { verdict: 'tolerated', findings: [noiseFinding] },
        }),
        makeExchangeResult({
          id: 'noise-and-real',
          diff: { verdict: 'mismatch', findings: [noiseFinding, realFinding] },
        }),
        makeExchangeResult({ id: 'clean' }),
      ],
    });
    const stats = { ...run.stats, noise_findings: { overall: 2, by_tag: { 'get-items': 2 } } };

    it('counts an exchange as mismatched only for an untolerated finding that is not noise', () => {
      expect(run.stats.overall).toMatchObject({ compared: 3, tolerated: 1, mismatches: 1 });
      const t = parseThresholds(
        'correctness:\n  mismatch_rate_max: 0.34\n  by_tag:\n    get-items: { mismatch_rate_max: 0.3 }\n',
      );
      const { results } = evaluateThresholds(t, stats);
      expect(results.map((r) => [r.id, r.outcome, r.measured, r.detail])).toEqual([
        ['correctness.mismatch_rate_max', 'pass', 0.333333, '2 noise findings excluded'],
        [
          'correctness.by_tag.get-items.mismatch_rate_max',
          'fail',
          0.333333,
          '2 noise findings excluded',
        ],
      ]);
      // A run without the re-replay keeps its rows exactly as before.
      expect(evaluateThresholds(t, run.stats).results.map((r) => r.detail)).toEqual([
        undefined,
        undefined,
      ]);
      // A tag with no noise names zero.
      const quiet = { ...run.stats, noise_findings: { overall: 0, by_tag: {} } };
      expect(evaluateThresholds(t, quiet).results[1]?.detail).toBe('0 noise findings excluded');
    });

    it('gates noise findings per compared exchange with correctness.noise_rate_max', () => {
      const t = parseThresholds('correctness:\n  noise_rate_max: 0.5\n');
      const unstable = evaluateThresholds(t, stats);
      expect(unstable.verdict).toBe('fail');
      expect(unstable.results).toEqual([
        {
          id: 'correctness.noise_rate_max',
          section: 'correctness',
          scope: 'overall',
          metric: 'noise_rate_max',
          limit: 0.5,
          measured: 0.6667,
          outcome: 'fail',
          detail: '2 noise findings over 3 compared exchanges',
        },
      ]);
      const loose = parseThresholds('correctness:\n  noise_rate_max: 1\n');
      expect(evaluateThresholds(loose, stats).verdict).toBe('pass');

      const unmeasured = evaluateThresholds(t, run.stats);
      expect(unmeasured.results[0]).toMatchObject({ outcome: 'inconclusive', measured: null });
      expect(unmeasured.inconclusive[0]?.kind).toBe('not_measured');
      const empty = {
        ...new StatsCollector().finish(),
        noise_findings: { overall: 0, by_tag: {} },
      };
      expect(evaluateThresholds(t, empty).results[0]).toMatchObject({
        outcome: 'inconclusive',
        detail: 'no compared exchanges',
      });
    });
  });
});
