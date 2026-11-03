import { stripUndefined } from '../json.js';
import { decideVerdict, type InconclusiveCondition, type RunVerdict } from '../run/verdict.js';
import { LATENCY_METRICS, metricValue, type RunStats, type TagStats } from '../stats/schema.js';
import type {
  LatencyLimits,
  RatioLimits,
  StatusLimits,
  ThresholdResult,
  Thresholds,
} from './schema.js';

export interface ThresholdEvaluation {
  verdict: RunVerdict;
  results: ThresholdResult[];
  /** One condition per inconclusive row, in row order. */
  inconclusive: InconclusiveCondition[];
}

/**
 * The statistics the thresholds read: the collector's summary, plus the noise findings of a
 * run that used the reference re-replay, as `RunFileStats` records them.
 */
export type GateStats = RunStats & {
  noise_findings?: { overall: number; by_tag: Record<string, number> } | undefined;
};

/** Measurements that come from the replay rather than from the statistics. */
export interface ThresholdMeasurements {
  /** The largest schedule slip observed, in milliseconds. */
  slip_max_ms?: number | undefined;
  /** Invariant violations per system, when the invariants ran. */
  invariant_violations?: { reference: number; candidate: number } | undefined;
  /** The achieved request rate of the replay, in requests per second. */
  achieved_rps?: number | undefined;
}

/** Rows that could not decide because a measurement was never taken, not for lack of samples. */
const notMeasured = new WeakSet<ThresholdResult>();

function unmeasured(row: ThresholdResult): ThresholdResult {
  notMeasured.add(row);
  return row;
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

function ratioRows(
  scope: string,
  limits: RatioLimits,
  stats: TagStats | undefined,
  minimum: number,
  idPrefix: string,
): ThresholdResult[] {
  const rows: ThresholdResult[] = [];
  for (const metric of LATENCY_METRICS) {
    const key = `${metric}_ratio_max` as const;
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
      continue;
    }
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
    rows.push(
      ratioOutcome(
        base,
        metricValue(stats.candidate, metric),
        metricValue(stats.reference, metric),
        'reference',
      ),
    );
  }
  return rows;
}

/** A row judged on `numerator / denominator` against its limit. */
function ratioOutcome(
  base: Omit<ThresholdResult, 'measured' | 'outcome' | 'detail'>,
  numerator: number,
  denominator: number,
  denominatorName: string,
): ThresholdResult {
  if (denominator === 0) {
    if (numerator === 0) {
      return result({ ...base, measured: 1, outcome: 1 <= base.limit ? 'pass' : 'fail' });
    }
    // A measured fact about the data, not a harness limitation.
    return result({
      ...base,
      measured: null,
      outcome: 'fail',
      detail: `${denominatorName} value is zero`,
    });
  }
  const measured = round(numerator / denominator);
  return result({ ...base, measured, outcome: measured <= base.limit ? 'pass' : 'fail' });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A mismatch rate row. The statistics count an exchange as mismatched only when it holds an
 * untolerated finding, and a noise finding is always tolerated, so noise never reaches the
 * rate. When the run used the reference re-replay, `noise` is the scope's noise finding count
 * and the detail names it.
 */
function correctnessRow(
  scope: string,
  limit: number,
  stats: TagStats | undefined,
  id: string,
  noise: number | undefined,
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
    detail: noise === undefined ? undefined : `${plural(noise, 'noise finding')} excluded`,
  });
}

/** Noise findings per compared exchange, so a reference that has become unstable is caught. */
function noiseRow(limit: number, stats: GateStats): ThresholdResult {
  const base = {
    id: 'correctness.noise_rate_max',
    section: 'correctness' as const,
    scope: 'overall',
    metric: 'noise_rate_max',
    limit,
  };
  if (stats.noise_findings === undefined) {
    return unmeasured(
      result({
        ...base,
        measured: null,
        outcome: 'inconclusive',
        detail: 'noise is measured only with a reference re-replay (--reference-target)',
      }),
    );
  }
  if (stats.overall.compared === 0) {
    return result({
      ...base,
      measured: null,
      outcome: 'inconclusive',
      detail: 'no compared exchanges',
    });
  }
  const noise = stats.noise_findings.overall;
  const measured = round(noise / stats.overall.compared);
  return result({
    ...base,
    measured,
    outcome: measured <= limit ? 'pass' : 'fail',
    detail: `${plural(noise, 'noise finding')} over ${plural(stats.overall.compared, 'compared exchange')}`,
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

function errorRow(
  scope: string,
  limit: number,
  stats: TagStats | undefined,
  id: string,
): ThresholdResult {
  const base = { id, section: 'errors' as const, scope, metric: 'rate_max', limit };
  if (stats === undefined) {
    return result({
      ...base,
      measured: null,
      outcome: 'inconclusive',
      detail: `no samples for tag "${scope}"`,
    });
  }
  if (stats.count === 0) {
    return result({ ...base, measured: null, outcome: 'inconclusive', detail: 'no samples' });
  }
  return result({
    ...base,
    measured: stats.error_rate,
    outcome: stats.error_rate <= limit ? 'pass' : 'fail',
  });
}

function statusRows(limits: StatusLimits, stats: RunStats): ThresholdResult[] {
  const rows: ThresholdResult[] = [];
  for (const tag of Object.keys(limits.by_tag).sort()) {
    const codes = limits.by_tag[tag] as Record<string, { rate_max: number }>;
    const tagStats = stats.by_tag[tag];
    for (const code of Object.keys(codes).sort()) {
      const base = {
        id: `status.by_tag.${tag}.${code}.rate_max`,
        section: 'status' as const,
        scope: tag,
        metric: `status_${code}_rate_max`,
        limit: (codes[code] as { rate_max: number }).rate_max,
      };
      if (tagStats === undefined) {
        rows.push(
          result({
            ...base,
            measured: null,
            outcome: 'inconclusive',
            detail: `no samples for tag "${tag}"`,
          }),
        );
      } else if (tagStats.compared === 0) {
        rows.push(
          result({
            ...base,
            measured: null,
            outcome: 'inconclusive',
            detail: 'no compared exchanges',
          }),
        );
      } else if (tagStats.candidate_status === undefined) {
        rows.push(
          unmeasured(
            result({
              ...base,
              measured: null,
              outcome: 'inconclusive',
              detail: 'candidate statuses were not recorded',
            }),
          ),
        );
      } else {
        const seen = tagStats.candidate_status[code] ?? 0;
        const measured = round(seen / tagStats.compared);
        rows.push(
          result({
            ...base,
            measured,
            outcome: measured <= base.limit ? 'pass' : 'fail',
            detail: `${seen} of ${tagStats.compared} compared exchanges answered ${code}`,
          }),
        );
      }
    }
  }
  return rows;
}

function throughputRow(
  limit: number,
  measured: number | undefined,
  stats: RunStats,
): ThresholdResult {
  const base = {
    id: 'throughput.achieved_rps_min',
    section: 'throughput' as const,
    scope: 'overall',
    metric: 'achieved_rps_min',
    limit,
  };
  if (measured === undefined) {
    return unmeasured(
      result({
        ...base,
        measured: null,
        outcome: 'inconclusive',
        detail: 'achieved rate was not measured',
      }),
    );
  }
  if (stats.overall.count === 0) {
    return result({ ...base, measured: null, outcome: 'inconclusive', detail: 'no samples' });
  }
  return result({ ...base, measured, outcome: measured >= limit ? 'pass' : 'fail' });
}

function conditionKind(row: ThresholdResult): InconclusiveCondition['kind'] {
  if (row.section === 'pacing') return 'schedule_not_held';
  if (notMeasured.has(row)) return 'not_measured';
  return 'insufficient_samples';
}

function conditionsFor(results: readonly ThresholdResult[]): InconclusiveCondition[] {
  const conditions: InconclusiveCondition[] = [];
  for (const row of results) {
    if (row.outcome !== 'inconclusive') continue;
    const detail = `${row.id}: ${row.detail ?? 'inconclusive'}`;
    conditions.push({ kind: conditionKind(row), detail });
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
  stats: GateStats,
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
  const relative = thresholds.latency.relative_to_reference;
  results.push(
    ...ratioRows(
      'overall',
      relative,
      stats.overall,
      overallMinimum,
      'latency.relative_to_reference',
    ),
  );
  const relativeByTag = relative.by_tag ?? {};
  for (const tag of Object.keys(relativeByTag).sort()) {
    const limits = relativeByTag[tag] as RatioLimits;
    const minimum = thresholds.latency.by_tag[tag]?.min_samples ?? defaultMinimum;
    results.push(
      ...ratioRows(
        tag,
        limits,
        stats.by_tag[tag],
        minimum,
        `latency.relative_to_reference.by_tag.${tag}`,
      ),
    );
  }
  if (thresholds.correctness.mismatch_rate_max !== undefined) {
    results.push(
      correctnessRow(
        'overall',
        thresholds.correctness.mismatch_rate_max,
        stats.overall,
        'correctness.mismatch_rate_max',
        stats.noise_findings?.overall,
      ),
    );
  }
  for (const tag of Object.keys(thresholds.correctness.by_tag).sort()) {
    const limit = (thresholds.correctness.by_tag[tag] as { mismatch_rate_max: number })
      .mismatch_rate_max;
    results.push(
      correctnessRow(
        tag,
        limit,
        stats.by_tag[tag],
        `correctness.by_tag.${tag}.mismatch_rate_max`,
        stats.noise_findings === undefined ? undefined : (stats.noise_findings.by_tag[tag] ?? 0),
      ),
    );
  }
  if (thresholds.correctness.noise_rate_max !== undefined) {
    results.push(noiseRow(thresholds.correctness.noise_rate_max, stats));
  }
  if (thresholds.errors.rate_max !== undefined) {
    results.push(errorRow('overall', thresholds.errors.rate_max, stats.overall, 'errors.rate_max'));
  }
  const errorsByTag = thresholds.errors.by_tag ?? {};
  for (const tag of Object.keys(errorsByTag).sort()) {
    const limit = (errorsByTag[tag] as { rate_max: number }).rate_max;
    results.push(errorRow(tag, limit, stats.by_tag[tag], `errors.by_tag.${tag}.rate_max`));
  }
  if (thresholds.throughput?.achieved_rps_min !== undefined) {
    results.push(
      throughputRow(thresholds.throughput.achieved_rps_min, measurements.achieved_rps, stats),
    );
  }
  if (thresholds.status !== undefined) {
    results.push(...statusRows(thresholds.status, stats));
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
