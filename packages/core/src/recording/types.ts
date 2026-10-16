import { z } from 'zod';

/**
 * The recording format. One `Exchange` per JSON Lines row.
 */

export const JsonValueSchema = z.json();

export const QuerySchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export const HeadersSchema = z.record(z.string(), z.string());

const bodyFields = {
  body: JsonValueSchema.optional(),
  encoding: z.literal('base64').optional(),
  truncated: z.literal(true).optional(),
  body_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  body_size: z.number().int().nonnegative().optional(),
};

interface BodyLike {
  body?: unknown;
  encoding?: 'base64' | undefined;
  truncated?: true | undefined;
  body_sha256?: string | undefined;
  body_size?: number | undefined;
}

function refineBody(value: BodyLike, ctx: z.RefinementCtx): void {
  if (value.truncated) {
    if (value.body !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'a truncated body must not carry content',
      });
    }
    if (value.body_sha256 === undefined || value.body_size === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['truncated'],
        message: 'a truncated body requires body_sha256 and body_size',
      });
    }
    return;
  }
  if (value.encoding === 'base64' && typeof value.body !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'a base64 body must be a string' });
  }
  if (value.body === undefined && value.encoding !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['encoding'], message: 'encoding given without a body' });
  }
}

export const RecordedRequestSchema = z
  .object({
    method: z.string().min(1),
    path: z.string().startsWith('/'),
    query: QuerySchema.default({}),
    headers: HeadersSchema.default({}),
    ...bodyFields,
  })
  .strict()
  .superRefine(refineBody);

export const RecordedResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: HeadersSchema.default({}),
    latency_ms: z.number().nonnegative(),
    ...bodyFields,
  })
  .strict()
  .superRefine(refineBody);

export const ExchangeSchema = z
  .object({
    id: z.string().min(1),
    ts: z.iso.datetime(),
    offset_ms: z.number().nonnegative(),
    adapter: z.string().min(1),
    request: RecordedRequestSchema,
    response: RecordedResponseSchema,
    tags: z.array(z.string()).default([]),
  })
  .strict();

export type Query = z.output<typeof QuerySchema>;
export type RecordedRequest = z.output<typeof RecordedRequestSchema>;
export type RecordedResponse = z.output<typeof RecordedResponseSchema>;
export type Exchange = z.output<typeof ExchangeSchema>;
export type ExchangeInput = z.input<typeof ExchangeSchema>;
