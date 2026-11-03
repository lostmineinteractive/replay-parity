import { z } from 'zod';
import type { ThresholdResult } from '../thresholds/schema.js';

/**
 * The run verdict and the conditions that make a run inconclusive.
 *
 * `fail` means a verified difference, a breached threshold, or an invariant
 * violation. `inconclusive` means the harness could not decide. The report
 * shows the observed mismatches in every case.
 */

export const RunVerdictSchema = z.enum(['pass', 'fail', 'inconclusive']);

export const InconclusiveKindSchema = z.enum([
  /** A completion barrier timed out before every earlier exchange was acknowledged. */
  'barrier_timeout',
  /** A snapshot was read before the last acknowledged command was reflected. */
  'snapshot_before_ack',
  /** The replay could not hold its schedule within `pacing.slip_max_ms`. */
  'schedule_not_held',
  /** A harness control such as a restart failed or returned a different status. */
  'control_failed',
  /** A threshold row had fewer successful samples than its minimum. */
  'insufficient_samples',
  /** A threshold row needs a measurement the run did not take, such as the achieved rate. */
  'not_measured',
  /** The run was stopped by SIGINT or SIGTERM before every selected exchange was sent. */
  'aborted',
]);

export const InconclusiveConditionSchema = z
  .object({
    kind: InconclusiveKindSchema,
    detail: z.string().min(1),
  })
  .strict();

export type RunVerdict = z.output<typeof RunVerdictSchema>;
export type InconclusiveKind = z.output<typeof InconclusiveKindSchema>;
export type InconclusiveCondition = z.output<typeof InconclusiveConditionSchema>;

/**
 * Conditions that make the whole run inconclusive even when mismatches were
 * observed, because those mismatches may be artifacts of the harness.
 */
export const RUN_LEVEL_INCONCLUSIVE_KINDS: ReadonlySet<InconclusiveKind> =
  new Set<InconclusiveKind>([
    'barrier_timeout',
    'snapshot_before_ack',
    'schedule_not_held',
    'control_failed',
    'aborted',
  ]);

export interface VerdictInput {
  threshold_results: readonly ThresholdResult[];
  inconclusive: readonly InconclusiveCondition[];
  /** Invariant violations observed on either system. Filled by the invariants package. */
  invariant_violations?: number | undefined;
}

/**
 * The precedence rule. A run level condition makes the run inconclusive.
 * Otherwise any failed threshold or invariant violation makes it fail.
 * Otherwise any insufficient sample row makes it inconclusive. Otherwise it passes.
 */
export function decideVerdict(input: VerdictInput): RunVerdict {
  if (input.inconclusive.some((c) => RUN_LEVEL_INCONCLUSIVE_KINDS.has(c.kind))) {
    return 'inconclusive';
  }
  if (input.threshold_results.some((r) => r.outcome === 'fail')) return 'fail';
  if ((input.invariant_violations ?? 0) > 0) return 'fail';
  if (input.inconclusive.length > 0) return 'inconclusive';
  if (input.threshold_results.some((r) => r.outcome === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

/** Process exit codes. `error` is a tool error, for example a missing file. */
export const EXIT_CODES = {
  pass: 0,
  error: 1,
  fail: 2,
  inconclusive: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitCodeFor(verdict: RunVerdict): ExitCode {
  return EXIT_CODES[verdict];
}
