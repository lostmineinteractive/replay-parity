import type { BusHandler, MessageBus } from './bus.js';

/**
 * A bus on Redis Streams. `publish` is `XADD topic * payload <text>`.
 * `subscribe` reads with a blocking `XREAD` on a dedicated connection,
 * starting at the newest entry, so only payloads published after the
 * subscription are delivered.
 */

interface StreamEntry {
  id: string;
  message: Record<string, string | undefined>;
}

interface StreamRead {
  name: string;
  messages: StreamEntry[];
}

interface RedisLike {
  connect(): Promise<unknown>;
  duplicate(): RedisLike;
  destroy(): void;
  close(): Promise<void>;
  xAdd(key: string, id: string, message: Record<string, string>): Promise<string>;
  xRead(
    streams: { key: string; id: string },
    options: { BLOCK: number; COUNT: number },
  ): Promise<StreamRead[] | null>;
}

export interface RedisStreamsBusOptions {
  /** How long each blocking read waits before checking for shutdown. Default 1000 ms. */
  blockMs?: number | undefined;
}

export class RedisStreamsBus implements MessageBus {
  private readonly readers = new Set<RedisLike>();
  private closed = false;

  private constructor(
    private readonly client: RedisLike,
    private readonly blockMs: number,
  ) {}

  static async connect(
    url: string,
    options: RedisStreamsBusOptions = {},
  ): Promise<RedisStreamsBus> {
    const redis = await import('redis');
    const client = redis.createClient({ url }) as unknown as RedisLike;
    await client.connect();
    return new RedisStreamsBus(client, options.blockMs ?? 1000);
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
    let lastId = '$';
    const loop = (async (): Promise<void> => {
      while (!stopped) {
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
    })().catch(() => undefined);
    return async () => {
      stopped = true;
      reader.destroy();
      this.readers.delete(reader);
      await loop;
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const reader of this.readers) reader.destroy();
    this.readers.clear();
    await this.client.close();
  }
}
