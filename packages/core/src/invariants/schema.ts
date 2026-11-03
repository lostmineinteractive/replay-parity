import { z } from 'zod';
import { isValidPath } from '../jsonpath/index.js';
import { JsonValueSchema } from '../recording/types.js';
import { patternProblem } from '../rules/pattern.js';
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

/**
 * Where a declarative invariant reads a value from one exchange.
 *
 * - `$.a.b` reads the response body and `request:$.a.b` the request body,
 *   both in the plain JSONPath subset.
 * - `header:name` reads a response header and `request-header:name` a request header.
 * - `query:name` reads a query parameter, the first one when it repeats.
 * - `path:pattern` matches the request path against a regular expression and
 *   reads the first group, or the whole match when the pattern has no group.
 */
export type InvariantSource =
  | { type: 'body'; from: 'request' | 'response'; path: string }
  | { type: 'header'; from: 'request' | 'response'; name: string }
  | { type: 'query'; name: string }
  | { type: 'path'; pattern: string };

/** Parses a source, or returns the reason it is not one. */
export function parseInvariantSource(text: string): InvariantSource | string {
  const body = (from: 'request' | 'response', path: string): InvariantSource | string =>
    isValidPath(path)
      ? { type: 'body', from, path }
      : `unsupported JSONPath ${JSON.stringify(path)} (supported: $, .name, ['name'], [n], [*], .*)`;
  if (text.startsWith('$')) return body('response', text);
  const colon = text.indexOf(':');
  const prefix = colon < 0 ? '' : text.slice(0, colon);
  const rest = colon < 0 ? '' : text.slice(colon + 1);
  switch (prefix) {
    case 'request':
      return body('request', rest);
    case 'header':
    case 'request-header':
      if (rest.length === 0) return `${prefix}: needs a header name`;
      return {
        type: 'header',
        from: prefix === 'header' ? 'response' : 'request',
        name: rest.toLowerCase(),
      };
    case 'query':
      return rest.length === 0 ? 'query: needs a parameter name' : { type: 'query', name: rest };
    case 'path': {
      if (rest.length === 0) return 'path: needs a pattern';
      const problem = patternProblem(rest);
      return problem === null ? { type: 'path', pattern: rest } : `invalid pattern: ${problem}`;
    }
    default:
      return `unsupported source ${JSON.stringify(text)} (use $..., request:$..., header:, request-header:, query:, or path:)`;
  }
}

const SourceSchema = z.string().superRefine((text, ctx) => {
  const parsed = parseInvariantSource(text);
  if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: parsed });
});

const TagSchema = z.string().min(1);
const RuleNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lower case letters, digits, and dashes')
  .optional();

export const IdempotencyInvariantSchema = z
  .object({
    name: RuleNameSchema,
    /** The request header that carries the idempotency key. */
    header: z.string().min(1),
    /** Group requests under one key by payload, so a different payload is a conflict. */
    by_payload: z.boolean().default(true),
    /** Only requests with this tag. Default: every request that carries the header. */
    tag: TagSchema.optional(),
    /** Compare accepted responses by this value instead of status and body. */
    identity: SourceSchema.optional(),
  })
  .strict();

export const MonotonicInvariantSchema = z
  .object({
    name: RuleNameSchema,
    /** The numeric value that never decreases. */
    path: SourceSchema,
    /** What groups responses, such as `$.id` or `path:^/v1/counters/([^/]+)`. */
    key: SourceSchema,
    tag: TagSchema.optional(),
  })
  .strict();

/** A field a read must show: a body path read from both sides, or an explicit pair of sources. */
export const ReadYourWritesFieldSchema = z.union([
  SourceSchema.refine((s) => s.startsWith('$'), {
    message: 'a field given as text is a body path starting with $; use { write, read } otherwise',
  }),
  z.object({ write: SourceSchema, read: SourceSchema }).strict(),
]);

export const ReadYourWritesInvariantSchema = z
  .object({
    name: RuleNameSchema,
    write_tag: TagSchema,
    read_tag: TagSchema,
    /** The value that ties a read to a write, read from both exchanges. */
    substitution: SourceSchema,
    /** A text path reads the write's request body and the read's response body. */
    fields: z.array(ReadYourWritesFieldSchema).min(1),
  })
  .strict();

export const TransitionsInvariantSchema = z
  .object({
    name: RuleNameSchema,
    path: SourceSchema,
    key: SourceSchema,
    tag: TagSchema.optional(),
    /** Each state to the states it may move to next. A state with no entry is final. */
    allowed: z.record(z.string(), z.array(z.string())),
  })
  .strict();

const ConservationSideSchema = z
  .object({ tag: TagSchema, path: SourceSchema, key: SourceSchema.optional() })
  .strict();

export const ConservationInvariantSchema = z
  .object({
    name: RuleNameSchema,
    /** The commands whose values add up, such as `{ tag: deposit, path: 'request:$.amount' }`. */
    delta_of: ConservationSideSchema,
    /** The reads whose value changes by that sum. Its `key` applies to the commands too unless they name their own. */
    equals_change_in: ConservationSideSchema,
  })
  .strict();

/** The declarative rules file, `invariants.yaml`. Every section is optional, and at least one rule is required. */
export const InvariantRulesFileSchema = z
  .object({
    /** An accepted exchange with this tag starts a new epoch, as a reset of the system. */
    reset_tag: TagSchema.optional(),
    idempotency: z
      .union([IdempotencyInvariantSchema, z.array(IdempotencyInvariantSchema)])
      .optional(),
    monotonic: z.array(MonotonicInvariantSchema).default([]),
    read_your_writes: z.array(ReadYourWritesInvariantSchema).default([]),
    transitions: z
      .union([TransitionsInvariantSchema, z.array(TransitionsInvariantSchema)])
      .optional(),
    conservation: z.array(ConservationInvariantSchema).default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    const count =
      (f.idempotency === undefined ? 0 : 1) +
      f.monotonic.length +
      f.read_your_writes.length +
      (f.transitions === undefined ? 0 : 1) +
      f.conservation.length;
    if (count === 0) ctx.addIssue({ code: 'custom', message: 'the file defines no rules' });
  });

export type IdempotencyInvariant = z.output<typeof IdempotencyInvariantSchema>;
export type MonotonicInvariant = z.output<typeof MonotonicInvariantSchema>;
export type ReadYourWritesInvariant = z.output<typeof ReadYourWritesInvariantSchema>;
export type ReadYourWritesField = z.output<typeof ReadYourWritesFieldSchema>;
export type TransitionsInvariant = z.output<typeof TransitionsInvariantSchema>;
export type ConservationInvariant = z.output<typeof ConservationInvariantSchema>;
export type InvariantRulesFile = z.output<typeof InvariantRulesFileSchema>;
