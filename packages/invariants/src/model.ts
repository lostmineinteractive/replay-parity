import type { Command, OrderView, ShipmentView } from './commands.js';

/**
 * The expected state of one system, rebuilt from its own acknowledged
 * commands. A command counts when the system answered 2xx. The model never
 * applies a command the system rejected and never applies a retried command
 * twice, so every rule compares what the system showed with what its own
 * acknowledgements imply.
 *
 * An accepted `POST /admin/reset` starts a new epoch. Rules run per epoch.
 */

export type Allocation = 'OPEN' | 'REJECTED';

export interface ExpectedOrder {
  orderId: string;
  sku: string | null;
  unitPriceMilli: number | null;
  key: string | null;
  createIndex: number;
  allocation: Allocation;
  /** The create quantity, then the value of each accepted quantity command. */
  quantity: number;
  /** The sum of unique accepted shipments. */
  shipped: number;
  shipmentIds: string[];
  canceledAt: string | null;
  canceledIndex: number | null;
}

export interface ExpectedSnapshot {
  allocation: Allocation;
  status: string;
  quantity: number;
  shipped: number;
  remaining: number;
  canceledUnshipped: number;
}

export interface ObservedFields {
  status: string | null;
  quantity: number | null;
  shipped: number | null;
  remaining: number | null;
  canceled_unshipped: number | null;
}

export interface Observation {
  command: Command;
  orderId: string;
  source: 'create' | 'cancel' | 'quantity' | 'shipment' | 'read';
  view: ObservedFields;
  /** Null when the order is unknown to the model, for example created before the recording. */
  expected: ExpectedSnapshot | null;
}

export interface ShipmentRecord {
  shipmentId: string;
  orderId: string;
  quantity: number;
  originatedAt: string;
  first: Command;
  firstView: ShipmentView | null;
  /** Accepted deliveries, the first of which is the one the model applies. */
  acceptances: Command[];
  rejections: Command[];
  /** The order's SKU when the model knows the order, used for stock attribution. */
  sku: string | null;
}

export interface ShipmentDecision {
  command: Command;
  record: ShipmentRecord;
  /** The first delivery of this shipment id. */
  first: boolean;
  order: ExpectedOrder | null;
  /** Expected state just before this delivery. */
  before: ExpectedSnapshot | null;
}

export interface QuantityDecision {
  command: Command;
  order: ExpectedOrder | null;
  shippedBefore: number | null;
}

export interface StockSnapshot {
  command: Command;
  kind: 'ledger' | 'inventory';
  stock: Record<string, number>;
  receivablesMilli: number | null;
  /** Running stock delta per SKU from accepted adjustments and unique shipments, at this read. */
  deltaAt: Map<string, number>;
  /** Shipments the model could not attribute to a SKU before this read. */
  unattributedAt: number;
}

export interface CreateRecord {
  command: Command;
  /** A new order id, not the replay of an earlier create. */
  first: boolean;
  orderId: string | null;
  sku: string;
  deltaAt: number;
  allocatedAt: number;
}

export interface PayloadGroup {
  payload: string;
  accepted: Command[];
  rejected: Command[];
  orderIds: Set<string>;
}

export interface KeyRecord {
  key: string;
  byPayload: Map<string, PayloadGroup>;
}

export interface Epoch {
  /** Index of the first command in this epoch. */
  start: number;
  commands: Command[];
  orders: Map<string, ExpectedOrder>;
  observations: Observation[];
  shipments: Map<string, ShipmentRecord>;
  shipmentDecisions: ShipmentDecision[];
  quantityDecisions: QuantityDecision[];
  snapshots: StockSnapshot[];
  creates: CreateRecord[];
  keys: Map<string, KeyRecord>;
  /** Stock per SKU at the start of the epoch, derived from the first read of that SKU. */
  initialStock: Map<string, number>;
  /** Reads that answered 404 for an order the model knows. */
  missingReads: { command: Command; orderId: string }[];
}

const LIVE = new Set(['OPEN', 'PARTIALLY_SHIPPED']);

export function snapshotOf(order: ExpectedOrder): ExpectedSnapshot {
  const canceled = order.canceledAt !== null;
  let status: string;
  if (order.allocation === 'REJECTED') status = 'REJECTED';
  else if (canceled) status = 'CANCELED';
  else if (order.shipped >= order.quantity) status = 'SHIPPED';
  else if (order.shipped > 0) status = 'PARTIALLY_SHIPPED';
  else status = 'OPEN';
  const closed = status === 'REJECTED' || status === 'CANCELED';
  return {
    allocation: order.allocation,
    status,
    quantity: order.quantity,
    shipped: order.shipped,
    remaining: closed ? 0 : order.quantity - order.shipped,
    canceledUnshipped: status === 'CANCELED' ? order.quantity - order.shipped : 0,
  };
}

export function isLiveStatus(status: string | null): boolean {
  return status !== null && LIVE.has(status);
}

function fieldsOf(view: OrderView): ObservedFields {
  return {
    status: view.status,
    quantity: view.quantity,
    shipped: view.shipped,
    remaining: view.remaining,
    canceled_unshipped: view.canceled_unshipped,
  };
}

function splitAtResets(commands: Command[]): Command[][] {
  const epochs: Command[][] = [];
  let current: Command[] = [];
  for (const c of commands) {
    if (c.kind === 'reset' && c.accepted && current.length > 0) {
      epochs.push(current);
      current = [];
    }
    current.push(c);
  }
  epochs.push(current);
  return epochs;
}

function buildEpoch(commands: Command[]): Epoch {
  const epoch: Epoch = {
    start: commands[0]?.index ?? 0,
    commands,
    orders: new Map(),
    observations: [],
    shipments: new Map(),
    shipmentDecisions: [],
    quantityDecisions: [],
    snapshots: [],
    creates: [],
    keys: new Map(),
    initialStock: new Map(),
    missingReads: [],
  };
  const delta = new Map<string, number>();
  let unattributed = 0;
  const bump = (sku: string, by: number): void => {
    delta.set(sku, (delta.get(sku) ?? 0) + by);
  };
  const allocated = (sku: string): number => {
    let total = 0;
    for (const order of epoch.orders.values()) {
      if (order.sku !== sku) continue;
      const snap = snapshotOf(order);
      if (LIVE.has(snap.status)) total += snap.remaining;
    }
    return total;
  };
  const observe = (
    command: Command,
    orderId: string,
    source: Observation['source'],
    view: ObservedFields,
  ): void => {
    const order = epoch.orders.get(orderId);
    epoch.observations.push({
      command,
      orderId,
      source,
      view,
      expected: order === undefined ? null : snapshotOf(order),
    });
  };

  for (const c of commands) {
    switch (c.kind) {
      case 'create': {
        const record: CreateRecord = {
          command: c,
          first: false,
          orderId: null,
          sku: c.sku,
          deltaAt: delta.get(c.sku) ?? 0,
          allocatedAt: allocated(c.sku),
        };
        if (c.key !== null) {
          let key = epoch.keys.get(c.key);
          if (!key) {
            key = { key: c.key, byPayload: new Map() };
            epoch.keys.set(c.key, key);
          }
          let group = key.byPayload.get(c.payload);
          if (!group) {
            group = { payload: c.payload, accepted: [], rejected: [], orderIds: new Set() };
            key.byPayload.set(c.payload, group);
          }
          (c.accepted ? group.accepted : group.rejected).push(c);
          if (c.accepted && c.view) group.orderIds.add(c.view.order_id);
        }
        if (c.accepted && c.view) {
          record.orderId = c.view.order_id;
          if (!epoch.orders.has(c.view.order_id)) {
            record.first = true;
            epoch.orders.set(c.view.order_id, {
              orderId: c.view.order_id,
              sku: c.view.sku ?? c.sku,
              unitPriceMilli: c.view.unit_price_milli,
              key: c.key,
              createIndex: c.index,
              allocation: c.view.status === 'REJECTED' ? 'REJECTED' : 'OPEN',
              quantity: c.qty,
              shipped: 0,
              shipmentIds: [],
              canceledAt: null,
              canceledIndex: null,
            });
          }
          observe(c, c.view.order_id, 'create', fieldsOf(c.view));
        }
        epoch.creates.push(record);
        break;
      }
      case 'cancel': {
        if (!c.accepted) break;
        const order = epoch.orders.get(c.orderId);
        if (order?.canceledAt === null && order.allocation === 'OPEN') {
          order.canceledAt = c.originatedAt;
          order.canceledIndex = c.index;
        }
        if (c.view) observe(c, c.orderId, 'cancel', fieldsOf(c.view));
        break;
      }
      case 'quantity': {
        if (!c.accepted) break;
        const order = epoch.orders.get(c.orderId) ?? null;
        epoch.quantityDecisions.push({
          command: c,
          order,
          shippedBefore: order === null ? null : order.shipped,
        });
        if (order) order.quantity = c.quantity;
        if (c.view) observe(c, c.orderId, 'quantity', fieldsOf(c.view));
        break;
      }
      case 'shipment': {
        const order = epoch.orders.get(c.orderId) ?? null;
        let record = epoch.shipments.get(c.shipmentId);
        const first = record === undefined;
        if (!record) {
          record = {
            shipmentId: c.shipmentId,
            orderId: c.orderId,
            quantity: c.quantity,
            originatedAt: c.originatedAt,
            first: c,
            firstView: c.view,
            acceptances: [],
            rejections: [],
            sku: order?.sku ?? null,
          };
          epoch.shipments.set(c.shipmentId, record);
        }
        epoch.shipmentDecisions.push({
          command: c,
          record,
          first,
          order,
          before: order === null ? null : snapshotOf(order),
        });
        if (c.accepted) {
          if (record.acceptances.length === 0) {
            if (order) {
              order.shipped += c.quantity;
              order.shipmentIds.push(c.shipmentId);
              if (order.sku !== null) bump(order.sku, -c.quantity);
              else unattributed += 1;
            } else {
              unattributed += 1;
            }
          }
          record.acceptances.push(c);
          if (c.view) {
            observe(c, c.orderId, 'shipment', {
              status: c.view.status,
              quantity: null,
              shipped: c.view.shipped,
              remaining: c.view.remaining,
              canceled_unshipped: null,
            });
          }
        } else {
          record.rejections.push(c);
        }
        break;
      }
      case 'adjust': {
        if (c.accepted) bump(c.sku, c.delta);
        break;
      }
      case 'read-order': {
        if (c.accepted && c.view) {
          observe(c, c.orderId, 'read', fieldsOf(c.view));
        } else if (c.status === 404 && epoch.orders.has(c.orderId)) {
          epoch.missingReads.push({ command: c, orderId: c.orderId });
        }
        break;
      }
      case 'read-ledger':
      case 'read-inventory': {
        const snapshot: StockSnapshot = {
          command: c,
          kind: c.kind === 'read-ledger' ? 'ledger' : 'inventory',
          stock: c.stock,
          receivablesMilli: c.kind === 'read-ledger' ? c.receivablesMilli : null,
          deltaAt: new Map(delta),
          unattributedAt: unattributed,
        };
        epoch.snapshots.push(snapshot);
        for (const [sku, onHand] of Object.entries(c.stock)) {
          if (!epoch.initialStock.has(sku)) {
            epoch.initialStock.set(sku, onHand - (delta.get(sku) ?? 0));
          }
        }
        break;
      }
      case 'restart':
      case 'reset':
      case 'other':
        break;
    }
  }
  return epoch;
}

export function buildEpochs(commands: Command[]): Epoch[] {
  return splitAtResets(commands).map(buildEpoch);
}
