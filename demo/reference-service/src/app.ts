import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { centsToUnits, milliToUnits, roundHalfUpToCents } from './catalog.js';
import { Store, type OrderRecord, type StockRow, type StoredResponse } from './store.js';

/**
 * Inventory and fulfillment service for the replay-parity demo.
 *
 * Routes:
 *   GET  /v1/inventory                  list stock
 *   GET  /v1/ledger                     stock on hand per SKU and receivables, as decimal strings
 *   POST /v1/orders                     create an order, Idempotency-Key aware
 *   GET  /v1/orders/:id                 fetch an order
 *   POST /v1/orders/:id/cancel          cancel an order
 *   POST /v1/orders/:id/quantity        set the order quantity
 *   POST /v1/orders/:id/shipments       record a warehouse shipment event
 *   POST /v1/inventory/:sku/adjust      change stock on hand by a delta
 *   POST /admin/restart                 drop in memory state and reload the store
 *   POST /admin/reset                   return to the initial state
 *   GET  /healthz                       liveness
 */

export interface AppOptions {
  logger?: boolean;
  now?: () => Date;
  /** Path of the JSON store file. Without it the store keeps an in memory durable copy. */
  storePath?: string | null;
}

const MAX_QTY = 1000;
const MAX_DELTA = 10_000;
const LIVE: readonly string[] = ['OPEN', 'PARTIALLY_SHIPPED'];

function bySku(a: StockRow, b: StockRow): number {
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_QTY;
}

function invalid(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(400).send({ error: 'invalid_request', detail });
}

function payloadHash(body: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) sorted[key] = body[key];
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Renders an amount in thousandths as a decimal string with three places. */
function formatMilli(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const roundToCents = roundHalfUpToCents;
  const store = new Store({ path: options.storePath ?? null });
  const app = Fastify({ logger: options.logger ?? false });

  const stockOf = (sku: string): StockRow | undefined => store.state.stock[sku];

  function allocated(sku: string): number {
    let total = 0;
    for (const order of Object.values(store.state.orders)) {
      if (order.sku === sku && LIVE.includes(order.status)) total += order.quantity - order.shipped;
    }
    return total;
  }

  const available = (sku: string): number => (stockOf(sku)?.on_hand ?? 0) - allocated(sku);

  function remainingOf(order: OrderRecord): number {
    if (order.status === 'CANCELED' || order.status === 'REJECTED') return 0;
    return order.quantity - order.shipped;
  }

  function recomputeStatus(order: OrderRecord): void {
    if (order.status === 'CANCELED' || order.status === 'REJECTED') return;
    order.status =
      order.shipped >= order.quantity
        ? 'SHIPPED'
        : order.shipped > 0
          ? 'PARTIALLY_SHIPPED'
          : 'OPEN';
  }

  function orderView(order: OrderRecord): Record<string, unknown> {
    return {
      order_id: order.order_id,
      status: order.status,
      items: [
        { sku: order.sku, qty: order.quantity, unit_price: milliToUnits(order.unit_price_milli) },
      ],
      total: centsToUnits(order.total_cents),
      quantity: order.quantity,
      shipped: order.shipped,
      remaining: remainingOf(order),
      canceled_unshipped: order.canceled_unshipped,
      created_at: order.created_at,
      canceled_at: order.canceled_at,
    };
  }

  /** Applies a shipment event to the order, the stock, and receivables. */
  function applyShipment(orderId: string, quantity: number): void {
    const order = store.state.orders[orderId];
    const stock = order === undefined ? undefined : stockOf(order.sku);
    if (order === undefined || stock === undefined) return;
    order.shipped += quantity;
    if (order.status === 'CANCELED') {
      order.canceled_unshipped = Math.max(0, order.canceled_unshipped - quantity);
    }
    stock.on_hand -= quantity;
    store.state.receivables_milli += quantity * order.unit_price_milli;
    recomputeStatus(order);
  }

  function shipmentView(
    order: OrderRecord,
    shipmentId: string,
    quantity: number,
    originatedAt: string,
  ) {
    return {
      shipment_id: shipmentId,
      order_id: order.order_id,
      quantity,
      originated_at: originatedAt,
      status: order.status,
      shipped: order.shipped,
      remaining: remainingOf(order),
    };
  }

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
    const ordered = [...Object.values(store.state.stock)].sort(bySku);
    const items = ordered.map((item) => ({
      sku: item.sku,
      name: item.name,
      on_hand: item.on_hand,
      unit_price: milliToUnits(item.unit_price_milli),
    }));
    return { items };
  });

  app.get('/v1/ledger', () => {
    const stock_on_hand: Record<string, string> = {};
    for (const row of [...Object.values(store.state.stock)].sort(bySku)) {
      stock_on_hand[row.sku] = String(row.on_hand);
    }
    return { stock_on_hand, receivables: formatMilli(store.state.receivables_milli) };
  });

  app.post('/v1/orders', (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { sku, qty } = body;
    if (typeof sku !== 'string' || sku.length === 0) return invalid(reply, 'sku must be a string');
    if (!isQuantity(qty)) return invalid(reply, `qty must be an integer from 1 to ${MAX_QTY}`);
    const rawKey = request.headers['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : null;
    const hash = payloadHash(body);
    if (idempotencyKey !== null) {
      const seen = store.state.idempotency[idempotencyKey];
      if (seen !== undefined) {
        if (seen.payload_hash !== hash) {
          return reply
            .code(409)
            .send({ error: 'idempotency_conflict', idempotency_key: idempotencyKey });
        }
        return reply.code(seen.response.status).send(seen.response.body);
      }
    }
    const stock = stockOf(sku);
    if (stock === undefined) return reply.code(404).send({ error: 'unknown_sku', sku });
    store.state.order_counter += 1;
    const accepted = qty <= available(sku);
    const order: OrderRecord = {
      order_id: `o-${store.state.order_counter}`,
      sku,
      unit_price_milli: stock.unit_price_milli,
      quantity: qty,
      shipped: 0,
      canceled_unshipped: 0,
      status: accepted ? 'OPEN' : 'REJECTED',
      total_cents: roundToCents(qty * stock.unit_price_milli),
      created_at: now().toISOString(),
      canceled_at: null,
      shipment_ids: [],
    };
    store.state.orders[order.order_id] = order;
    const view = orderView(order);
    if (idempotencyKey !== null) {
      store.state.idempotency[idempotencyKey] = {
        payload_hash: hash,
        response: { status: 201, body: view },
      };
    }
    store.commit();
    return reply.code(201).send(view);
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', (request, reply) => {
    const order = store.state.orders[request.params.id];
    if (order === undefined) return reply.code(404).send({ error: 'not_found' }); // unknown order
    return orderView(order);
  });

  app.post<{ Params: { id: string } }>('/v1/orders/:id/cancel', (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { originated_at } = body;
    if (!isIsoDate(originated_at)) {
      return invalid(reply, 'originated_at must be an ISO 8601 timestamp');
    }
    const order = store.state.orders[request.params.id];
    if (order === undefined) return reply.code(404).send({ error: 'not_found' });
    if (order.status === 'CANCELED') return orderView(order);
    if (!LIVE.includes(order.status)) {
      return reply.code(409).send({ error: 'invalid_state', status: order.status });
    }
    order.status = 'CANCELED';
    order.canceled_at = originated_at;
    order.canceled_unshipped = order.quantity - order.shipped;
    store.commit();
    return orderView(order);
  });

  app.post<{ Params: { id: string } }>('/v1/orders/:id/quantity', (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { quantity } = body;
    if (!isQuantity(quantity)) {
      return invalid(reply, `quantity must be an integer from 1 to ${MAX_QTY}`);
    }
    const order = store.state.orders[request.params.id];
    if (order === undefined) return reply.code(404).send({ error: 'not_found' });
    if (!LIVE.includes(order.status)) {
      return reply.code(409).send({ error: 'invalid_state', status: order.status });
    }
    const nextQuantity = quantity;
    if (nextQuantity < order.shipped) {
      return reply
        .code(409)
        .send({ error: 'below_shipped', shipped: order.shipped, requested: nextQuantity });
    }
    const increase = nextQuantity - order.quantity;
    if (increase > 0 && increase > available(order.sku)) {
      return reply.code(409).send({
        error: 'insufficient_stock',
        sku: order.sku,
        available: available(order.sku),
        requested: increase,
      });
    }
    order.quantity = nextQuantity;
    order.total_cents = roundToCents(nextQuantity * order.unit_price_milli);
    recomputeStatus(order);
    store.commit();
    return orderView(order);
  });

  app.post<{ Params: { id: string } }>('/v1/orders/:id/shipments', (request, reply) => {
    const body: unknown = request.body;
    if (!isRecord(body)) return invalid(reply, 'body must be an object');
    const { shipment_id, quantity, originated_at } = body;
    if (typeof shipment_id !== 'string' || shipment_id.length === 0) {
      return invalid(reply, 'shipment_id must be a string');
    }
    if (!isQuantity(quantity)) {
      return invalid(reply, `quantity must be an integer from 1 to ${MAX_QTY}`);
    }
    if (!isIsoDate(originated_at)) {
      return invalid(reply, 'originated_at must be an ISO 8601 timestamp');
    }
    const existing = store.state.shipments[shipment_id];
    if (existing !== undefined) {
      return reply.code(existing.response.status).send(existing.response.body);
    }
    const order = store.state.orders[request.params.id];
    if (order === undefined) return reply.code(404).send({ error: 'not_found' });
    const stock = stockOf(order.sku);
    if (stock === undefined) return reply.code(404).send({ error: 'unknown_sku', sku: order.sku });

    let rejection: StoredResponse | null = null;
    if (order.status === 'REJECTED') {
      rejection = { status: 409, body: { error: 'invalid_state', status: order.status } };
    } else if (order.status === 'CANCELED') {
      const preCancel =
        order.canceled_at !== null && Date.parse(originated_at) < Date.parse(order.canceled_at);
      if (!preCancel) {
        rejection = {
          status: 409,
          body: { error: 'order_canceled', canceled_at: order.canceled_at },
        };
      }
    }
    if (rejection === null && quantity > order.quantity - order.shipped) {
      rejection = {
        status: 409,
        body: {
          error: 'exceeds_remaining',
          remaining: order.quantity - order.shipped,
          requested: quantity,
        },
      };
    }
    if (rejection === null && quantity > stock.on_hand) {
      rejection = {
        status: 409,
        body: {
          error: 'insufficient_stock',
          sku: order.sku,
          on_hand: stock.on_hand,
          requested: quantity,
        },
      };
    }
    if (rejection !== null) return reply.code(rejection.status).send(rejection.body);

    applyShipment(order.order_id, quantity);
    const response: StoredResponse = {
      status: 201,
      body: shipmentView(order, shipment_id, quantity, originated_at),
    };
    store.state.shipments[shipment_id] = {
      shipment_id,
      order_id: order.order_id,
      quantity,
      originated_at,
      response,
    };
    order.shipment_ids.push(shipment_id);
    store.commit();
    return reply.code(response.status).send(response.body);
  });

  app.post<{ Params: { sku: string } }>('/v1/inventory/:sku/adjust', (request, reply) => {
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
    const item = stockOf(request.params.sku);
    if (item === undefined) {
      return reply.code(404).send({ error: 'unknown_sku', sku: request.params.sku });
    }
    if (item.on_hand + delta < 0) {
      return reply.code(409).send({
        error: 'insufficient_stock',
        sku: item.sku,
        on_hand: item.on_hand,
        requested: -delta,
      });
    }
    item.on_hand += delta;
    store.commit();
    return { sku: item.sku, on_hand: item.on_hand };
  });

  app.post('/admin/restart', () => {
    store.restart();
    return { restarted: true };
  });

  app.post('/admin/reset', () => {
    store.reset();
    return { reset: true };
  });

  return app;
}
