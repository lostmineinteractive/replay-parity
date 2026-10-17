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

export const ThresholdsSchema = z
  .object({
    latency: z
      .object({
        /** Successful candidate samples a latency row needs before it can decide. */
        min_samples: minSamples.prefault(1),
        overall: LatencyLimitsSchema.prefault({}),
        by_tag: z.record(z.string(), LatencyLimitsSchema).prefault({}),
        relative_to_reference: RatioLimitsSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    correctness: z
      .object({
        mismatch_rate_max: rate.optional(),
        by_tag: z.record(z.string(), z.object({ mismatch_rate_max: rate }).strict()).prefault({}),
      })
      .strict()
      .prefault({}),
    errors: z
      .object({
        rate_max: rate.optional(),
      })
      .strict()
      .prefault({}),
    pacing: z
      .object({
        /** The largest schedule slip the replay may show before the run is inconclusive. */
        slip_max_ms: nonneg.optional(),
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
    section: z.enum(['latency', 'correctness', 'errors', 'pacing']),
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
