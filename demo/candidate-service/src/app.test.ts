import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from './app.js';
import { CATALOG } from './catalog.js';
import {
  ALL_DIVERGENCES,
  CLASSIC_DIVERGENCES,
  DELAY_FRACTION,
  DELAY_MS,
  DivergenceError,
  SEEDED_DEFECTS,
  createDelayPlan,
  parseDivergences,
  resolveDivergences,
  roundHalfEvenToCents,
} from './divergences.js';

const fixedNow = () => new Date('2026-10-16T18:00:00.000Z');
const T = (seconds: number): string =>
  new Date(Date.UTC(2026, 9, 16, 12, 0, seconds)).toISOString();
const apps: FastifyInstance[] = [];

function candidate(options: AppOptions = {}): FastifyInstance {
  const instance = buildApp({ now: fixedNow, ...options });
  apps.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const post = (
  a: FastifyInstance,
  url: string,
  payload?: object,
  headers?: InjectOptions['headers'],
) =>
  a.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(headers ? { headers } : {}),
  });
const get = (a: FastifyInstance, url: string) => a.inject({ method: 'GET', url });
const create = (a: FastifyInstance, sku: string, qty: number, key?: string) =>
  post(a, '/v1/orders', { sku, qty }, key ? { 'idempotency-key': key } : undefined);
const ship = (
  a: FastifyInstance,
  id: string,
  shipment_id: string,
  quantity: number,
  originated_at = T(0),
) => post(a, `/v1/orders/${id}/shipments`, { shipment_id, quantity, originated_at });
const ledger = async (a: FastifyInstance) =>
  (await get(a, '/v1/ledger')).json<{
    stock_on_hand: Record<string, string>;
    receivables: string;
  }>();

describe('divergence settings', () => {
  it('parses on, off, and named lists', () => {
    expect([...parseDivergences(undefined)]).toEqual([...CLASSIC_DIVERGENCES]);
    expect([...parseDivergences('ON')]).toEqual([...CLASSIC_DIVERGENCES]);
    expect([...parseDivergences('off')]).toEqual([]);
    expect([...parseDivergences(' shipment-applied-twice, unknown-order-200 ')]).toEqual([
      'shipment-applied-twice',
      'unknown-order-200',
    ]);
    expect(() => parseDivergences('rounding')).toThrow(DivergenceError);
    expect(() => parseDivergences('rounding')).toThrow(/known names/);
    expect([...resolveDivergences(undefined)]).toEqual([...CLASSIC_DIVERGENCES]);
    expect([...resolveDivergences('off')]).toEqual([]);
    expect([...resolveDivergences(['quantity-as-additional'])]).toEqual(['quantity-as-additional']);
    expect(ALL_DIVERGENCES).toHaveLength(8);
    expect(SEEDED_DEFECTS).toHaveLength(4);
  });
});

describe('original divergences', () => {
  it('rounds half to even on ties', async () => {
    expect(roundHalfEvenToCents(4_125)).toBe(412);
    expect(roundHalfEvenToCents(4_135)).toBe(414);
    expect(roundHalfEvenToCents(9_995)).toBe(1000);
    const a = candidate();
    expect((await create(a, 'B-200', 1)).json()).toMatchObject({ total: 4.12 });
    expect((await create(a, 'A-100', 1)).json()).toMatchObject({ total: 10 });
    expect((await create(a, 'B-200', 2)).json()).toMatchObject({ total: 8.25 });
  });

  it('lists inventory in insertion order', async () => {
    const a = candidate();
    const items = (await get(a, '/v1/inventory')).json<{ items: { sku: string }[] }>().items;
    expect(items.map((i) => i.sku)).toEqual(CATALOG.map((c) => c.sku));
  });

  it('plans delays on about five percent of adjust calls for a seed', async () => {
    const plan = createDelayPlan(1);
    let delayed = 0;
    for (let i = 0; i < 20_000; i += 1) if (plan()) delayed += 1;
    expect(delayed / 20_000).toBeGreaterThan(DELAY_FRACTION * 0.8);
    expect(delayed / 20_000).toBeLessThan(DELAY_FRACTION * 1.2);
    const seed = 7;
    const probe = createDelayPlan(seed);
    let firstDelayed = 0;
    while (!probe()) firstDelayed += 1;
    const a = candidate({ seed, divergences: ['adjust-stock-delay'] });
    const timings: number[] = [];
    for (let i = 0; i <= firstDelayed; i += 1) {
      const start = performance.now();
      expect((await post(a, '/v1/inventory/H-800/adjust', { delta: 1 })).statusCode).toBe(200);
      timings.push(performance.now() - start);
    }
    expect(DELAY_MS).toBe(60);
    expect(timings[firstDelayed]).toBeGreaterThanOrEqual(55);
    for (const t of timings.slice(0, firstDelayed)) expect(t).toBeLessThan(40);
  });

  it('returns 200 with an empty body for an unknown order', async () => {
    const a = candidate();
    const res = await get(a, '/v1/orders/o-404');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

describe('seeded defects, each alone', () => {
  it('shipment-applied-twice applies a repeated shipment id again', async () => {
    const a = candidate({ divergences: ['shipment-applied-twice'] });
    await create(a, 'H-800', 6);
    const first = await ship(a, 'o-1', 's-1', 2);
    expect((await ledger(a)).stock_on_hand['H-800']).toBe('498');
    const dup = await ship(a, 'o-1', 's-1', 2);
    expect(dup.body).toBe(first.body);
    const l = await ledger(a);
    expect(l.stock_on_hand['H-800']).toBe('496');
    expect(l.receivables).toBe('2.000');
    expect((await get(a, '/v1/orders/o-1')).json()).toMatchObject({ shipped: 4 });
  });

  it('quantity-as-additional adds instead of setting', async () => {
    const a = candidate({ divergences: ['quantity-as-additional'] });
    await create(a, 'A-100', 6);
    const res = await post(a, '/v1/orders/o-1/quantity', { quantity: 4 });
    expect(res.json()).toMatchObject({ quantity: 10, remaining: 10, total: 99.95 });
  });

  it('drop-late-precancel-shipment rejects an event that originated before the cancel', async () => {
    const a = candidate({ divergences: ['drop-late-precancel-shipment'] });
    await create(a, 'F-600', 5);
    await post(a, '/v1/orders/o-1/cancel', { originated_at: T(10) });
    const early = await ship(a, 'o-1', 's-early', 2, T(5));
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: 'order_canceled', canceled_at: T(10) });
    expect((await get(a, '/v1/orders/o-1')).json()).toMatchObject({
      shipped: 0,
      canceled_unshipped: 5,
    });
  });

  it('idempotency-lost-on-restart creates a second order after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-cand-store-'));
    const storePath = join(dir, 'store.json');
    const first = buildApp({
      now: fixedNow,
      storePath,
      divergences: ['idempotency-lost-on-restart'],
    });
    const created = await create(first, 'B-200', 3, 'k-1');
    expect((await create(first, 'B-200', 3, 'k-1')).body).toBe(created.body);
    await first.close();
    const second = candidate({ storePath, divergences: ['idempotency-lost-on-restart'] });
    expect((await create(second, 'B-200', 3, 'k-1')).json()).toMatchObject({ order_id: 'o-2' });

    const inMemory = candidate({ divergences: ['idempotency-lost-on-restart'] });
    await create(inMemory, 'B-200', 3, 'k-1');
    await post(inMemory, '/admin/restart');
    expect((await create(inMemory, 'B-200', 3, 'k-1')).json()).toMatchObject({ order_id: 'o-2' });
  });
});

describe('with divergences off', () => {
  it('produces byte identical responses to the reference over every route', async () => {
    const reference = buildReference({ now: fixedNow });
    apps.push(reference);
    const off = candidate({ divergences: 'off', seed: 1 });
    const steps: {
      method: 'GET' | 'POST';
      url: string;
      payload?: object;
      headers?: Record<string, string>;
    }[] = [
      { method: 'GET', url: '/v1/inventory' },
      { method: 'GET', url: '/v1/ledger' },
      {
        method: 'POST',
        url: '/v1/orders',
        payload: { sku: 'B-200', qty: 1 },
        headers: { 'idempotency-key': 'k-1' },
      },
      {
        method: 'POST',
        url: '/v1/orders',
        payload: { sku: 'B-200', qty: 1 },
        headers: { 'idempotency-key': 'k-1' },
      },
      {
        method: 'POST',
        url: '/v1/orders',
        payload: { sku: 'B-200', qty: 2 },
        headers: { 'idempotency-key': 'k-1' },
      },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'A-100', qty: 6 } },
      { method: 'POST', url: '/v1/orders', payload: { sku: 'J-900', qty: 600 } },
      {
        method: 'POST',
        url: '/v1/orders/o-2/shipments',
        payload: { shipment_id: 's-1', quantity: 2, originated_at: T(1) },
      },
      {
        method: 'POST',
        url: '/v1/orders/o-2/shipments',
        payload: { shipment_id: 's-1', quantity: 2, originated_at: T(1) },
      },
      { method: 'POST', url: '/v1/orders/o-2/quantity', payload: { quantity: 4 } },
      { method: 'POST', url: '/v1/orders/o-2/quantity', payload: { quantity: 1 } },
      { method: 'POST', url: '/v1/orders/o-2/cancel', payload: { originated_at: T(10) } },
      {
        method: 'POST',
        url: '/v1/orders/o-2/shipments',
        payload: { shipment_id: 's-2', quantity: 1, originated_at: T(5) },
      },
      {
        method: 'POST',
        url: '/v1/orders/o-2/shipments',
        payload: { shipment_id: 's-3', quantity: 1, originated_at: T(20) },
      },
      {
        method: 'POST',
        url: '/v1/orders/o-3/shipments',
        payload: { shipment_id: 's-4', quantity: 1, originated_at: T(0) },
      },
      { method: 'GET', url: '/v1/orders/o-1' },
      { method: 'GET', url: '/v1/orders/o-2' },
      { method: 'GET', url: '/v1/orders/o-77' },
      { method: 'POST', url: '/v1/inventory/D-400/adjust', payload: { delta: -3 } },
      { method: 'POST', url: '/v1/inventory/Q-1/adjust', payload: { delta: 1 } },
      { method: 'POST', url: '/admin/restart' },
      {
        method: 'POST',
        url: '/v1/orders',
        payload: { sku: 'B-200', qty: 1 },
        headers: { 'idempotency-key': 'k-1' },
      },
      { method: 'GET', url: '/v1/ledger' },
      { method: 'GET', url: '/v1/inventory' },
      { method: 'GET', url: '/missing' },
      { method: 'POST', url: '/admin/reset' },
      { method: 'GET', url: '/v1/ledger' },
    ];
    for (const step of steps) {
      const [r, c] = await Promise.all([reference.inject(step), off.inject(step)]);
      expect(c.statusCode, `${step.method} ${step.url}`).toBe(r.statusCode);
      expect(c.body, `${step.method} ${step.url}`).toBe(r.body);
      expect(c.headers['content-type'], step.url).toBe(r.headers['content-type']);
    }
  });

  it('never delays adjust calls', async () => {
    const off = candidate({ divergences: 'off', seed: 7 });
    const start = performance.now();
    for (let i = 0; i < 60; i += 1) await post(off, '/v1/inventory/H-800/adjust', { delta: 1 });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('shares store.ts and catalog.ts with the reference byte for byte', () => {
    const here = import.meta.dirname;
    for (const file of ['store.ts', 'catalog.ts']) {
      const mine = readFileSync(resolve(here, file), 'utf8');
      const theirs = readFileSync(resolve(here, '../../reference-service/src', file), 'utf8');
      expect(mine, file).toBe(theirs);
    }
  });
});
