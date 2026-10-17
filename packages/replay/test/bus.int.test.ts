import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonResponse, makeExchange, makeRequest, type Exchange } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  BusAdapter,
  InProcessBus,
  RedisStreamsBus,
  replay,
  serveBus,
  type MessageBus,
} from '../src/index.js';

/** The responder a system under test would run: answers from a small table. */
async function withResponder(bus: MessageBus): Promise<() => Promise<void>> {
  return serveBus(bus, 'rp.requests.v1', (req) => {
    if (req.method === 'POST') return { status: 201, body: { created: req.body ?? null } };
    if (req.path === '/v1/items') return { status: 200, body: { items: [1, 2, 3] } };
    return { status: 404, body: { error: 'not_found' } };
  });
}

async function exerciseBus(bus: MessageBus): Promise<void> {
  const stop = await withResponder(bus);
  const adapter = await BusAdapter.create(bus, { timeoutMs: 5000 });
  const exchanges: Exchange[] = [
    makeExchange({ index: 0, response: jsonResponse({ items: [1, 2, 3] }) }),
    makeExchange({
      index: 1,
      request: makeRequest({ method: 'POST', path: '/v1/items', body: { sku: 'A' } }),
      response: jsonResponse({ created: { sku: 'A' } }, 201),
    }),
    makeExchange({
      index: 2,
      request: makeRequest({ path: '/v1/missing' }),
      response: jsonResponse({ error: 'not_found' }, 404),
    }),
    makeExchange({
      index: 3,
      request: makeRequest({ path: '/v1/items' }),
      response: jsonResponse({ items: [3, 2, 1] }),
    }),
  ];
  const dir = await mkdtemp(join(tmpdir(), 'rp-bus-'));
  const recording = join(dir, 'recording.jsonl');
  await writeFile(recording, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const run = await replay({
      recording,
      target: 'bus://test',
      adapter,
      pace: 'max',
      concurrency: 3,
    });
    expect(run.adapter).toBe('bus');
    expect(run.exchanges.map((e) => e.diff?.verdict)).toEqual([
      'match',
      'match',
      'match',
      'mismatch',
    ]);
    expect(run.exchanges.map((e) => e.candidate?.status)).toEqual([200, 201, 404, 200]);
    expect(run.stats.overall.candidate.count).toBe(4);
  } finally {
    await adapter.close();
    await stop();
  }
}

describe('bus adapter end to end', () => {
  it('replays through the in process bus with a responder', async () => {
    const bus = new InProcessBus();
    await exerciseBus(bus);
    await bus.close();
  });

  it.skipIf(!process.env.REDIS_URL)(
    'replays through Redis Streams when REDIS_URL is set',
    async () => {
      const bus = await RedisStreamsBus.connect(process.env.REDIS_URL as string, { blockMs: 200 });
      try {
        await exerciseBus(bus);
      } finally {
        await bus.close();
      }
    },
  );
});
