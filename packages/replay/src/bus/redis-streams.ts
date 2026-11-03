import { randomBytes } from 'node:crypto';
import { ConfigError } from '@replay-parity/core';
import type { BusHandler, MessageBus } from './bus.js';

/**
 * A bus on Redis Streams. `publish` is `XADD topic * payload <text>`.
 *
 * Without a consumer group, `subscribe` reads with a blocking `XREAD` on a
 * dedicated connection, starting at the newest entry, so only payloads
 * published after the subscription are delivered, to every subscriber.
 *
 * With a consumer group, `subscribe` creates the group on the topic at the
 * newest entry (`XGROUP CREATE ... $ MKSTREAM`, an existing group is kept),
 * reads with `XREADGROUP` from `>`, and acknowledges each entry with `XACK`
 * after the handler resolves. Consumers in one group split the entries between
 * them. An entry whose handler rejects, or whose consumer went away, stays
 * pending and is claimed by whichever consumer next finds it idle for
 * `claimIdleMs`, through `XAUTOCLAIM`.
 */

interface StreamEntry {
  id: string;
  message: Record<string, string | undefined>;
}

interface StreamRead {
  name: string;
  messages: StreamEntry[];
}

interface AutoClaimReply {
  nextId: string;
  messages: (StreamEntry | null)[];
}

/** The commands the bus uses. The `redis` client satisfies it. */
export interface RedisStreamsClient {
  connect(): Promise<unknown>;
  duplicate(): RedisStreamsClient;
  destroy(): void;
  close(): Promise<void>;
  xAdd(key: string, id: string, message: Record<string, string>): Promise<string>;
  xRead(
    streams: { key: string; id: string },
    options: { BLOCK: number; COUNT: number },
  ): Promise<StreamRead[] | null>;
  xGroupCreate(
    key: string,
    group: string,
    id: string,
    options: { MKSTREAM: boolean },
  ): Promise<unknown>;
  xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string },
    options: { BLOCK: number; COUNT: number },
  ): Promise<StreamRead[] | null>;
  xAck(key: string, group: string, id: string): Promise<number>;
  xAutoClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    start: string,
    options: { COUNT: number },
  ): Promise<AutoClaimReply>;
}

export const DEFAULT_CLAIM_IDLE_MS = 30_000;

export interface RedisStreamsBusOptions {
  /** How long each blocking read waits before checking for shutdown. Default 1000 ms. */
  blockMs?: number | undefined;
  /** Consumer group to read through. Without it every subscriber sees every entry. */
  group?: string | undefined;
  /** This consumer's name in the group. Default `rp-` and a random suffix. */
  consumer?: string | undefined;
  /** How long an entry may stay unacknowledged before another consumer claims it. Default 30000 ms. */
  claimIdleMs?: number | undefined;
}

const CLAIM_BATCH = 100;

function requireGroupForConsumer(options: RedisStreamsBusOptions): void {
  if (options.consumer !== undefined && options.group === undefined) {
    throw new ConfigError('a consumer name needs a consumer group');
  }
}

export class RedisStreamsBus implements MessageBus {
  private readonly readers = new Set<RedisStreamsClient>();
  private closed = false;

  private constructor(
    private readonly client: RedisStreamsClient,
    private readonly blockMs: number,
    private readonly group: string | undefined,
    private readonly consumer: string,
    private readonly claimIdleMs: number,
  ) {}

  static async connect(
    url: string,
    options: RedisStreamsBusOptions = {},
  ): Promise<RedisStreamsBus> {
    requireGroupForConsumer(options);
    const redis = await import('redis');
    const client = redis.createClient({ url }) as unknown as RedisStreamsClient;
    await client.connect();
    return RedisStreamsBus.withClient(client, options);
  }

  /** A bus over a client that is already connected. The bus closes the client when it closes. */
  static withClient(
    client: RedisStreamsClient,
    options: RedisStreamsBusOptions = {},
  ): RedisStreamsBus {
    requireGroupForConsumer(options);
    return new RedisStreamsBus(
      client,
      options.blockMs ?? 1000,
      options.group,
      options.consumer ?? `rp-${randomBytes(4).toString('hex')}`,
      options.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS,
    );
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (this.closed) throw new Error('bus is closed');
    await this.client.xAdd(topic, '*', { payload });
  }

  async subscribe(topic: string, handler: BusHandler): Promise<() => Promise<void>> {
    const reader = this.client.duplicate();
    await reader.connect();
    this.readers.add(reader);
    let stopped = false;
    const run =
      this.group === undefined
        ? this.readPlain(reader, topic, handler, () => stopped)
        : this.readGroup(reader, this.group, topic, handler, () => stopped);
    const loop = run.catch(() => undefined);
    return async () => {
      stopped = true;
      reader.destroy();
      this.readers.delete(reader);
      await loop;
    };
  }

  private async readPlain(
    reader: RedisStreamsClient,
    topic: string,
    handler: BusHandler,
    isStopped: () => boolean,
  ): Promise<void> {
    let lastId = '$';
    while (!isStopped()) {
      const reply = await reader.xRead(
        { key: topic, id: lastId },
        { BLOCK: this.blockMs, COUNT: 100 },
      );
      if (reply === null) continue;
      for (const stream of reply) {
        for (const entry of stream.messages) {
          lastId = entry.id;
          const payload = entry.message.payload;
          if (payload !== undefined) await handler(payload);
        }
      }
    }
  }

  /** Hands one entry to the handler and acknowledges it when the handler resolves. */
  private async deliver(
    reader: RedisStreamsClient,
    group: string,
    topic: string,
    entry: StreamEntry,
    handler: BusHandler,
  ): Promise<void> {
    const payload = entry.message.payload;
    if (payload !== undefined) {
      try {
        await handler(payload);
      } catch {
        // The entry stays pending and another delivery follows once it has been idle long enough.
        return;
      }
    }
    await reader.xAck(topic, group, entry.id);
  }

  private async readGroup(
    reader: RedisStreamsClient,
    group: string,
    topic: string,
    handler: BusHandler,
    isStopped: () => boolean,
  ): Promise<void> {
    try {
      await reader.xGroupCreate(topic, group, '$', { MKSTREAM: true });
    } catch (e) {
      if (!String((e as Error).message).includes('BUSYGROUP')) throw e;
    }
    const claimEveryMs = Math.max(1, Math.min(this.claimIdleMs, this.blockMs));
    let lastClaim = 0;
    while (!isStopped()) {
      if (Date.now() - lastClaim >= claimEveryMs) {
        lastClaim = Date.now();
        let cursor = '0-0';
        do {
          const claimed = await reader.xAutoClaim(
            topic,
            group,
            this.consumer,
            this.claimIdleMs,
            cursor,
            { COUNT: CLAIM_BATCH },
          );
          for (const entry of claimed.messages) {
            if (entry !== null) await this.deliver(reader, group, topic, entry, handler);
          }
          cursor = claimed.nextId;
        } while (cursor !== '0-0' && !isStopped());
      }
      const reply = await reader.xReadGroup(
        group,
        this.consumer,
        { key: topic, id: '>' },
        { BLOCK: Math.min(this.blockMs, claimEveryMs), COUNT: 100 },
      );
      if (reply === null) continue;
      for (const stream of reply) {
        for (const entry of stream.messages) {
          await this.deliver(reader, group, topic, entry, handler);
        }
      }
    }
  }

  /** Closes the bus. A second call does nothing, so a caller may close defensively. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers) reader.destroy();
    this.readers.clear();
    await this.client.close();
  }
}
