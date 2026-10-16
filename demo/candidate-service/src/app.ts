import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { CATALOG, centsToUnits, milliToUnits, roundHalfUpToCents } from './catalog.js';
import { DELAY_MS, createDelayPlan, roundHalfEvenToCents } from './divergences.js';

/**
 * The candidate inventory and fulfillment service. Same routes as the
 * reference. The four planted divergences are marked with `DIVERGENCE` and
 * live behind the `divergences` option.
 *
 * Routes:
 *   GET  /v1/inventory                 list stock
 *   POST /v1/orders                    reserve stock for one SKU
 *   GET  /v1/orders/:id                fetch an order
 *   POST /v1/inventory/:sku/adjust     change stock by a delta
 *   GET  /healthz                      liveness
 */

export interface AppOptions {
  logger?: boolean;
  now?: () => Date;
  divergences?: boolean;
  seed?: number;
}

interface StockItem {
  sku: string;
  name: string;
  unit_price_milli: number;
  on_hand: number;
}

interface Order {
  order_id: string;
  status: 'reserved';
  items: { sku: string; qty: number; unit_price: number }[];
  total: number;
  created_at: string;
}

const MAX_QTY = 1000;
const MAX_DELTA = 10_000;

function bySku(a: StockItem, b: StockItem): number {
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(400).send({ error: 'invalid_request', detail });
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const divergences = options.divergences ?? true;
  const isDelayed = createDelayPlan(options.seed ?? 1);
  const roundToCents = divergences ? roundHalfEvenToCents : roundHalfUpToCents; // DIVERGENCE 1
  const app = Fastify({ logger: options.logger ?? false });

  const stock = new Map<string, StockItem>();
  for (const entry of CATALOG) stock.set(entry.sku, { ...entry });
  const orders = new Map<string, Order>();
  let orderCounter = 0;

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const status = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const detail = error instanceof Error ? error.message : String(error);
    void reply
      .code(status)
      .send({ error: status === 400 ? 'invalid_request' : 'internal_error', detail });
  });

  app.get('/healthz', () => ({ ok: true }));

  app.get('/v1/inventory', () => {
    const ordered = divergences ? [...stock.values()] : [...stock.values()].sort(bySku); // DIVERGENCE 2
    const items = ordered.map((item) => ({
      sku: item.sku,
      name: item.name,
      on_hand: item.on_hand,
      unit_price: milliToUnits(item.unit_price_milli),
    }));
    return { items };
  });

  app.post('/v1/orders', async (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { sku, qty } = body;
    if (typeof sku !== 'string' || sku.length === 0) return invalid(reply, 'sku must be a string');
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return invalid(reply, `qty must be an integer from 1 to ${MAX_QTY}`);
    }
    const item = stock.get(sku);
    if (!item) return reply.code(404).send({ error: 'unknown_sku', sku });
    if (item.on_hand < qty) {
      return reply
        .code(409)
        .send({ error: 'insufficient_stock', sku, on_hand: item.on_hand, requested: qty });
    }
    item.on_hand -= qty;
    orderCounter += 1;
    const order: Order = {
      order_id: `o-${orderCounter}`,
      status: 'reserved',
      items: [{ sku, qty, unit_price: milliToUnits(item.unit_price_milli) }],
      total: centsToUnits(roundToCents(qty * item.unit_price_milli)),
      created_at: now().toISOString(),
    };
    orders.set(order.order_id, order);
    return reply.code(201).send(order);
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', async (request, reply) => {
    const order = orders.get(request.params.id);
    if (!order) {
      if (divergences) return reply.code(200).send(); // DIVERGENCE 4
      return reply.code(404).send({ error: 'not_found' });
    }
    return order;
  });

  app.post<{ Params: { sku: string } }>('/v1/inventory/:sku/adjust', async (request, reply) => {
    if (divergences && isDelayed()) await sleep(DELAY_MS); // DIVERGENCE 3
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { delta } = body;
    if (
      typeof delta !== 'number' ||
      !Number.isInteger(delta) ||
      delta === 0 ||
      Math.abs(delta) > MAX_DELTA
    ) {
      return invalid(reply, `delta must be a non zero integer within ${MAX_DELTA}`);
    }
    const item = stock.get(request.params.sku);
    if (!item) return reply.code(404).send({ error: 'unknown_sku', sku: request.params.sku });
    if (item.on_hand + delta < 0) {
      return reply.code(409).send({
        error: 'insufficient_stock',
        sku: item.sku,
        on_hand: item.on_hand,
        requested: -delta,
      });
    }
    item.on_hand += delta;
    return { sku: item.sku, on_hand: item.on_hand };
  });

  return app;
}
