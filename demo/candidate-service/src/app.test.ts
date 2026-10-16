import { buildApp as buildReference } from '@replay-parity/demo-reference';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { CATALOG } from './catalog.js';
import { DELAY_FRACTION, DELAY_MS, createDelayPlan, roundHalfEvenToCents } from './divergences.js';

const fixedNow = () => new Date('2026-10-16T18:00:00.000Z');
const apps: FastifyInstance[] = [];

function candidate(options: { divergences?: boolean; seed?: number } = {}): FastifyInstance {
  const instance = buildApp({ now: fixedNow, ...options });
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('divergence 1: rounding', () => {
  it('rounds half to even', () => {
    expect(roundHalfEvenToCents(4_125)).toBe(412);
    expect(roundHalfEvenToCents(4_135)).toBe(414);
    expect(roundHalfEvenToCents(9_995)).toBe(1000);
    expect(roundHalfEvenToCents(4_126)).toBe(413);
    expect(roundHalfEvenToCents(4_124)).toBe(412);
  });

  it('differs from the reference by one cent on half the ties and matches otherwise', async () => {
    const a = candidate();
    const tie = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'B-200', qty: 1 },
    });
    expect(tie.json()).toMatchObject({ total: 4.12 });
    const evenTie = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'A-100', qty: 1 },
    });
    expect(evenTie.json()).toMatchObject({ total: 10 });
    const noTie = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'B-200', qty: 2 },
    });
    expect(noTie.json()).toMatchObject({ total: 8.25 });
  });
});

describe('divergence 2: ordering', () => {
  it('lists inventory in insertion order', async () => {
    const a = candidate();
    const items = (await a.inject({ method: 'GET', url: '/v1/inventory' })).json<{
      items: { sku: string }[];
    }>().items;
    expect(items.map((i) => i.sku)).toEqual(CATALOG.map((c) => c.sku));
    expect(items.map((i) => i.sku)).not.toEqual([...CATALOG.map((c) => c.sku)].sort());
  });
});

describe('divergence 3: latency', () => {
  it('plans delays on about five percent of calls for a seed', () => {
    const plan = createDelayPlan(1);
    let delayed = 0;
    for (let i = 0; i < 20_000; i += 1) if (plan()) delayed += 1;
    expect(delayed / 20_000).toBeGreaterThan(DELAY_FRACTION * 0.8);
    expect(delayed / 20_000).toBeLessThan(DELAY_FRACTION * 1.2);
    const again = createDelayPlan(1);
    const first = Array.from({ length: 50 }, () => again());
    const repeat = createDelayPlan(1);
    expect(Array.from({ length: 50 }, () => repeat())).toEqual(first);
  });

  it('adds about 60 ms to the planned adjust calls only', async () => {
    const seed = 7;
    const plan = createDelayPlan(seed);
    let firstDelayed = 0;
    while (!plan()) firstDelayed += 1;
    const a = candidate({ seed });
    const timings: number[] = [];
    for (let i = 0; i <= firstDelayed; i += 1) {
      const start = performance.now();
      const res = await a.inject({
        method: 'POST',
        url: '/v1/inventory/H-800/adjust',
        payload: { delta: 1 },
      });
      expect(res.statusCode).toBe(200);
      timings.push(performance.now() - start);
    }
    expect(DELAY_MS).toBe(60);
    expect(timings[firstDelayed]).toBeGreaterThanOrEqual(55);
    for (const t of timings.slice(0, firstDelayed)) expect(t).toBeLessThan(40);
  });
});

describe('divergence 4: unknown order id', () => {
  it('returns 200 with an empty body', async () => {
    const a = candidate();
    const res = await a.inject({ method: 'GET', url: '/v1/orders/o-404' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await a.inject({ method: 'POST', url: '/v1/orders', payload: { sku: 'C-300', qty: 1 } });
    expect((await a.inject({ method: 'GET', url: '/v1/orders/o-1' })).json()).toMatchObject({
      order_id: 'o-1',
    });
  });
});

describe('with divergences off', () => {
  it('produces byte identical responses to the reference over a scripted scenario', async () => {
    const reference = buildReference({ now: fixedNow });
    apps.push(reference);
    const off = candidate({ divergences: false, seed: 1 });
    const script: { method: 'GET' | 'POST'; url: string; payload?: object }[] = [
      { method: 'GET', url: '/v1/inventory' },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'B-200', qty: 1 } },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'A-100', qty: 3 } },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'F-600', qty: 5 } },
      { method: 'GET', url: '/v1/orders/o-1' },
      { method: 'GET', url: '/v1/orders/o-77' },
      { method: 'POST', url: '/v1/inventory/D-400/adjust', payload: { delta: -3 } },
      { method: 'POST', url: '/v1/inventory/Q-1/adjust', payload: { delta: 1 } },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'D-400', qty: 9999 } },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'D-400', qty: 600 } },
      { method: 'GET', url: '/v1/inventory' },
      { method: 'GET', url: '/missing' },
    ];
    for (const step of script) {
      const [r, c] = await Promise.all([reference.inject(step), off.inject(step)]);
      expect(c.statusCode, step.url).toBe(r.statusCode);
      expect(c.body, step.url).toBe(r.body);
      expect(c.headers['content-type'], step.url).toBe(r.headers['content-type']);
    }
  });

  it('never delays adjust calls', async () => {
    const off = candidate({ divergences: false, seed: 7 });
    const start = performance.now();
    for (let i = 0; i < 60; i += 1) {
      await off.inject({
        method: 'POST',
        url: '/v1/inventory/H-800/adjust',
        payload: { delta: 1 },
      });
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});
