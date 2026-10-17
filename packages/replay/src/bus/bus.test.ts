import { makeRequest } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { BusAdapter } from './adapter.js';
import { defaultTopicFor } from './bus.js';
import { InProcessBus } from './in-process.js';
import { serveBus } from './responder.js';

const ctx = (id = 'x') => ({ id, index: 0, tags: [], signal: new AbortController().signal });

describe('defaultTopicFor', () => {
  it('derives the topic from the first path segment', () => {
    expect(defaultTopicFor(makeRequest({ path: '/v1/orders/o-1' }))).toBe('rp.requests.v1');
    expect(defaultTopicFor(makeRequest({ path: '/admin/restart' }))).toBe('rp.requests.admin');
    expect(defaultTopicFor(makeRequest({ path: '/' }))).toBe('rp.requests.root');
    expect(defaultTopicFor(makeRequest({ path: '/x' }), 'p')).toBe('p.x');
  });
});

describe('InProcessBus', () => {
  it('delivers in publish order to every subscriber and stops after unsubscribe', async () => {
    const bus = new InProcessBus();
    const a: string[] = [];
    const b: string[] = [];
    const offA = await bus.subscribe('t', (p) => {
      a.push(p);
    });
    await bus.subscribe('t', (p) => {
      b.push(p);
    });
    await bus.publish('t', '1');
    await bus.publish('t', '2');
    await bus.publish('other', '9');
    await new Promise((r) => setImmediate(r));
    expect(a).toEqual(['1', '2']);
    expect(b).toEqual(['1', '2']);
    await offA();
    await bus.publish('t', '3');
    await new Promise((r) => setImmediate(r));
    expect(a).toEqual(['1', '2']);
    expect(b).toEqual(['1', '2', '3']);
    await bus.close();
    await expect(bus.publish('t', '4')).rejects.toThrow(/closed/);
  });
});

describe('BusAdapter with serveBus', () => {
  it('round trips a request and measures latency', async () => {
    const bus = new InProcessBus();
    const seen: string[] = [];
    const stop = await serveBus(bus, 'rp.requests.v1', (req) => {
      seen.push(`${req.method} ${req.path}`);
      return { status: 201, headers: { 'content-type': 'application/json' }, body: { ok: true } };
    });
    const adapter = await BusAdapter.create(bus, { timeoutMs: 1000 });
    const res = await adapter.send(
      makeRequest({ method: 'POST', path: '/v1/orders', body: { sku: 'A' } }),
      ctx('e1'),
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual(['POST /v1/orders']);
    await adapter.close();
    await stop();
    await bus.close();
  });

  it('times out without a responder and rejects pending sends on close', async () => {
    const bus = new InProcessBus();
    const adapter = await BusAdapter.create(bus, { timeoutMs: 30 });
    await expect(adapter.send(makeRequest(), ctx())).rejects.toMatchObject({
      name: 'SendError',
      kind: 'timeout',
    });
    const slow = await BusAdapter.create(bus, { timeoutMs: 10_000 });
    const pending = slow.send(makeRequest(), ctx());
    await slow.close();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await adapter.close();
  });

  it('ignores replies it did not ask for and malformed payloads', async () => {
    const bus = new InProcessBus();
    const adapter = await BusAdapter.create(bus, { timeoutMs: 50, replyTopic: 'replies' });
    const send = adapter.send(makeRequest(), ctx());
    await bus.publish('replies', 'not json');
    await bus.publish(
      'replies',
      JSON.stringify({ correlation_id: 'other', response: { status: 200 } }),
    );
    await bus.publish('replies', JSON.stringify({ nope: 1 }));
    await expect(send).rejects.toMatchObject({ kind: 'timeout' });
    await adapter.close();
  });

  it('honors an abort signal', async () => {
    const bus = new InProcessBus();
    const adapter = await BusAdapter.create(bus, { timeoutMs: 10_000 });
    const controller = new AbortController();
    const send = adapter.send(makeRequest(), { ...ctx(), signal: controller.signal });
    controller.abort();
    await expect(send).rejects.toMatchObject({ kind: 'aborted' });
    await adapter.close();
  });
});
