import { stripUndefined } from '../json.js';
import { LATENCY_METRICS, metricValue, type RunStats, type TagStats } from '../stats/schema.js';
import type { LatencyLimits, RatioLimits, ThresholdResult, Thresholds } from './schema.js';

export interface ThresholdEvaluation {
  verdict: 'pass' | 'fail';
  results: ThresholdResult[];
}

function result(
  partial: Omit<ThresholdResult, 'detail'> & { detail?: string | undefined },
): ThresholdResult {
  return stripUndefined(partial);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function latencyRows(
  scope: string,
  limits: LatencyLimits,
  stats: TagStats | undefined,
  idPrefix: string,
): ThresholdResult[] {
  const rows: ThresholdResult[] = [];
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
        result({ ...base, measured: null, pass: false, detail: `no samples for tag "${scope}"` }),
      );
    } else if (stats.candidate.count === 0) {
      rows.push(result({ ...base, measured: null, pass: false, detail: 'no candidate samples' }));
    } else {
      const measured = metricValue(stats.candidate, metric);
      rows.push(result({ ...base, measured, pass: measured <= limit }));
    }
  }
  return rows;
}

function ratioRows(limits: RatioLimits, stats: TagStats): ThresholdResult[] {
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
    if (stats.candidate.count === 0 || stats.reference.count === 0) {
      rows.push(result({ ...base, measured: null, pass: false, detail: 'no samples' }));
      continue;
    }
    const ref = metricValue(stats.reference, metric);
    const cand = metricValue(stats.candidate, metric);
    if (ref === 0) {
      if (cand === 0) {
        rows.push(result({ ...base, measured: 1, pass: 1 <= limit }));
      } else {
        rows.push(
          result({ ...base, measured: null, pass: false, detail: 'reference value is zero' }),
        );
      }
      continue;
    }
    const measured = round(cand / ref);
    rows.push(result({ ...base, measured, pass: measured <= limit }));
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
      pass: false,
      detail: `no samples for tag "${scope}"`,
    });
  }
  if (stats.compared === 0) {
    return result({ ...base, measured: null, pass: false, detail: 'no compared exchanges' });
  }
  return result({ ...base, measured: stats.mismatch_rate, pass: stats.mismatch_rate <= limit });
}

/** Evaluates every threshold against the run statistics. The run passes only when every row passes. */
export function evaluateThresholds(thresholds: Thresholds, stats: RunStats): ThresholdEvaluation {
  const results: ThresholdResult[] = [];

  results.push(
    ...latencyRows('overall', thresholds.latency.overall, stats.overall, 'latency.overall'),
  );
  for (const tag of Object.keys(thresholds.latency.by_tag).sort()) {
    const limits = thresholds.latency.by_tag[tag] as LatencyLimits;
    results.push(...latencyRows(tag, limits, stats.by_tag[tag], `latency.by_tag.${tag}`));
  }
  results.push(...ratioRows(thresholds.latency.relative_to_reference, stats.overall));

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
      results.push(result({ ...base, measured: null, pass: false, detail: 'no samples' }));
    } else {
      results.push(
        result({
          ...base,
          measured: stats.overall.error_rate,
          pass: stats.overall.error_rate <= limit,
        }),
      );
    }
  }

  return { verdict: results.every((r) => r.pass) ? 'pass' : 'fail', results };
}
