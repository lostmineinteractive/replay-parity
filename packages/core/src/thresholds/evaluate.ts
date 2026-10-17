import { stripUndefined } from '../json.js';
import { decideVerdict, type InconclusiveCondition, type RunVerdict } from '../run/verdict.js';
import { LATENCY_METRICS, metricValue, type RunStats, type TagStats } from '../stats/schema.js';
import type { LatencyLimits, RatioLimits, ThresholdResult, Thresholds } from './schema.js';

export interface ThresholdEvaluation {
  verdict: RunVerdict;
  results: ThresholdResult[];
  /** One condition per inconclusive row, in row order. */
  inconclusive: InconclusiveCondition[];
}

/** Measurements that come from the replay rather than from the statistics. */
export interface ThresholdMeasurements {
  /** The largest schedule slip observed, in milliseconds. */
  slip_max_ms?: number | undefined;
  /** Invariant violations per system, when the invariants ran. */
  invariant_violations?: { reference: number; candidate: number } | undefined;
}

function result(
  partial: Omit<ThresholdResult, 'detail'> & { detail?: string | undefined },
): ThresholdResult {
  return stripUndefined(partial);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function samplesDetail(count: number, minimum: number): string {
  return `${count} successful sample${count === 1 ? '' : 's'}, minimum ${minimum}`;
}

function latencyRows(
  scope: string,
  limits: LatencyLimits,
  stats: TagStats | undefined,
  idPrefix: string,
  defaultMinSamples: number,
): ThresholdResult[] {
  const rows: ThresholdResult[] = [];
  const minimum = limits.min_samples ?? defaultMinSamples;
  for (const metric of LATENCY_METRICS) {
    const key = `${metric}_ms` as const;
    const limit = limits[key];
    if (limit === undefined) continue;
    const base = {
      id: `${idPrefix}.${key}`,
      section: 'latency' as const,
      scope,
      metric: key,
      limit,
    };
    if (stats === undefined) {
      rows.push(
        result({
          ...base,
          measured: null,
          outcome: 'inconclusive',
          detail: `no samples for tag "${scope}"`,
        }),
      );
    } else if (stats.candidate.count < minimum) {
      rows.push(
        result({
          ...base,
          measured: null,
          outcome: 'inconclusive',
          detail: samplesDetail(stats.candidate.count, minimum),
        }),
      );
    } else {
      const measured = metricValue(stats.candidate, metric);
      rows.push(result({ ...base, measured, outcome: measured <= limit ? 'pass' : 'fail' }));
    }
  }
  return rows;
}

function ratioRows(limits: RatioLimits, stats: TagStats, minimum: number): ThresholdResult[] {
  const rows: ThresholdResult[] = [];
  for (const metric of LATENCY_METRICS) {
    const key = `${metric}_ratio_max` as const;
    const limit = limits[key];
    if (limit === undefined) continue;
    const base = {
      id: `latency.relative_to_reference.${key}`,
      section: 'latency' as const,
      scope: 'overall',
      metric: key,
      limit,
    };
    if (stats.candidate.count < minimum || stats.reference.count === 0) {
      rows.push(
        result({
          ...base,
          measured: null,
          outcome: 'inconclusive',
          detail: samplesDetail(stats.candidate.count, minimum),
        }),
      );
      continue;
    }
    const ref = metricValue(stats.reference, metric);
    const cand = metricValue(stats.candidate, metric);
    if (ref === 0) {
      if (cand === 0) {
        rows.push(result({ ...base, measured: 1, outcome: 1 <= limit ? 'pass' : 'fail' }));
      } else {
        // A measured fact about the data, not a harness limitation.
        rows.push(
          result({ ...base, measured: null, outcome: 'fail', detail: 'reference value is zero' }),
        );
      }
      continue;
    }
    const measured = round(cand / ref);
    rows.push(result({ ...base, measured, outcome: measured <= limit ? 'pass' : 'fail' }));
  }
  return rows;
}

function correctnessRow(
  scope: string,
  limit: number,
  stats: TagStats | undefined,
  id: string,
): ThresholdResult {
  const base = { id, section: 'correctness' as const, scope, metric: 'mismatch_rate_max', limit };
  if (stats === undefined) {
    return result({
      ...base,
      measured: null,
      outcome: 'inconclusive',
      detail: `no samples for tag "${scope}"`,
    });
  }
  if (stats.compared === 0) {
    return result({
      ...base,
      measured: null,
      outcome: 'inconclusive',
      detail: 'no compared exchanges',
    });
  }
  return result({
    ...base,
    measured: stats.mismatch_rate,
    outcome: stats.mismatch_rate <= limit ? 'pass' : 'fail',
  });
}

function pacingRow(limit: number, measured: number | undefined): ThresholdResult {
  const base = {
    id: 'pacing.slip_max_ms',
    section: 'pacing' as const,
    scope: 'overall',
    metric: 'slip_max_ms',
    limit,
  };
  if (measured === undefined) {
    return result({
      ...base,
      measured: null,
      outcome: 'inconclusive',
      detail: 'schedule slip was not measured',
    });
  }
  if (measured <= limit) return result({ ...base, measured, outcome: 'pass' });
  return result({
    ...base,
    measured,
    outcome: 'inconclusive',
    detail: `schedule slip of ${measured} ms exceeds ${limit} ms`,
  });
}

function conditionsFor(results: readonly ThresholdResult[]): InconclusiveCondition[] {
  const conditions: InconclusiveCondition[] = [];
  for (const row of results) {
    if (row.outcome !== 'inconclusive') continue;
    const detail = `${row.id}: ${row.detail ?? 'inconclusive'}`;
    conditions.push({
      kind: row.section === 'pacing' ? 'schedule_not_held' : 'insufficient_samples',
      detail,
    });
  }
  return conditions;
}

/**
 * Evaluates every threshold against the run statistics. A row that cannot
 * decide is `inconclusive` rather than `fail`. The verdict follows the
 * precedence rule in `decideVerdict`.
 */
export function evaluateThresholds(
  thresholds: Thresholds,
  stats: RunStats,
  measurements: ThresholdMeasurements = {},
): ThresholdEvaluation {
  const results: ThresholdResult[] = [];
  const defaultMinimum = thresholds.latency.min_samples;
  const overallMinimum = thresholds.latency.overall.min_samples ?? defaultMinimum;
  results.push(
    ...latencyRows(
      'overall',
      thresholds.latency.overall,
      stats.overall,
      'latency.overall',
      defaultMinimum,
    ),
  );
  for (const tag of Object.keys(thresholds.latency.by_tag).sort()) {
    const limits = thresholds.latency.by_tag[tag] as LatencyLimits;
    results.push(
      ...latencyRows(tag, limits, stats.by_tag[tag], `latency.by_tag.${tag}`, defaultMinimum),
    );
  }
  results.push(
    ...ratioRows(thresholds.latency.relative_to_reference, stats.overall, overallMinimum),
  );
  if (thresholds.correctness.mismatch_rate_max !== undefined) {
    results.push(
      correctnessRow(
        'overall',
        thresholds.correctness.mismatch_rate_max,
        stats.overall,
        'correctness.mismatch_rate_max',
      ),
    );
  }
  for (const tag of Object.keys(thresholds.correctness.by_tag).sort()) {
    const limit = (thresholds.correctness.by_tag[tag] as { mismatch_rate_max: number })
      .mismatch_rate_max;
    results.push(
      correctnessRow(tag, limit, stats.by_tag[tag], `correctness.by_tag.${tag}.mismatch_rate_max`),
    );
  }
  if (thresholds.errors.rate_max !== undefined) {
    const limit = thresholds.errors.rate_max;
    const base = {
      id: 'errors.rate_max',
      section: 'errors' as const,
      scope: 'overall',
      metric: 'rate_max',
      limit,
    };
    if (stats.overall.count === 0) {
      results.push(
        result({ ...base, measured: null, outcome: 'inconclusive', detail: 'no samples' }),
      );
    } else {
      results.push(
        result({
          ...base,
          measured: stats.overall.error_rate,
          outcome: stats.overall.error_rate <= limit ? 'pass' : 'fail',
        }),
      );
    }
  }
  if (thresholds.pacing.slip_max_ms !== undefined) {
    results.push(pacingRow(thresholds.pacing.slip_max_ms, measurements.slip_max_ms));
  }
  if (measurements.invariant_violations !== undefined) {
    const gate = thresholds.invariants.fail_on_violation;
    for (const system of ['reference', 'candidate'] as const) {
      const violations = measurements.invariant_violations[system];
      const base = {
        id: `invariants.${system}.violations`,
        section: 'invariants' as const,
        scope: system,
        metric: 'violations',
        limit: 0,
        measured: violations,
      };
      if (violations === 0) {
        results.push(result({ ...base, outcome: 'pass' }));
      } else if (gate) {
        results.push(result({ ...base, outcome: 'fail' }));
      } else {
        results.push(result({ ...base, outcome: 'pass', detail: 'reported, not gated' }));
      }
    }
  }
  const inconclusive = conditionsFor(results);
  const verdict = decideVerdict({ threshold_results: results, inconclusive });
  return { verdict, results, inconclusive };
}
