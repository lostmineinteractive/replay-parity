import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisStreamsBus, type RedisStreamsClient } from '../src/index.js';
import { FakeRedisServer } from './fake-redis-streams.js';

/**
 * The consumer group behavior of `RedisStreamsBus`. Every case runs against an
 * in memory stand in for the stream commands, and the cases that name a real
 * server also run when REDIS_URL is set.
 */

const REDIS_URL = process.env.REDIS_URL;

const buses: RedisStreamsBus[] = [];
afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
});

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await sleep(5);
  }
}

interface Harness {
  /** A bus for one consumer. */
  bus(options: {
    group?: string;
    consumer?: string;
    claimIdleMs?: number;
  }): Promise<RedisStreamsBus>;
  topic: string;
  /** Entries delivered to the group and not yet acknowledged. */
  pending(group: string): Promise<number>;
  done(): Promise<void>;
}

function fakeHarness(): Harness {
  const server = new FakeRedisServer();
  const topic = 'rp.requests.test';
  return {
    topic,
    bus: (options) => {
      const bus = RedisStreamsBus.withClient(server.client(), { blockMs: 50, ...options });
      buses.push(bus);
      return Promise.resolve(bus);
    },
    pending: (group) => Promise.resolve(server.pendingCount(topic, group)),
    done: () => Promise.resolve(),
  };
}

async function redisHarness(url: string): Promise<Harness> {
  const redis = await import('redis');
  const admin = redis.createClient({ url });
  await admin.connect();
  const topic = `rp.test.${randomBytes(6).toString('hex')}`;
  return {
    topic,
    bus: async (options) => {
      const bus = await RedisStreamsBus.connect(url, { blockMs: 50, ...options });
      buses.push(bus);
      return bus;
    },
    pending: async (group) => {
      const summary = await admin.xPending(topic, group);
      return Number(summary.pending);
    },
    done: async () => {
      await admin.del(topic);
      await admin.close();
    },
  };
}

type Backend = { name: string; make: () => Promise<Harness>; skip: boolean };

const backends: Backend[] = [
  { name: 'in memory streams', make: () => Promise.resolve(fakeHarness()), skip: false },
  {
    name: 'Redis',
    make: () => redisHarness(REDIS_URL as string),
    skip: REDIS_URL === undefined || REDIS_URL === '',
  },
];

for (const backend of backends) {
  describe.skipIf(backend.skip)(`consumer groups on ${backend.name}`, () => {
    it('splits entries between two consumers of one group', async () => {
      const h = await backend.make();
      try {
        const a = await h.bus({ group: 'g', consumer: 'a' });
        const b = await h.bus({ group: 'g', consumer: 'b' });
        const publisher = await h.bus({});
        const gotA: string[] = [];
        const gotB: string[] = [];
        await a.subscribe(h.topic, async (p) => {
          gotA.push(p);
          await sleep(2);
        });
        await b.subscribe(h.topic, async (p) => {
          gotB.push(p);
          await sleep(2);
        });
        const sent = Array.from({ length: 20 }, (_, i) => `m${i}`);
        for (const payload of sent) await publisher.publish(h.topic, payload);
        await waitFor(() => gotA.length + gotB.length === 20);
        expect(new Set(gotA).size + new Set(gotB).size).toBe(20);
        expect(gotA.filter((p) => gotB.includes(p))).toEqual([]);
        expect([...gotA, ...gotB].sort()).toEqual([...sent].sort());
        await waitFor(async () => (await h.pending('g')) === 0);
      } finally {
        await h.done();
      }
    });

    it('redelivers an unacknowledged entry to a new consumer after claimIdleMs', async () => {
      const h = await backend.make();
      try {
        const first = await h.bus({ group: 'g', consumer: 'first', claimIdleMs: 150 });
        const publisher = await h.bus({});
        let attempts = 0;
        await first.subscribe(h.topic, () => {
          attempts += 1;
          // A handler that fails leaves the entry unacknowledged.
          throw new Error('crashed');
        });
        await publisher.publish(h.topic, 'only');
        await waitFor(() => attempts >= 1);
        expect(await h.pending('g')).toBe(1);
        await first.close();

        const second = await h.bus({ group: 'g', consumer: 'second', claimIdleMs: 150 });
        const received: string[] = [];
        await second.subscribe(h.topic, (p) => {
          received.push(p);
        });
        await waitFor(() => received.length === 1);
        expect(received).toEqual(['only']);
        await waitFor(async () => (await h.pending('g')) === 0);
      } finally {
        await h.done();
      }
    });
  });
}

describe('consumer group details', () => {
  it('acknowledges an entry only after its handler resolves', async () => {
    const h = fakeHarness();
    const consumer = await h.bus({ group: 'g', consumer: 'c' });
    const publisher = await h.bus({});
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    await consumer.subscribe(h.topic, async () => {
      started = true;
      await gate;
    });
    await publisher.publish(h.topic, 'x');
    await waitFor(() => started);
    expect(await h.pending('g')).toBe(1);
    release();
    await waitFor(async () => (await h.pending('g')) === 0);
  });

  it('keeps an unacknowledged entry pending when the bus closes', async () => {
    const h = fakeHarness();
    const consumer = await h.bus({ group: 'g', consumer: 'c' });
    const publisher = await h.bus({});
    let started = false;
    await consumer.subscribe(h.topic, async () => {
      started = true;
      await new Promise<void>(() => undefined);
    });
    await publisher.publish(h.topic, 'x');
    await waitFor(() => started);
    await consumer.close();
    expect(await h.pending('g')).toBe(1);
  });

  it('does not deliver entries published before the group existed', async () => {
    const h = fakeHarness();
    const publisher = await h.bus({});
    await publisher.publish(h.topic, 'early');
    const consumer = await h.bus({ group: 'g', consumer: 'c' });
    const got: string[] = [];
    await consumer.subscribe(h.topic, (p) => {
      got.push(p);
    });
    await publisher.publish(h.topic, 'late');
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['late']);
  });

  it('stops delivering after the unsubscribe function runs', async () => {
    const h = fakeHarness();
    const consumer = await h.bus({ group: 'g', consumer: 'c' });
    const publisher = await h.bus({});
    const got: string[] = [];
    const stop = await consumer.subscribe(h.topic, (p) => {
      got.push(p);
    });
    await publisher.publish(h.topic, 'one');
    await waitFor(() => got.length === 1);
    await stop();
    await publisher.publish(h.topic, 'two');
    await sleep(150);
    expect(got).toEqual(['one']);
  });

  it('refuses a consumer name without a group', () => {
    const client = new FakeRedisServer().client() as RedisStreamsClient;
    expect(() => RedisStreamsBus.withClient(client, { consumer: 'c' })).toThrow(
      /consumer name needs a consumer group/,
    );
  });
});
