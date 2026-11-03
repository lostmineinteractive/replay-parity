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
    /** A positive integer, unique within the module that produced the report. */
    id: z.number().int().min(1),
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

/** The invariant module that produced a report. */
export const InvariantModuleInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string(),
    /** The SHA-256 of the module file or rules file, or null for a module built into the package. */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

export const InvariantReportSchema = z
  .object({
    system: z.string().min(1),
    recording: z.string(),
    /** Absent in reports written before invariant modules existed, which all came from the order lifecycle rules. */
    module: InvariantModuleInfoSchema.optional(),
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
export type InvariantModuleInfo = z.output<typeof InvariantModuleInfoSchema>;
