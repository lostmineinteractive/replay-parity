import { z } from 'zod';
import { DiffSchema } from '../differ/schema.js';
import { InvariantReportSchema } from '../invariants/schema.js';
import { isValidPath } from '../jsonpath/index.js';
import { RecordedRequestSchema } from '../recording/types.js';
import { DiffRulesSchema } from '../rules/schema.js';
import { LatencySummarySchema, RunStatsSchema } from '../stats/schema.js';
import { ThresholdResultSchema, ThresholdsSchema } from '../thresholds/schema.js';
import { InconclusiveConditionSchema, RunVerdictSchema } from './verdict.js';

/**
 * The run file (`run.json`). It is the canonical JSON report. The HTML and
 * terminal reports are rendered from it.
 */

export const RUN_SCHEMA_VERSION = 1;

const nonneg = z.number().nonnegative();
const count = z.number().int().nonnegative();

export const PacingModeSchema = z.enum(['as-recorded', 'fixed-rate', 'max']);

export const PacingSchema = z
  .object({
    mode: PacingModeSchema,
    rps: z.number().positive().nullable(),
    concurrency: z.number().int().positive(),
    requested_rps: z.number().positive().nullable(),
    achieved_rps: nonneg,
    slip_p50_ms: nonneg,
    slip_max_ms: nonneg,
    /** Tags whose exchanges wait for every earlier exchange to be acknowledged. */
    barrier_tags: z.array(z.string().min(1)),
    barrier_timeout_ms: z.number().positive(),
    /** How many times the engine waited at a barrier. */
    barrier_waits: count,
    /** The cap on a recorded gap under `as-recorded`. Null when disabled or when the mode has no recorded gaps. */
    max_gap_ms: z.number().positive().nullable(),
    /** How many recorded gaps were reduced to the cap. */
    gaps_capped: count,
    /**
     * Where a recorded request names its session, from `--session-key`, or null when the
     * whole recording is one session. Absent in a run written before the field existed.
     */
    session_key: z.string().min(1).nullable().optional(),
    /** How many sessions the selected exchanges formed. Absent in an older run. */
    sessions: count.optional(),
  })
  .strict();

const EndpointResultSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    latency_ms: nonneg,
  })
  .strict();

export const ExchangeResultSchema = z
  .object({
    id: z.string().min(1),
    tags: z.array(z.string()),
    method: z.string().min(1),
    path: z.string().min(1),
    warmup: z.boolean(),
    /** A harness control such as a restart. Replayed in order, shown in sequence, never scored. */
    control: z.boolean(),
    /**
     * Pulled in by `--include-dependencies` because a filtered exchange uses a value it
     * produces. Replayed and acknowledged, excluded from statistics and thresholds.
     */
    dependency: z.boolean(),
    scheduled_at_ms: nonneg,
    sent_at_ms: nonneg,
    /** When the candidate's response was fully received. `null` on error. */
    acked_at_ms: nonneg.nullable(),
    reference: EndpointResultSchema,
    candidate: EndpointResultSchema.nullable(),
    error: z.string().nullable(),
    diff: DiffSchema.nullable(),
  })
  .strict();

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an identifier');

export const GeneratedCaseStepSchema = z
  .object({
    request: RecordedRequestSchema,
    capture: z
      .object({
        name: identifier,
        path: z.string().refine(isValidPath, { message: 'unsupported JSONPath' }),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The most times one case runs on each system. */
export const MAX_CASE_REPEAT = 50;

/**
 * A case proposed by the agent. One to three steps. Later steps may reference
 * an earlier step's capture as `{{name}}` in the path, query, or body. A
 * `repeat` above 1 runs the whole case that many times on each system, so a
 * latency limit is judged on the percentiles of a sample and not on one run.
 */
export const GeneratedCaseSchema = z
  .object({
    hypothesis: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    steps: z.array(GeneratedCaseStepSchema).min(1).max(3),
    repeat: z.number().int().min(1).max(MAX_CASE_REPEAT).default(1),
  })
  .strict();

/** Exact percentiles over the runs of a case on each system. */
export const CaseLatencySchema = z
  .object({
    reference: LatencySummarySchema,
    candidate: LatencySummarySchema,
  })
  .strict();

export const KeptCaseSchema = z
  .object({
    id: z.string().min(1),
    round: z.number().int().positive(),
    hypothesis: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    steps: z.array(GeneratedCaseStepSchema).min(1).max(3),
    /** How many times the case ran on each system. */
    repeat: z.number().int().min(1).max(MAX_CASE_REPEAT),
    dedupe_key: z.string().min(1),
    /** Status and latency of the final step of the first run, or null when the side failed. */
    reference: EndpointResultSchema.nullable(),
    candidate: EndpointResultSchema.nullable(),
    /** Null when a side failed. */
    latency: CaseLatencySchema.nullable(),
    error: z.string().nullable(),
    diff: DiffSchema.nullable(),
    latency_breach: z.string().nullable(),
    revealed: z.string(),
  })
  .strict();

export const AgentStopReasonSchema = z.enum([
  'no_new_cases',
  'budget',
  'max_rounds',
  'no_valid_cases',
  'model_refusal',
  'error',
  /** Stopped by SIGINT or SIGTERM at a case boundary. */
  'aborted',
]);

export const AgentReportSchema = z
  .object({
    model: z.string().min(1),
    rounds: count,
    max_rounds: z.number().int().positive(),
    budget_usd: nonneg,
    cost_usd: nonneg,
    input_tokens: count,
    output_tokens: count,
    cache_read_tokens: count,
    cache_write_tokens: count,
    proposed: count,
    valid: count,
    executed: count,
    kept: count,
    stop_reason: AgentStopReasonSchema,
    prompt_versions: z.record(z.string(), z.string()),
    transcript_path: z.string(),
    cases_path: z.string(),
    cases: z.array(KeptCaseSchema),
  })
  .strict();

export const ReproductionStepSchema = z
  .object({
    id: z.string().min(1),
    method: z.string().min(1),
    path: z.string().min(1),
    tags: z.array(z.string()),
    body: z.json().optional(),
    /** True when a quantity in the body was lowered from the recorded value. */
    quantity_reduced: z.boolean(),
  })
  .strict();

/**
 * The result of shrinking a failing run. The steps are a subsequence of the
 * recording, in recorded order, that still trips the rule. The label says
 * "reduced reproduction" and never "minimal".
 */
export const ReproductionSchema = z
  .object({
    /** `invariant:<system>:<name>` or `mismatch:<exchange id>[:<path>]`. */
    rule: z.string().min(1),
    original_steps: count,
    reduced_steps: count,
    attempts: count,
    /** True when the steps are fewer than the original and still reproduce. */
    successful: z.boolean(),
    label: z.enum(['reduced reproduction', 'reduction unsuccessful']),
    duration_ms: nonneg,
    /** Path of the reduced recording, when one was written. */
    recording: z.string().nullable(),
    steps: z.array(ReproductionStepSchema),
  })
  .strict();

export const RunSchema = z
  .object({
    schema_version: z.literal(RUN_SCHEMA_VERSION),
    run_id: z.string().min(1),
    created_at: z.iso.datetime(),
    verdict: RunVerdictSchema,
    /** Why the run is inconclusive. Empty when it is not. */
    inconclusive: z.array(InconclusiveConditionSchema),
    recording: z
      .object({
        path: z.string(),
        exchanges: count,
        selected: count,
        first_ts: z.iso.datetime().nullable(),
        last_ts: z.iso.datetime().nullable(),
        /**
         * SHA-256 of the recording file's bytes, so a run is tied to the exact
         * file it replayed and `rp shrink` can refuse a different one. Null
         * when the engine was given exchanges in memory. Absent in a run
         * written before the field existed; both read as no hash.
         */
        recording_sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable()
          .optional(),
      })
      .strict(),
    target: z.string().min(1),
    adapter: z.string().min(1),
    pacing: PacingSchema,
    warmup: count,
    filter: z
      .object({
        tag: z.string().nullable(),
        /** Whether the producers of substituted values were selected along with the tag. */
        include_dependencies: z.boolean(),
        /** How many exchanges were pulled in as dependencies. */
        dependencies: count,
      })
      .strict(),
    limit: z.number().int().positive().nullable(),
    duration_ms: nonneg,
    rules: DiffRulesSchema,
    thresholds: ThresholdsSchema,
    threshold_results: z.array(ThresholdResultSchema),
    stats: RunStatsSchema,
    exchanges: z.array(ExchangeResultSchema),
    /** Path of the candidate's observed log written by `--candidate-recording`, or null. */
    candidate_recording: z.string().nullable(),
    /** Independent invariant results per system. Null when `--invariants` was not given. */
    invariants: z
      .object({
        reference: InvariantReportSchema.nullable(),
        candidate: InvariantReportSchema.nullable(),
      })
      .strict(),
    /** Filled by `rp shrink`. Null until then. */
    reproduction: ReproductionSchema.nullable(),
    agent: AgentReportSchema.optional(),
  })
  .strict();

export type ReproductionStep = z.output<typeof ReproductionStepSchema>;
export type Reproduction = z.output<typeof ReproductionSchema>;
export type PacingMode = z.output<typeof PacingModeSchema>;
export type Pacing = z.output<typeof PacingSchema>;
export type ExchangeResult = z.output<typeof ExchangeResultSchema>;
export type GeneratedCaseStep = z.output<typeof GeneratedCaseStepSchema>;
export type GeneratedCase = z.output<typeof GeneratedCaseSchema>;
export type CaseLatency = z.output<typeof CaseLatencySchema>;
export type KeptCase = z.output<typeof KeptCaseSchema>;
export type AgentStopReason = z.output<typeof AgentStopReasonSchema>;
export type AgentReport = z.output<typeof AgentReportSchema>;
export type Run = z.output<typeof RunSchema>;
