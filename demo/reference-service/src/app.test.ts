import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { CATALOG, roundHalfUpToCents } from './catalog.js';

const fixedNow = () => new Date('2026-10-16T18:00:00.000Z');

function app() {
  const instance = buildApp({ now: fixedNow });
  apps.push(instance);
  return instance;
}

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('rounding', () => {
  it('rounds half up to cents', () => {
    expect(roundHalfUpToCents(9_995)).toBe(1000);
    expect(roundHalfUpToCents(4_125)).toBe(413);
    expect(roundHalfUpToCents(4_124)).toBe(412);
    expect(roundHalfUpToCents(8_250)).toBe(825);
  });
});

describe('POST /v1/orders', () => {
  it('reserves stock and rounds the total half up', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'B-200', qty: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      order_id: 'o-1',
      status: 'reserved',
      items: [{ sku: 'B-200', qty: 1, unit_price: 4.125 }],
      total: 4.13,
      created_at: '2026-10-16T18:00:00.000Z',
    });
    const second = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'A-100', qty: 3 },
    });
    expect(second.json()).toMatchObject({ order_id: 'o-2', total: 29.99 });
    const inventory = (await a.inject({ method: 'GET', url: '/v1/inventory' })).json<{
      items: { sku: string; on_hand: number }[];
    }>();
    expect(inventory.items.find((i) => i.sku === 'B-200')?.on_hand).toBe(499);
    expect(inventory.items.find((i) => i.sku === 'A-100')?.on_hand).toBe(497);
  });

  it('rejects bad input, unknown skus, and insufficient stock', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/v1/orders', payload: [] })).statusCode).toBe(
      400,
    );
    expect(
      (await a.inject({ method: 'POST', url: '/v1/orders', payload: { sku: 'A-100' } })).statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/orders', payload: { sku: 'A-100', qty: 0 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/orders', payload: { sku: 'A-100', qty: 1001 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/orders', payload: { sku: 7, qty: 1 } }))
        .statusCode,
    ).toBe(400);
    const unknown = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'Z-1', qty: 1 },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown_sku', sku: 'Z-1' });
    const tooMany = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'A-100', qty: 501 },
    });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toEqual({
      error: 'insufficient_stock',
      sku: 'A-100',
      on_hand: 500,
      requested: 501,
    });
    const invalidJson = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('GET /v1/orders/:id', () => {
  it('returns the order or 404', async () => {
    const a = app();
    const created = await a.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { sku: 'C-300', qty: 2 },
    });
    const fetched = await a.inject({ method: 'GET', url: '/v1/orders/o-1' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(created.json());
    const missing = await a.inject({ method: 'GET', url: '/v1/orders/o-999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /v1/inventory', () => {
  it('lists items ordered by SKU', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/v1/inventory' });
    const items = res.json<{
      items: { sku: string; name: string; on_hand: number; unit_price: number }[];
    }>().items;
    expect(items).toHaveLength(CATALOG.length);
    expect(items.map((i) => i.sku)).toEqual([...CATALOG.map((c) => c.sku)].sort());
    expect(items[0]).toEqual({
      sku: 'A-100',
      name: 'Hex bolt M8',
      on_hand: 500,
      unit_price: 9.995,
    });
  });
});

describe('POST /v1/inventory/:sku/adjust', () => {
  it('adjusts stock and validates', async () => {
    const a = app();
    const up = await a.inject({
      method: 'POST',
      url: '/v1/inventory/D-400/adjust',
      payload: { delta: 25 },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ sku: 'D-400', on_hand: 525 });
    const down = await a.inject({
      method: 'POST',
      url: '/v1/inventory/D-400/adjust',
      payload: { delta: -525 },
    });
    expect(down.json()).toEqual({ sku: 'D-400', on_hand: 0 });
    const below = await a.inject({
      method: 'POST',
      url: '/v1/inventory/D-400/adjust',
      payload: { delta: -1 },
    });
    expect(below.statusCode).toBe(409);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/inventory/D-400/adjust', payload: { delta: 0 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/v1/inventory/D-400/adjust',
          payload: { delta: 1.5 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/v1/inventory/D-400/adjust',
          payload: { delta: 10_001 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/v1/inventory/D-400/adjust',
          headers: { 'content-type': 'application/json' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/inventory/Z-9/adjust', payload: { delta: 1 } }))
        .statusCode,
    ).toBe(404);
  });

  it('never delays', async () => {
    const a = app();
    const start = performance.now();
    for (let i = 0; i < 40; i += 1) {
      await a.inject({ method: 'POST', url: '/v1/inventory/H-800/adjust', payload: { delta: 1 } });
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('misc routes', () => {
  it('answers health and unknown routes', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    const missing = await a.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  });
});
