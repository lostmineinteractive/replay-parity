import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from './app.js';
import { CATALOG, roundHalfUpToCents } from './catalog.js';

const fixedNow = () => new Date('2026-10-16T18:00:00.000Z');
const T = (seconds: number): string =>
  new Date(Date.UTC(2026, 9, 16, 12, 0, seconds)).toISOString();

const apps: FastifyInstance[] = [];
function app(options: AppOptions = {}): FastifyInstance {
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

describe('rounding', () => {
  it('rounds half up to cents', () => {
    expect(roundHalfUpToCents(9_995)).toBe(1000);
    expect(roundHalfUpToCents(4_125)).toBe(413);
    expect(roundHalfUpToCents(4_124)).toBe(412);
    expect(roundHalfUpToCents(8_250)).toBe(825);
  });
});

describe('POST /v1/orders', () => {
  it('creates an OPEN order with quantities and a half up total', async () => {
    const a = app();
    const res = await create(a, 'B-200', 1);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      order_id: 'o-1',
      status: 'OPEN',
      items: [{ sku: 'B-200', qty: 1, unit_price: 4.125 }],
      total: 4.13,
      quantity: 1,
      shipped: 0,
      remaining: 1,
      canceled_unshipped: 0,
      created_at: '2026-10-16T18:00:00.000Z',
      canceled_at: null,
    });
    expect((await create(a, 'A-100', 3)).json()).toMatchObject({ order_id: 'o-2', total: 29.99 });
  });

  it('allocates against available stock without changing stock on hand', async () => {
    const a = app();
    expect((await create(a, 'A-100', 600)).json()).toMatchObject({
      status: 'REJECTED',
      remaining: 0,
    });
    expect((await create(a, 'A-100', 500)).json()).toMatchObject({ status: 'OPEN' });
    expect((await create(a, 'A-100', 1)).json()).toMatchObject({ status: 'REJECTED' });
    const inventory = (await get(a, '/v1/inventory')).json<{
      items: { sku: string; on_hand: number }[];
    }>();
    expect(inventory.items.find((i) => i.sku === 'A-100')?.on_hand).toBe(500);
    expect((await ledger(a)).stock_on_hand['A-100']).toBe('500');
  });

  it('rejects bad input and unknown skus', async () => {
    const a = app();
    expect((await post(a, '/v1/orders', [])).statusCode).toBe(400);
    expect((await post(a, '/v1/orders', { sku: 'A-100' })).statusCode).toBe(400);
    expect((await create(a, 'A-100', 0)).statusCode).toBe(400);
    expect((await create(a, 'A-100', 1001)).statusCode).toBe(400);
    expect((await post(a, '/v1/orders', { sku: 7, qty: 1 })).statusCode).toBe(400);
    const unknown = await create(a, 'Z-1', 1);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown_sku', sku: 'Z-1' });
    const invalidJson = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('honors Idempotency-Key', async () => {
    const a = app();
    const first = await create(a, 'C-300', 2, 'k-1');
    const again = await create(a, 'C-300', 2, 'k-1');
    expect(again.statusCode).toBe(201);
    expect(again.body).toBe(first.body);
    expect((await create(a, 'C-300', 2)).json()).toMatchObject({ order_id: 'o-2' });
    const conflict = await create(a, 'C-300', 3, 'k-1');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'idempotency_conflict', idempotency_key: 'k-1' });
    expect((await create(a, 'C-300', 0, 'k-2')).statusCode).toBe(400);
    expect((await create(a, 'C-300', 1, 'k-2')).statusCode).toBe(201);
    expect((await create(a, 'C-300', 1, 'k-2')).json()).toMatchObject({ order_id: 'o-3' });
  });
});

describe('GET /v1/orders/:id', () => {
  it('returns the order or 404', async () => {
    const a = app();
    const created = await create(a, 'C-300', 2);
    const fetched = await get(a, '/v1/orders/o-1');
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(created.json());
    const missing = await get(a, '/v1/orders/o-999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /v1/inventory and GET /v1/ledger', () => {
  it('lists items ordered by SKU', async () => {
    const a = app();
    const items = (await get(a, '/v1/inventory')).json<{ items: { sku: string }[] }>().items;
    expect(items).toHaveLength(CATALOG.length);
    expect(items.map((i) => i.sku)).toEqual([...CATALOG.map((c) => c.sku)].sort());
    expect(items[0]).toEqual({
      sku: 'A-100',
      name: 'Hex bolt M8',
      on_hand: 500,
      unit_price: 9.995,
    });
  });

  it('reports stock and receivables as decimal strings', async () => {
    const a = app();
    const initial = await ledger(a);
    expect(Object.keys(initial.stock_on_hand)).toEqual([...CATALOG.map((c) => c.sku)].sort());
    expect(initial.stock_on_hand['A-100']).toBe('500');
    expect(initial.receivables).toBe('0.000');
    await create(a, 'B-200', 5);
    await ship(a, 'o-1', 's-1', 2);
    await post(a, '/v1/inventory/D-400/adjust', { delta: 5 });
    const after = await ledger(a);
    expect(after.stock_on_hand['B-200']).toBe('498');
    expect(after.stock_on_hand['D-400']).toBe('505');
    expect(after.receivables).toBe('8.250');
  });
});

describe('POST /v1/orders/:id/cancel', () => {
  it('cancels a live order and records the acceptance time from the request', async () => {
    const a = app();
    await create(a, 'A-100', 6);
    await ship(a, 'o-1', 's-1', 2);
    const res = await post(a, '/v1/orders/o-1/cancel', { originated_at: T(10) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'CANCELED',
      shipped: 2,
      remaining: 0,
      canceled_unshipped: 4,
      canceled_at: T(10),
    });
    const again = await post(a, '/v1/orders/o-1/cancel', { originated_at: T(20) });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(res.json());
  });

  it('releases allocation and refuses invalid states', async () => {
    const a = app();
    await create(a, 'A-100', 500);
    expect((await create(a, 'A-100', 1)).json()).toMatchObject({ status: 'REJECTED' });
    await post(a, '/v1/orders/o-1/cancel', { originated_at: T(0) });
    expect((await create(a, 'A-100', 500)).json()).toMatchObject({
      order_id: 'o-3',
      status: 'OPEN',
    });
    expect((await post(a, '/v1/orders/o-2/cancel', { originated_at: T(0) })).statusCode).toBe(409);
    await ship(a, 'o-3', 's-1', 500);
    const shipped = await post(a, '/v1/orders/o-3/cancel', { originated_at: T(0) });
    expect(shipped.statusCode).toBe(409);
    expect(shipped.json()).toEqual({ error: 'invalid_state', status: 'SHIPPED' });
    expect((await post(a, '/v1/orders/o-3/cancel', {})).statusCode).toBe(400);
    expect((await post(a, '/v1/orders/o-3/cancel', { originated_at: 'soon' })).statusCode).toBe(
      400,
    );
    expect((await post(a, '/v1/orders/o-99/cancel', { originated_at: T(0) })).statusCode).toBe(404);
  });
});

describe('POST /v1/orders/:id/quantity', () => {
  it('sets the quantity and recomputes the total and status', async () => {
    const a = app();
    await create(a, 'A-100', 6);
    await ship(a, 'o-1', 's-1', 2);
    const down = await post(a, '/v1/orders/o-1/quantity', { quantity: 4 });
    expect(down.statusCode).toBe(200);
    expect(down.json()).toMatchObject({
      quantity: 4,
      shipped: 2,
      remaining: 2,
      total: 39.98,
      status: 'PARTIALLY_SHIPPED',
    });
    expect(down.json<{ items: { qty: number }[] }>().items[0]?.qty).toBe(4);
    const toShipped = await post(a, '/v1/orders/o-1/quantity', { quantity: 2 });
    expect(toShipped.json()).toMatchObject({ status: 'SHIPPED', remaining: 0 });
    expect((await post(a, '/v1/orders/o-1/quantity', { quantity: 5 })).statusCode).toBe(409);
  });

  it('refuses going below shipped, beyond available stock, bad input, and dead orders', async () => {
    const a = app();
    await create(a, 'B-200', 6);
    await ship(a, 'o-1', 's-1', 3);
    const below = await post(a, '/v1/orders/o-1/quantity', { quantity: 2 });
    expect(below.statusCode).toBe(409);
    expect(below.json()).toEqual({ error: 'below_shipped', shipped: 3, requested: 2 });
    const tooMany = await post(a, '/v1/orders/o-1/quantity', { quantity: 600 });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toMatchObject({ error: 'insufficient_stock', sku: 'B-200' });
    expect((await post(a, '/v1/orders/o-1/quantity', { quantity: 0 })).statusCode).toBe(400);
    expect((await post(a, '/v1/orders/o-1/quantity', {})).statusCode).toBe(400);
    expect((await post(a, '/v1/orders/o-9/quantity', { quantity: 1 })).statusCode).toBe(404);
    await post(a, '/v1/orders/o-1/cancel', { originated_at: T(0) });
    expect((await post(a, '/v1/orders/o-1/quantity', { quantity: 4 })).statusCode).toBe(409);
  });
});

describe('POST /v1/orders/:id/shipments', () => {
  it('applies shipment events and moves the status', async () => {
    const a = app();
    await create(a, 'H-800', 5);
    const first = await ship(a, 'o-1', 's-1', 2, T(1));
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({
      shipment_id: 's-1',
      order_id: 'o-1',
      quantity: 2,
      originated_at: T(1),
      status: 'PARTIALLY_SHIPPED',
      shipped: 2,
      remaining: 3,
    });
    const second = await ship(a, 'o-1', 's-2', 3, T(2));
    expect(second.json()).toMatchObject({ status: 'SHIPPED', shipped: 5, remaining: 0 });
    const l = await ledger(a);
    expect(l.stock_on_hand['H-800']).toBe('495');
    expect(l.receivables).toBe('2.500');
  });

  it('is idempotent per shipment id and refuses over shipment', async () => {
    const a = app();
    await create(a, 'H-800', 4);
    const first = await ship(a, 'o-1', 's-1', 2);
    const dup = await ship(a, 'o-1', 's-1', 2);
    expect(dup.statusCode).toBe(201);
    expect(dup.body).toBe(first.body);
    expect((await ledger(a)).stock_on_hand['H-800']).toBe('498');
    expect((await get(a, '/v1/orders/o-1')).json()).toMatchObject({ shipped: 2 });
    const over = await ship(a, 'o-1', 's-2', 3);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toEqual({ error: 'exceeds_remaining', remaining: 2, requested: 3 });
    expect((await ship(a, 'o-1', 's-2', 2)).statusCode).toBe(201);
  });

  it('follows cancellation semantics by originated_at', async () => {
    const a = app();
    await create(a, 'F-600', 5);
    await post(a, '/v1/orders/o-1/cancel', { originated_at: T(10) });
    const late = await ship(a, 'o-1', 's-late', 1, T(20));
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: 'order_canceled', canceled_at: T(10) });
    const early = await ship(a, 'o-1', 's-early', 2, T(5));
    expect(early.statusCode).toBe(201);
    expect(early.json()).toMatchObject({ status: 'CANCELED', shipped: 2, remaining: 0 });
    expect((await get(a, '/v1/orders/o-1')).json()).toMatchObject({
      canceled_unshipped: 3,
      shipped: 2,
    });
  });

  it('refuses rejected orders, missing stock, bad input, and unknown orders', async () => {
    const a = app();
    await create(a, 'J-900', 600);
    const rejected = await ship(a, 'o-1', 's-1', 1);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: 'invalid_state', status: 'REJECTED' });
    await create(a, 'J-900', 5);
    await post(a, '/v1/inventory/J-900/adjust', { delta: -497 });
    const noStock = await ship(a, 'o-2', 's-2', 5);
    expect(noStock.statusCode).toBe(409);
    expect(noStock.json()).toMatchObject({ error: 'insufficient_stock', on_hand: 3 });
    expect(
      (await post(a, '/v1/orders/o-2/shipments', { quantity: 1, originated_at: T(0) })).statusCode,
    ).toBe(400);
    expect(
      (
        await post(a, '/v1/orders/o-2/shipments', {
          shipment_id: 's',
          quantity: 0,
          originated_at: T(0),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post(a, '/v1/orders/o-2/shipments', { shipment_id: 's', quantity: 1 })).statusCode,
    ).toBe(400);
    expect((await ship(a, 'o-9', 's-9', 1)).statusCode).toBe(404);
  });
});

describe('POST /v1/inventory/:sku/adjust', () => {
  it('adjusts stock and validates', async () => {
    const a = app();
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: 25 })).json()).toEqual({
      sku: 'D-400',
      on_hand: 525,
    });
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: -525 })).json()).toEqual({
      sku: 'D-400',
      on_hand: 0,
    });
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: -1 })).statusCode).toBe(409);
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: 0 })).statusCode).toBe(400);
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: 1.5 })).statusCode).toBe(400);
    expect((await post(a, '/v1/inventory/D-400/adjust', { delta: 10_001 })).statusCode).toBe(400);
    expect((await post(a, '/v1/inventory/D-400/adjust', [1])).statusCode).toBe(400);
    expect((await post(a, '/v1/inventory/Z-9/adjust', { delta: 1 })).statusCode).toBe(404);
  });

  it('never delays', async () => {
    const a = app();
    const start = performance.now();
    for (let i = 0; i < 40; i += 1) await post(a, '/v1/inventory/H-800/adjust', { delta: 1 });
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('store, restart, and reset', () => {
  it('keeps idempotency keys and shipment ids across an in memory restart', async () => {
    const a = app();
    const created = await create(a, 'A-100', 4, 'k-1');
    const shipped = await ship(a, 'o-1', 's-1', 2);
    const before = await ledger(a);
    expect((await post(a, '/admin/restart')).json()).toEqual({ restarted: true });
    expect((await get(a, '/v1/orders/o-1')).json()).toMatchObject({
      shipped: 2,
      status: 'PARTIALLY_SHIPPED',
    });
    expect(await ledger(a)).toEqual(before);
    expect((await create(a, 'A-100', 4, 'k-1')).body).toBe(created.body);
    expect((await ship(a, 'o-1', 's-1', 2)).body).toBe(shipped.body);
    expect((await ledger(a)).stock_on_hand['A-100']).toBe('498');
  });

  it('persists to a file and survives a real rebuild', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-ref-store-'));
    const storePath = join(dir, 'store.json');
    const first = buildApp({ now: fixedNow, storePath });
    const created = await create(first, 'B-200', 3, 'k-1');
    await ship(first, 'o-1', 's-1', 1);
    await first.close();
    const second = app({ storePath });
    expect((await create(second, 'B-200', 3, 'k-1')).body).toBe(created.body);
    expect((await get(second, '/v1/orders/o-1')).json()).toMatchObject({ shipped: 1 });
    expect((await ledger(second)).stock_on_hand['B-200']).toBe('499');
    expect((await create(second, 'B-200', 1)).json()).toMatchObject({ order_id: 'o-2' });
  });

  it('resets to the initial state', async () => {
    const a = app();
    await create(a, 'A-100', 4, 'k-1');
    await ship(a, 'o-1', 's-1', 2);
    expect((await post(a, '/admin/reset')).json()).toEqual({ reset: true });
    expect((await get(a, '/v1/orders/o-1')).statusCode).toBe(404);
    expect((await ledger(a)).receivables).toBe('0.000');
    expect((await create(a, 'A-100', 4, 'k-1')).json()).toMatchObject({ order_id: 'o-1' });
  });
});

describe('misc routes', () => {
  it('answers health and unknown routes', async () => {
    const a = app();
    expect((await get(a, '/healthz')).json()).toEqual({ ok: true });
    const missing = await get(a, '/nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  });
});
