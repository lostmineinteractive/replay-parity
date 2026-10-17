import { canonicalJson, isJsonObject, type Exchange, type JsonValue } from '@replay-parity/core';

/**
 * Maps exchanges to the commands and reads of the order lifecycle. Every
 * field is read from one system's own recording. Nothing here looks at the
 * other system.
 */

export interface OrderView {
  order_id: string;
  status: string | null;
  quantity: number | null;
  shipped: number | null;
  remaining: number | null;
  canceled_unshipped: number | null;
  canceled_at: string | null;
  sku: string | null;
  /** Unit price in thousandths, read from `items[0].unit_price`. */
  unit_price_milli: number | null;
}

export interface ShipmentView {
  shipment_id: string;
  order_id: string | null;
  quantity: number | null;
  status: string | null;
  shipped: number | null;
  remaining: number | null;
}

interface Base {
  /** Position in the command list. */
  index: number;
  /** The exchange id. */
  id: string;
  sentMs: number;
  ackedMs: number;
  status: number;
  /** A 2xx response. */
  accepted: boolean;
}

export type Command = Base &
  (
    | {
        kind: 'create';
        key: string | null;
        sku: string;
        qty: number;
        /** Canonical request body, for idempotency comparison. */
        payload: string;
        view: OrderView | null;
      }
    | { kind: 'cancel'; orderId: string; originatedAt: string; view: OrderView | null }
    | { kind: 'quantity'; orderId: string; quantity: number; view: OrderView | null }
    | {
        kind: 'shipment';
        orderId: string;
        shipmentId: string;
        quantity: number;
        originatedAt: string;
        view: ShipmentView | null;
      }
    | { kind: 'adjust'; sku: string; delta: number; onHand: number | null }
    | { kind: 'restart' }
    | { kind: 'reset' }
    | { kind: 'read-order'; orderId: string; view: OrderView | null }
    | { kind: 'read-ledger'; stock: Record<string, number>; receivablesMilli: number | null }
    | { kind: 'read-inventory'; stock: Record<string, number> }
    | { kind: 'other' }
  );

export type CommandKind = Command['kind'];

export const STATE_CHANGING: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'create',
  'cancel',
  'quantity',
  'shipment',
  'adjust',
  'reset',
]);

const ORDER = /^\/v1\/orders\/([^/]+)$/;
const CANCEL = /^\/v1\/orders\/([^/]+)\/cancel$/;
const QUANTITY = /^\/v1\/orders\/([^/]+)\/quantity$/;
const SHIPMENTS = /^\/v1\/orders\/([^/]+)\/shipments$/;
const ADJUST = /^\/v1\/inventory\/([^/]+)\/adjust$/;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** Parses a decimal string such as `29.985` into thousandths without floating point. */
export function parseDecimalMilli(text: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(3, '0'));
  const value = whole * 1000 + frac;
  return m[1] === '-' ? -value : value;
}

/** Renders thousandths as a decimal string with three places. */
export function formatMilli(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}

export function parseOrderView(body: JsonValue | undefined): OrderView | null {
  if (!isJsonObject(body) || typeof body.order_id !== 'string') return null;
  const first = Array.isArray(body.items) ? body.items[0] : undefined;
  const item = isJsonObject(first) ? first : null;
  const unitPrice = item === null ? null : num(item.unit_price);
  return {
    order_id: body.order_id,
    status: str(body.status),
    quantity: int(body.quantity),
    shipped: int(body.shipped),
    remaining: int(body.remaining),
    canceled_unshipped: int(body.canceled_unshipped),
    canceled_at: str(body.canceled_at),
    sku: item === null ? null : str(item.sku),
    unit_price_milli: unitPrice === null ? null : Math.round(unitPrice * 1000),
  };
}

function parseShipmentView(body: JsonValue | undefined, shipmentId: string): ShipmentView | null {
  if (!isJsonObject(body)) return null;
  return {
    shipment_id: str(body.shipment_id) ?? shipmentId,
    order_id: str(body.order_id),
    quantity: int(body.quantity),
    status: str(body.status),
    shipped: int(body.shipped),
    remaining: int(body.remaining),
  };
}

function parseStock(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isJsonObject(value)) return out;
  for (const [sku, raw] of Object.entries(value)) {
    const n = typeof raw === 'string' ? Number(raw) : num(raw);
    if (n !== null && Number.isInteger(n)) out[sku] = n;
  }
  return out;
}

function parseInventory(body: JsonValue | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isJsonObject(body) || !Array.isArray(body.items)) return out;
  for (const item of body.items) {
    if (!isJsonObject(item)) continue;
    const sku = str(item.sku);
    const onHand = int(item.on_hand);
    if (sku !== null && onHand !== null) out[sku] = onHand;
  }
  return out;
}

export function parseCommand(exchange: Exchange, index: number): Command {
  const { request, response } = exchange;
  const base: Base = {
    index,
    id: exchange.id,
    sentMs: exchange.offset_ms,
    ackedMs: exchange.offset_ms + response.latency_ms,
    status: response.status,
    accepted: response.status >= 200 && response.status < 300,
  };
  const body = isJsonObject(request.body) ? request.body : null;
  const method = request.method.toUpperCase();
  const path = request.path.split('?')[0] ?? request.path;

  if (method === 'POST' && path === '/v1/orders') {
    const sku = body === null ? null : str(body.sku);
    const qty = body === null ? null : int(body.qty);
    if (body === null || sku === null || qty === null) return { ...base, kind: 'other' };
    const rawKey = request.headers['idempotency-key'];
    return {
      ...base,
      kind: 'create',
      key: rawKey !== undefined && rawKey.length > 0 ? rawKey : null,
      sku,
      qty,
      payload: canonicalJson(body),
      view: base.accepted ? parseOrderView(response.body) : null,
    };
  }
  let m = method === 'GET' ? ORDER.exec(path) : null;
  if (m) {
    return {
      ...base,
      kind: 'read-order',
      orderId: m[1] as string,
      view: base.accepted ? parseOrderView(response.body) : null,
    };
  }
  m = method === 'POST' ? CANCEL.exec(path) : null;
  if (m) {
    const originatedAt = body === null ? null : str(body.originated_at);
    if (originatedAt === null) return { ...base, kind: 'other' };
    return {
      ...base,
      kind: 'cancel',
      orderId: m[1] as string,
      originatedAt,
      view: base.accepted ? parseOrderView(response.body) : null,
    };
  }
  m = method === 'POST' ? QUANTITY.exec(path) : null;
  if (m) {
    const quantity = body === null ? null : int(body.quantity);
    if (quantity === null) return { ...base, kind: 'other' };
    return {
      ...base,
      kind: 'quantity',
      orderId: m[1] as string,
      quantity,
      view: base.accepted ? parseOrderView(response.body) : null,
    };
  }
  m = method === 'POST' ? SHIPMENTS.exec(path) : null;
  if (m) {
    const shipmentId = body === null ? null : str(body.shipment_id);
    const quantity = body === null ? null : int(body.quantity);
    const originatedAt = body === null ? null : str(body.originated_at);
    if (shipmentId === null || quantity === null || originatedAt === null) {
      return { ...base, kind: 'other' };
    }
    return {
      ...base,
      kind: 'shipment',
      orderId: m[1] as string,
      shipmentId,
      quantity,
      originatedAt,
      view: base.accepted ? parseShipmentView(response.body, shipmentId) : null,
    };
  }
  m = method === 'POST' ? ADJUST.exec(path) : null;
  if (m) {
    const delta = body === null ? null : int(body.delta);
    if (delta === null) return { ...base, kind: 'other' };
    const onHand = isJsonObject(response.body) ? int(response.body.on_hand) : null;
    return { ...base, kind: 'adjust', sku: m[1] as string, delta, onHand };
  }
  if (method === 'GET' && path === '/v1/ledger') {
    const stock = isJsonObject(response.body) ? parseStock(response.body.stock_on_hand) : {};
    const raw = isJsonObject(response.body) ? response.body.receivables : undefined;
    const receivablesMilli = typeof raw === 'string' ? parseDecimalMilli(raw) : null;
    return { ...base, kind: 'read-ledger', stock, receivablesMilli };
  }
  if (method === 'GET' && path === '/v1/inventory') {
    return { ...base, kind: 'read-inventory', stock: parseInventory(response.body) };
  }
  if (method === 'POST' && path === '/admin/restart') return { ...base, kind: 'restart' };
  if (method === 'POST' && path === '/admin/reset') return { ...base, kind: 'reset' };
  return { ...base, kind: 'other' };
}

export function parseCommands(exchanges: readonly Exchange[]): Command[] {
  return exchanges.map((e, i) => parseCommand(e, i));
}
