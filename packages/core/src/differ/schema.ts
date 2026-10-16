import { z } from 'zod';
import { JsonValueSchema } from '../recording/types.js';

export const FindingKindSchema = z.enum([
  'status',
  'header',
  'value',
  'type',
  'missing',
  'unexpected',
  'body_too_large',
  'body_format',
]);

export const FindingSchema = z
  .object({
    path: z.string().min(1),
    kind: FindingKindSchema,
    tolerated: z.boolean(),
    reference: JsonValueSchema.optional(),
    candidate: JsonValueSchema.optional(),
    rule: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const VerdictSchema = z.enum(['match', 'tolerated', 'mismatch']);

export const DiffSchema = z
  .object({
    verdict: VerdictSchema,
    findings: z.array(FindingSchema),
  })
  .strict();

export type FindingKind = z.output<typeof FindingKindSchema>;
export type Finding = z.output<typeof FindingSchema>;
export type Verdict = z.output<typeof VerdictSchema>;
export type Diff = z.output<typeof DiffSchema>;
