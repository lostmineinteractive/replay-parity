import { z } from 'zod';
import { DiffSchema } from '../differ/schema.js';
import { InvariantReportSchema } from '../invariants/schema.js';
import { isValidPath } from '../jsonpath/index.js';
import { RecordedRequestSchema } from '../recording/types.js';
import { DiffRulesSchema } from '../rules/schema.js';
import { RunStatsSchema } from '../stats/schema.js';
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

/**
 * A case proposed by the agent. One to three steps. Later steps may reference
 * an earlier step's capture as `{{name}}` in the path, query, or body.
 */
export const GeneratedCaseSchema = z
  .object({
    hypothesis: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    steps: z.array(GeneratedCaseStepSchema).min(1).max(3),
  })
  .strict();

export const KeptCaseSchema = z
  .object({
    id: z.string().min(1),
    round: z.number().int().positive(),
    hypothesis: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    steps: z.array(GeneratedCaseStepSchema).min(1).max(3),
    dedupe_key: z.string().min(1),
    reference: EndpointResultSchema.nullable(),
    candidate: EndpointResultSchema.nullable(),
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
      })
      .strict(),
    target: z.string().min(1),
    adapter: z.string().min(1),
    pacing: PacingSchema,
    warmup: count,
    filter: z.object({ tag: z.string().nullable() }).strict(),
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
    agent: AgentReportSchema.optional(),
  })
  .strict();

export type PacingMode = z.output<typeof PacingModeSchema>;
export type Pacing = z.output<typeof PacingSchema>;
export type ExchangeResult = z.output<typeof ExchangeResultSchema>;
export type GeneratedCaseStep = z.output<typeof GeneratedCaseStepSchema>;
export type GeneratedCase = z.output<typeof GeneratedCaseSchema>;
export type KeptCase = z.output<typeof KeptCaseSchema>;
export type AgentStopReason = z.output<typeof AgentStopReasonSchema>;
export type AgentReport = z.output<typeof AgentReportSchema>;
export type Run = z.output<typeof RunSchema>;
