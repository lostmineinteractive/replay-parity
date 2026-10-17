import { z } from 'zod';
import { JsonValueSchema } from '../recording/types.js';
import { InconclusiveConditionSchema } from '../run/verdict.js';

/**
 * Results of the independent invariants. One report per system, computed
 * from that system's own recording and nothing else.
 */

export const InvariantStatusSchema = z.enum([
  'holds',
  'violated',
  'not_applicable',
  'inconclusive',
]);

export const InvariantEvidenceSchema = z
  .object({
    /** What the finding is about, for example `order o-12` or `sku A-100 between ledger reads 3 and 4`. */
    subject: z.string().min(1),
    expected: JsonValueSchema,
    observed: JsonValueSchema,
    detail: z.string(),
    /** The exchange that witnessed the finding, when there is one. */
    exchange_id: z.string().nullable(),
  })
  .strict();

export const InvariantResultSchema = z
  .object({
    id: z.number().int().min(1).max(10),
    name: z.string().min(1),
    statement: z.string().min(1),
    status: InvariantStatusSchema,
    /** Instances examined: orders, shipments, intervals, or commands. */
    checks: z.number().int().nonnegative(),
    /** Violations found, capped so a bad run stays readable. */
    evidence: z.array(InvariantEvidenceSchema),
    detail: z.string().optional(),
  })
  .strict();

export const InvariantReportSchema = z
  .object({
    system: z.string().min(1),
    recording: z.string(),
    exchanges: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    snapshots: z
      .object({
        ledger_reads: z.number().int().nonnegative(),
        stock_reads: z.number().int().nonnegative(),
        order_reads: z.number().int().nonnegative(),
      })
      .strict(),
    results: z.array(InvariantResultSchema),
    violations: z.number().int().nonnegative(),
    inconclusive: z.array(InconclusiveConditionSchema),
  })
  .strict();

export type InvariantStatus = z.output<typeof InvariantStatusSchema>;
export type InvariantEvidence = z.output<typeof InvariantEvidenceSchema>;
export type InvariantResult = z.output<typeof InvariantResultSchema>;
export type InvariantReport = z.output<typeof InvariantReportSchema>;
