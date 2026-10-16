import { z } from 'zod';

const nonneg = z.number().nonnegative();

export const LatencySummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50_ms: nonneg,
    p90_ms: nonneg,
    p99_ms: nonneg,
    p999_ms: nonneg,
    max_ms: nonneg,
    mean_ms: nonneg,
  })
  .strict();

export const TagStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    error_rate: nonneg,
    compared: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    tolerated: z.number().int().nonnegative(),
    mismatches: z.number().int().nonnegative(),
    mismatch_rate: nonneg,
    candidate: LatencySummarySchema,
    reference: LatencySummarySchema,
    histogram: z
      .object({
        candidate: z.array(z.number().int().nonnegative()),
        reference: z.array(z.number().int().nonnegative()),
      })
      .strict(),
  })
  .strict();

export const RunStatsSchema = z
  .object({
    histogram_edges_ms: z.array(nonneg),
    overall: TagStatsSchema,
    by_tag: z.record(z.string(), TagStatsSchema),
  })
  .strict();

export type LatencySummary = z.output<typeof LatencySummarySchema>;
export type TagStats = z.output<typeof TagStatsSchema>;
export type RunStats = z.output<typeof RunStatsSchema>;

export const LATENCY_METRICS = ['p50', 'p90', 'p99', 'p999', 'max', 'mean'] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

export function metricValue(summary: LatencySummary, metric: LatencyMetric): number {
  return summary[`${metric}_ms`];
}
