import {
  RecordedRequestSchema,
  type HeaderMap,
  type JsonValue,
  type RecordedRequest,
} from '@replay-parity/core';
import type { MessageBus, ReplyEnvelope, RequestEnvelope } from './bus.js';

/**
 * The responder side of the bus contract, for tests and as a reference for
 * systems under test. It reads request envelopes from one topic, calls the
 * handler, and publishes the reply envelope to the envelope's `reply_to`.
 */
export interface ResponderResponse {
  status: number;
  headers?: HeaderMap | undefined;
  body?: JsonValue | undefined;
  encoding?: 'base64' | undefined;
}

export type BusResponder = (
  request: RecordedRequest,
) => ResponderResponse | Promise<ResponderResponse>;

export async function serveBus(
  bus: MessageBus,
  topic: string,
  responder: BusResponder,
): Promise<() => Promise<void>> {
  return bus.subscribe(topic, async (payload) => {
    let envelope: RequestEnvelope;
    try {
      const raw = JSON.parse(payload) as Partial<RequestEnvelope>;
      if (typeof raw.correlation_id !== 'string' || typeof raw.reply_to !== 'string') return;
      envelope = {
        correlation_id: raw.correlation_id,
        reply_to: raw.reply_to,
        request: RecordedRequestSchema.parse(raw.request),
      };
    } catch {
      return;
    }
    const response = await responder(envelope.request);
    const reply: ReplyEnvelope = {
      correlation_id: envelope.correlation_id,
      response: {
        status: response.status,
        headers: response.headers ?? {},
        ...(response.body === undefined ? {} : { body: response.body }),
        ...(response.encoding === undefined ? {} : { encoding: response.encoding }),
      },
    };
    await bus.publish(envelope.reply_to, JSON.stringify(reply));
  });
}
