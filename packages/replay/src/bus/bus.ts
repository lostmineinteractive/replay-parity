import { z } from 'zod';
import { HeadersSchema, JsonValueSchema, type RecordedRequest } from '@replay-parity/core';

/**
 * A small message bus abstraction. Payloads are strings. The bus adapter
 * publishes a request envelope to a topic derived from the request path and
 * awaits the reply envelope on its own reply topic.
 */
export type BusHandler = (payload: string) => void | Promise<void>;

export interface MessageBus {
  publish(topic: string, payload: string): Promise<void>;
  /** Delivers every payload published to `topic` after this call. Returns the unsubscribe function. */
  subscribe(topic: string, handler: BusHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface RequestEnvelope {
  correlation_id: string;
  reply_to: string;
  request: RecordedRequest;
}

export const ReplyEnvelopeSchema = z
  .object({
    correlation_id: z.string().min(1),
    response: z
      .object({
        status: z.number().int().min(100).max(599),
        headers: HeadersSchema.default({}),
        body: JsonValueSchema.optional(),
        encoding: z.literal('base64').optional(),
      })
      .strict(),
  })
  .strict();

export type ReplyEnvelope = z.output<typeof ReplyEnvelopeSchema>;

export const DEFAULT_TOPIC_PREFIX = 'rp.requests';

/** `rp.requests.<first path segment>`, or `rp.requests.root` for `/`. */
export function defaultTopicFor(req: RecordedRequest, prefix = DEFAULT_TOPIC_PREFIX): string {
  const first = req.path.split('/').find((s) => s.length > 0) ?? 'root';
  return `${prefix}.${first}`;
}
