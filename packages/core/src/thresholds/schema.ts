import { z } from 'zod';
import { loadYamlFile, parseYaml } from '../yaml.js';

/**
 * The thresholds file (`thresholds.yaml`).
 */

const nonneg = z.number().nonnegative();
const positive = z.number().positive();
const rate = z.number().min(0).max(1);
const minSamples = z.number().int().min(1);

export const LatencyLimitsSchema = z
  .object({
    p50_ms: nonneg.optional(),
    p90_ms: nonneg.optional(),
    p99_ms: nonneg.optional(),
    p999_ms: nonneg.optional(),
    max_ms: nonneg.optional(),
    mean_ms: nonneg.optional(),
    /** Overrides `latency.min_samples` for this block. */
    min_samples: minSamples.optional(),
  })
  .strict();

export const RatioLimitsSchema = z
  .object({
    p50_ratio_max: positive.optional(),
    p90_ratio_max: positive.optional(),
    p99_ratio_max: positive.optional(),
    p999_ratio_max: positive.optional(),
    max_ratio_max: positive.optional(),
    mean_ratio_max: positive.optional(),
  })
  .strict();

/** Ratio limits overall, plus the same limits per tag. */
export const RelativeLimitsSchema = RatioLimitsSchema.extend({
  /** Candidate over reference per tag. Absent when no tag is limited. */
  by_tag: z.record(z.string(), RatioLimitsSchema).optional(),
}).strict();

/** An HTTP status code as a three digit key, such as `'404'`. */
const statusCode = z.string().regex(/^[1-5][0-9][0-9]$/, 'must be a status code from 100 to 599');

export const StatusLimitsSchema = z
  .object({
    /** Per tag, per candidate status code, the largest share of compared exchanges with that status. */
    by_tag: z
      .record(z.string(), z.record(statusCode, z.object({ rate_max: rate }).strict()))
      .prefault({}),
  })
  .strict();

export const ThroughputLimitsSchema = z
  .object({
    /** The least achieved request rate, in requests per second. */
    achieved_rps_min: nonneg.optional(),
  })
  .strict();

/**
 * Limits against an earlier run given with `rp replay --baseline`. Latency limits are ratios
 * of this run's candidate percentiles over the baseline's. Rate limits are the largest growth
 * of a rate over the baseline's, as a fraction.
 */
export const BaselineLimitsSchema = z
  .object({
    latency: z
      .object({
        overall: RatioLimitsSchema.optional(),
        by_tag: z.record(z.string(), RatioLimitsSchema).optional(),
      })
      .strict()
      .optional(),
    correctness: z
      .object({
        mismatch_rate_delta_max: rate.optional(),
        by_tag: z
          .record(z.string(), z.object({ mismatch_rate_delta_max: rate }).strict())
          .optional(),
      })
      .strict()
      .optional(),
    errors: z
      .object({
        rate_delta_max: rate.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ThresholdsSchema = z
  .object({
    latency: z
      .object({
        /** Successful candidate samples a latency row needs before it can decide. */
        min_samples: minSamples.prefault(1),
        overall: LatencyLimitsSchema.prefault({}),
        by_tag: z.record(z.string(), LatencyLimitsSchema).prefault({}),
        relative_to_reference: RelativeLimitsSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    correctness: z
      .object({
        mismatch_rate_max: rate.optional(),
        /**
         * The most findings the reference re-replay marked as noise per compared exchange.
         * Above 1 is possible, since one exchange can hold several noise findings.
         */
        noise_rate_max: nonneg.optional(),
        by_tag: z.record(z.string(), z.object({ mismatch_rate_max: rate }).strict()).prefault({}),
      })
      .strict()
      .prefault({}),
    errors: z
      .object({
        rate_max: rate.optional(),
        /** Per tag error rate limits. Absent when no tag is limited. */
        by_tag: z.record(z.string(), z.object({ rate_max: rate }).strict()).optional(),
      })
      .strict()
      .prefault({}),
    /** Absent unless a throughput limit is set, so an older thresholds file parses as before. */
    throughput: ThroughputLimitsSchema.optional(),
    /** Absent unless a status limit is set. */
    status: StatusLimitsSchema.optional(),
    /** Limits against an earlier run. Evaluated only when the replay is given a baseline. */
    baseline: BaselineLimitsSchema.optional(),
    pacing: z
      .object({
        /** The largest schedule slip the replay may show before the run is inconclusive. */
        slip_max_ms: nonneg.optional(),
      })
      .strict()
      .prefault({}),
    invariants: z
      .object({
        /** When true, an invariant violation on either system fails the run. Default true. */
        fail_on_violation: z.boolean().prefault(true),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * The outcome of one threshold row. `inconclusive` means the row could not
 * decide, for example because the tag had fewer samples than its minimum.
 */
export const ThresholdOutcomeSchema = z.enum(['pass', 'fail', 'inconclusive']);

export const ThresholdResultSchema = z
  .object({
    id: z.string().min(1),
    section: z.enum([
      'latency',
      'correctness',
      'errors',
      'throughput',
      'status',
      'baseline',
      'pacing',
      'invariants',
    ]),
    scope: z.string().min(1),
    metric: z.string().min(1),
    limit: z.number(),
    measured: z.number().nullable(),
    outcome: ThresholdOutcomeSchema,
    detail: z.string().optional(),
  })
  .strict();

export type LatencyLimits = z.output<typeof LatencyLimitsSchema>;
export type RatioLimits = z.output<typeof RatioLimitsSchema>;
export type RelativeLimits = z.output<typeof RelativeLimitsSchema>;
export type StatusLimits = z.output<typeof StatusLimitsSchema>;
export type ThroughputLimits = z.output<typeof ThroughputLimitsSchema>;
export type BaselineLimits = z.output<typeof BaselineLimitsSchema>;
export type Thresholds = z.output<typeof ThresholdsSchema>;
export type ThresholdsInput = z.input<typeof ThresholdsSchema>;
export type ThresholdOutcome = z.output<typeof ThresholdOutcomeSchema>;
export type ThresholdResult = z.output<typeof ThresholdResultSchema>;

export function emptyThresholds(): Thresholds {
  return ThresholdsSchema.parse({});
}

export function parseThresholds(text: string, source = 'thresholds'): Thresholds {
  return parseYaml(text, ThresholdsSchema, source);
}

export function loadThresholds(path: string): Promise<Thresholds> {
  return loadYamlFile(path, ThresholdsSchema);
}
