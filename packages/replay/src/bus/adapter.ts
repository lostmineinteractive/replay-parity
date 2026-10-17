import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { stripUndefined, type RecordedRequest, type RecordedResponse } from '@replay-parity/core';
import { SendError, toSendError, type Adapter, type ReplayContext } from '../adapter.js';
import {
  ReplyEnvelopeSchema,
  defaultTopicFor,
  type MessageBus,
  type ReplyEnvelope,
  type RequestEnvelope,
} from './bus.js';

export interface BusAdapterOptions {
  /** Topic for a request. Default `rp.requests.<first path segment>`. */
  topicFor?: ((req: RecordedRequest) => string) | undefined;
  /** Topic this adapter listens on for replies. Default `rp.replies.<random>`. */
  replyTopic?: string | undefined;
  /** How long to wait for a reply. Default 30000 ms. */
  timeoutMs?: number | undefined;
}

interface Waiter {
  resolve: (reply: ReplyEnvelope) => void;
  reject: (err: Error) => void;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Sends recorded requests as envelopes over a `MessageBus` and matches
 * replies by correlation id. Latency is the time from publish to reply.
 */
export class BusAdapter implements Adapter {
  readonly name = 'bus';
  readonly replyTopic: string;
  private readonly waiting = new Map<string, Waiter>();
  private readonly topicFor: (req: RecordedRequest) => string;
  private readonly timeoutMs: number;
  private unsubscribe: (() => Promise<void>) | null = null;
  private seq = 0;

  private constructor(
    private readonly bus: MessageBus,
    options: BusAdapterOptions,
  ) {
    this.topicFor = options.topicFor ?? defaultTopicFor;
    this.replyTopic = options.replyTopic ?? `rp.replies.${randomBytes(6).toString('hex')}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  static async create(bus: MessageBus, options: BusAdapterOptions = {}): Promise<BusAdapter> {
    const adapter = new BusAdapter(bus, options);
    adapter.unsubscribe = await bus.subscribe(adapter.replyTopic, (payload) => {
      adapter.onReply(payload);
    });
    return adapter;
  }

  private onReply(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const result = ReplyEnvelopeSchema.safeParse(parsed);
    if (!result.success) return;
    const waiter = this.waiting.get(result.data.correlation_id);
    if (!waiter) return;
    this.waiting.delete(result.data.correlation_id);
    waiter.resolve(result.data);
  }

  async send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse> {
    this.seq += 1;
    const correlationId = `${ctx.id}:${this.seq}`;
    const envelope: RequestEnvelope = {
      correlation_id: correlationId,
      reply_to: this.replyTopic,
      request: req,
    };
    const started = performance.now();
    const reply = new Promise<ReplyEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(correlationId);
        reject(new SendError('timeout', `no reply within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      const onAbort = (): void => {
        this.waiting.delete(correlationId);
        clearTimeout(timer);
        reject(new SendError('aborted', 'send aborted'));
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(correlationId, {
        resolve: (value) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
    });
    try {
      await this.bus.publish(this.topicFor(req), JSON.stringify(envelope));
      const { response } = await reply;
      return stripUndefined({
        status: response.status,
        headers: response.headers,
        latency_ms: round3(performance.now() - started),
        body: response.body,
        encoding: response.encoding,
      });
    } catch (err) {
      this.waiting.delete(correlationId);
      throw toSendError(err);
    }
  }

  async close(): Promise<void> {
    for (const [id, waiter] of this.waiting) {
      this.waiting.delete(id);
      waiter.reject(new SendError('aborted', 'adapter closed'));
    }
    if (this.unsubscribe) {
      const unsubscribe = this.unsubscribe;
      this.unsubscribe = null;
      await unsubscribe();
    }
  }
}
