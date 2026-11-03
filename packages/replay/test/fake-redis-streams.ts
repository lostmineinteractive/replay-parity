import type { RedisStreamsClient } from '../src/index.js';

/**
 * An in memory stand in for the parts of Redis Streams the bus uses with a
 * consumer group: XADD, XGROUP CREATE, XREADGROUP, XACK, and XAUTOCLAIM. It
 * exists so the group logic runs where no Redis server is available. The tests
 * against a real server are in the same files and run when REDIS_URL is set.
 */

interface Entry {
  id: string;
  payload: string;
}

interface Pending {
  consumer: string;
  deliveredAt: number;
}

interface Group {
  next: number;
  pending: Map<string, Pending>;
}

interface Stream {
  entries: Entry[];
  groups: Map<string, Group>;
}

export class FakeRedisServer {
  private readonly streams = new Map<string, Stream>();
  private readonly waiters = new Set<() => void>();
  private seq = 0;

  client(): RedisStreamsClient {
    return new FakeRedisClient(this);
  }

  stream(key: string): Stream | undefined {
    return this.streams.get(key);
  }

  ensure(key: string): Stream {
    let stream = this.streams.get(key);
    if (stream === undefined) {
      stream = { entries: [], groups: new Map() };
      this.streams.set(key, stream);
    }
    return stream;
  }

  add(key: string, payload: string): string {
    this.seq += 1;
    const id = `${this.seq}-0`;
    this.ensure(key).entries.push({ id, payload });
    for (const wake of [...this.waiters]) wake();
    return id;
  }

  /** Entries delivered to a consumer of the group and not yet acknowledged. */
  pendingCount(key: string, group: string): number {
    return this.streams.get(key)?.groups.get(group)?.pending.size ?? 0;
  }

  waitForChange(ms: number, destroyed: Promise<never>): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      destroyed.catch((e: unknown) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        reject(e as Error);
      });
    });
  }
}

class FakeRedisClient implements RedisStreamsClient {
  private rejectDestroyed: (e: Error) => void = () => undefined;
  private readonly destroyed: Promise<never>;
  private isDestroyed = false;

  constructor(private readonly server: FakeRedisServer) {
    this.destroyed = new Promise<never>((_, reject) => {
      this.rejectDestroyed = reject;
    });
    this.destroyed.catch(() => undefined);
  }

  connect(): Promise<unknown> {
    return Promise.resolve();
  }

  duplicate(): RedisStreamsClient {
    return new FakeRedisClient(this.server);
  }

  destroy(): void {
    this.isDestroyed = true;
    this.rejectDestroyed(new Error('connection destroyed'));
  }

  close(): Promise<void> {
    this.destroy();
    return Promise.resolve();
  }

  private alive(): void {
    if (this.isDestroyed) throw new Error('connection destroyed');
  }

  xAdd(key: string, _id: string, message: Record<string, string>): Promise<string> {
    this.alive();
    return Promise.resolve(this.server.add(key, message.payload ?? ''));
  }

  xRead(): Promise<never> {
    return Promise.reject(new Error('the fake supports consumer groups only'));
  }

  xGroupCreate(
    key: string,
    group: string,
    _id: string,
    options: { MKSTREAM: boolean },
  ): Promise<unknown> {
    this.alive();
    if (this.server.stream(key) === undefined && !options.MKSTREAM) {
      return Promise.reject(new Error('ERR The XGROUP subcommand requires the key to exist'));
    }
    const stream = this.server.ensure(key);
    if (stream.groups.has(group)) {
      return Promise.reject(new Error('BUSYGROUP Consumer Group name already exists'));
    }
    stream.groups.set(group, { next: stream.entries.length, pending: new Map() });
    return Promise.resolve('OK');
  }

  async xReadGroup(
    group: string,
    consumer: string,
    streams: { key: string; id: string },
    options: { BLOCK: number; COUNT: number },
  ): Promise<
    { name: string; messages: { id: string; message: Record<string, string> }[] }[] | null
  > {
    this.alive();
    const take = (): { id: string; message: Record<string, string> }[] => {
      const stream = this.server.stream(streams.key);
      const state = stream?.groups.get(group);
      if (stream === undefined || state === undefined) throw new Error('NOGROUP');
      const entries = stream.entries.slice(state.next, state.next + options.COUNT);
      state.next += entries.length;
      for (const e of entries) {
        state.pending.set(e.id, { consumer, deliveredAt: Date.now() });
      }
      return entries.map((e) => ({ id: e.id, message: { payload: e.payload } }));
    };
    let messages = take();
    if (messages.length === 0) {
      await this.server.waitForChange(options.BLOCK, this.destroyed);
      this.alive();
      messages = take();
    }
    return messages.length === 0 ? null : [{ name: streams.key, messages }];
  }

  xAck(key: string, group: string, id: string): Promise<number> {
    this.alive();
    const removed = this.server.stream(key)?.groups.get(group)?.pending.delete(id) ?? false;
    return Promise.resolve(removed ? 1 : 0);
  }

  xAutoClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    _start: string,
    options: { COUNT: number },
  ): Promise<{
    nextId: string;
    messages: ({ id: string; message: Record<string, string> } | null)[];
  }> {
    this.alive();
    const stream = this.server.stream(key);
    const state = stream?.groups.get(group);
    const messages: { id: string; message: Record<string, string> }[] = [];
    if (stream !== undefined && state !== undefined) {
      const now = Date.now();
      for (const [id, pending] of state.pending) {
        if (messages.length >= options.COUNT) break;
        if (now - pending.deliveredAt < minIdleTime) continue;
        const entry = stream.entries.find((e) => e.id === id);
        if (entry === undefined) continue;
        state.pending.set(id, { consumer, deliveredAt: now });
        messages.push({ id, message: { payload: entry.payload } });
      }
    }
    return Promise.resolve({ nextId: '0-0', messages });
  }
}
