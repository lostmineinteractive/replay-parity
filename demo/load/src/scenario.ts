/**
 * The synthetic traffic plan for the demo. A seeded plan runs twelve
 * lifecycle scenarios with background traffic between them, reads the
 * ledger after every scenario, and ends with a read of every order and the
 * ledger so the recording carries the reference's final observed state.
 *
 * Steps that act on an order created earlier carry `orderRef`, the index of
 * that create step among all create steps, and use `{order}` in the path.
 * The runner resolves it from the id the service returned.
 */

export const SKUS = [
  'A-100',
  'B-200',
  'C-300',
  'D-400',
  'E-500',
  'F-600',
  'G-700',
  'H-800',
  'J-900',
  'K-950',
] as const;

export type LoadKind =
  | 'create-order'
  | 'get-order'
  | 'cancel-order'
  | 'set-quantity'
  | 'ship-order'
  | 'list-inventory'
  | 'adjust-stock'
  | 'list-ledger'
  | 'admin-restart';

export const LOAD_KINDS: readonly LoadKind[] = [
  'create-order',
  'get-order',
  'cancel-order',
  'set-quantity',
  'ship-order',
  'list-inventory',
  'adjust-stock',
  'list-ledger',
  'admin-restart',
];

export interface LoadRequest {
  kind: LoadKind;
  method: 'GET' | 'POST';
  /** May contain `{order}`, resolved from `orderRef` at send time. */
  path: string;
  body?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** Index among create steps whose returned id fills `{order}`. */
  orderRef?: number;
  /** For create steps: this step's index among create steps. */
  createIndex?: number;
  /** Scenario label, `background`, or `final`. */
  block: string;
}

/** The tag rules the demo passes to `rp capture`. Kept next to the traffic they describe. */
export const DEMO_TAG_RULES: readonly string[] = [
  'POST /v1/orders=create-order',
  'GET /v1/orders/*=get-order',
  'POST /v1/orders/*/cancel=cancel-order',
  'POST /v1/orders/*/quantity=set-quantity',
  'POST /v1/orders/*/shipments=ship-order',
  'GET /v1/inventory=list-inventory',
  'POST /v1/inventory/*/adjust=adjust-stock',
  'GET /v1/ledger=list-ledger',
  'POST /admin/restart=admin-restart',
  'POST /admin/reset=admin-reset',
];

export const SCENARIOS = [
  'full-shipment',
  'multiple-partial-shipments',
  'duplicate-shipment-delivery',
  'cancel-before-shipment',
  'partial-then-cancel',
  'partial-then-quantity-change',
  'ship-cancel-race',
  'shipments-out-of-order',
  'stock-rejection',
  'disconnect-and-replay',
  'timed-out-submit-retried',
  'restart-around-ledger-commit',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export const UNKNOWN_ORDER_SHARE = 0.15;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlanOptions {
  /** Background steps between scenarios. Default 14. */
  backgroundPerBlock?: number | undefined;
}

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

export function buildPlan(seed: number, options: PlanOptions = {}): LoadRequest[] {
  const backgroundPerBlock = options.backgroundPerBlock ?? 14;
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const steps: LoadRequest[] = [];
  let createCount = 0;
  let keyCount = 0;
  let shipCount = 0;
  let tick = 0;

  /** A logical timestamp: plan position plus an offset in seconds. */
  const at = (offsetSeconds: number): string =>
    new Date(T0 + (tick + offsetSeconds) * 1000).toISOString();
  const push = (step: LoadRequest): void => {
    steps.push(step);
    tick += 1;
  };
  const nextKey = (): string => {
    keyCount += 1;
    return `idem-${seed}-${keyCount}`;
  };
  const create = (block: string, sku: string, qty: number, key?: string): number => {
    const createIndex = createCount;
    createCount += 1;
    push({
      kind: 'create-order',
      method: 'POST',
      path: '/v1/orders',
      body: { sku, qty },
      ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
      createIndex,
      block,
    });
    return createIndex;
  };
  const getOrder = (block: string, orderRef: number): void =>
    push({ kind: 'get-order', method: 'GET', path: '/v1/orders/{order}', orderRef, block });
  const cancel = (block: string, orderRef: number, offset = 0): void =>
    push({
      kind: 'cancel-order',
      method: 'POST',
      path: '/v1/orders/{order}/cancel',
      body: { originated_at: at(offset) },
      orderRef,
      block,
    });
  const setQuantity = (block: string, orderRef: number, quantity: number): void =>
    push({
      kind: 'set-quantity',
      method: 'POST',
      path: '/v1/orders/{order}/quantity',
      body: { quantity },
      orderRef,
      block,
    });
  const ship = (
    block: string,
    orderRef: number,
    quantity: number,
    offset = 0,
    id?: string,
  ): string => {
    let shipmentId = id;
    if (shipmentId === undefined) {
      shipCount += 1;
      shipmentId = `shp-${seed}-${shipCount}`;
    }
    push({
      kind: 'ship-order',
      method: 'POST',
      path: '/v1/orders/{order}/shipments',
      body: { shipment_id: shipmentId, quantity, originated_at: at(offset) },
      orderRef,
      block,
    });
    return shipmentId;
  };
  const ledger = (block: string): void =>
    push({ kind: 'list-ledger', method: 'GET', path: '/v1/ledger', block });
  const restart = (block: string): void =>
    push({ kind: 'admin-restart', method: 'POST', path: '/admin/restart', block });

  const background = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const r = random();
      if (r < 0.2) {
        create('background', pick(SKUS), 1 + Math.floor(random() * 6));
      } else if (r < 0.5) {
        if (createCount > 0 && random() >= UNKNOWN_ORDER_SHARE) {
          getOrder('background', Math.floor(random() * createCount));
        } else {
          push({
            kind: 'get-order',
            method: 'GET',
            path: `/v1/orders/o-${9000 + Math.floor(random() * 999)}`,
            block: 'background',
          });
        }
      } else if (r < 0.75) {
        push({ kind: 'list-inventory', method: 'GET', path: '/v1/inventory', block: 'background' });
      } else {
        let delta = Math.floor(random() * 31) - 15;
        if (delta === 0) delta = 1;
        push({
          kind: 'adjust-stock',
          method: 'POST',
          path: `/v1/inventory/${pick(SKUS)}/adjust`,
          body: { delta },
          block: 'background',
        });
      }
    }
  };

  const scenarios: Record<ScenarioName, () => void> = {
    'full-shipment': () => {
      const o = create('full-shipment', 'A-100', 3);
      ship('full-shipment', o, 3);
      getOrder('full-shipment', o);
    },
    'multiple-partial-shipments': () => {
      const o = create('multiple-partial-shipments', 'B-200', 5);
      ship('multiple-partial-shipments', o, 2);
      ship('multiple-partial-shipments', o, 3);
      getOrder('multiple-partial-shipments', o);
    },
    'duplicate-shipment-delivery': () => {
      const o = create('duplicate-shipment-delivery', 'H-800', 4);
      const id = ship('duplicate-shipment-delivery', o, 2);
      ship('duplicate-shipment-delivery', o, 2, 0, id);
      getOrder('duplicate-shipment-delivery', o);
    },
    'cancel-before-shipment': () => {
      const o = create('cancel-before-shipment', 'C-300', 2);
      cancel('cancel-before-shipment', o, 0);
      ship('cancel-before-shipment', o, 1, 5);
      getOrder('cancel-before-shipment', o);
    },
    'partial-then-cancel': () => {
      const o = create('partial-then-cancel', 'D-400', 6);
      ship('partial-then-cancel', o, 2);
      cancel('partial-then-cancel', o, 0);
      getOrder('partial-then-cancel', o);
    },
    'partial-then-quantity-change': () => {
      const o = create('partial-then-quantity-change', 'E-500', 6);
      ship('partial-then-quantity-change', o, 2);
      setQuantity('partial-then-quantity-change', o, 4);
      setQuantity('partial-then-quantity-change', o, 1);
      getOrder('partial-then-quantity-change', o);
    },
    'ship-cancel-race': () => {
      const o = create('ship-cancel-race', 'F-600', 5);
      cancel('ship-cancel-race', o, 10);
      ship('ship-cancel-race', o, 2, 5);
      ship('ship-cancel-race', o, 1, 20);
      getOrder('ship-cancel-race', o);
    },
    'shipments-out-of-order': () => {
      const o = create('shipments-out-of-order', 'G-700', 6);
      ship('shipments-out-of-order', o, 2, 8);
      ship('shipments-out-of-order', o, 3, 3);
      getOrder('shipments-out-of-order', o);
    },
    'stock-rejection': () => {
      const o = create('stock-rejection', 'J-900', 600);
      ship('stock-rejection', o, 1);
      getOrder('stock-rejection', o);
    },
    'disconnect-and-replay': () => {
      const key = nextKey();
      const o = create('disconnect-and-replay', 'K-950', 2, key);
      create('disconnect-and-replay', 'K-950', 2, key);
      create('disconnect-and-replay', 'K-950', 3, key);
      getOrder('disconnect-and-replay', o);
    },
    'timed-out-submit-retried': () => {
      const key = nextKey();
      const o = create('timed-out-submit-retried', 'A-100', 4, key);
      background(3);
      create('timed-out-submit-retried', 'A-100', 4, key);
      ship('timed-out-submit-retried', o, 4);
      getOrder('timed-out-submit-retried', o);
    },
    'restart-around-ledger-commit': () => {
      ledger('restart-around-ledger-commit');
      const key = nextKey();
      const o = create('restart-around-ledger-commit', 'B-200', 3, key);
      restart('restart-around-ledger-commit');
      create('restart-around-ledger-commit', 'B-200', 3, key);
      ledger('restart-around-ledger-commit');
      getOrder('restart-around-ledger-commit', o);
    },
  };

  for (const name of SCENARIOS) {
    scenarios[name]();
    ledger(name);
    background(backgroundPerBlock);
  }

  ledger('final');
  for (let orderRef = 0; orderRef < createCount; orderRef += 1) getOrder('final', orderRef);
  ledger('final');
  return steps;
}
