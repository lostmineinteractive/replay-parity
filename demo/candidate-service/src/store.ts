import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATALOG } from './catalog.js';

/**
 * The service store. The working state lives in memory and every mutation is
 * committed to a durable copy: a JSON file when a path is configured,
 * otherwise an in memory snapshot. `restart` drops the working state and
 * reloads the durable copy, which is what a process restart does.
 */

export type OrderStatus =
  'PENDING' | 'OPEN' | 'PARTIALLY_SHIPPED' | 'SHIPPED' | 'CANCELED' | 'REJECTED';

export interface StockRow {
  sku: string;
  name: string;
  unit_price_milli: number;
  on_hand: number;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface OrderRecord {
  order_id: string;
  sku: string;
  unit_price_milli: number;
  /** Effective total quantity. */
  quantity: number;
  shipped: number;
  canceled_unshipped: number;
  status: OrderStatus;
  /** The amount, rounded to cents by the service's rounding rule. */
  total_cents: number;
  created_at: string;
  /** The cancel request's own originated_at, recorded as the acceptance time. */
  canceled_at: string | null;
  shipment_ids: string[];
}

export interface ShipmentRecord {
  shipment_id: string;
  order_id: string;
  quantity: number;
  originated_at: string;
  response: StoredResponse;
}

export interface IdempotencyRecord {
  payload_hash: string;
  response: StoredResponse;
}

export interface StoreState {
  order_counter: number;
  receivables_milli: number;
  stock: Record<string, StockRow>;
  orders: Record<string, OrderRecord>;
  shipments: Record<string, ShipmentRecord>;
  idempotency: Record<string, IdempotencyRecord>;
}

export interface StoreOptions {
  path?: string | null;
  /** When false, idempotency keys are left out of the durable copy. */
  persistIdempotency?: boolean;
}

export function initialState(): StoreState {
  const stock: Record<string, StockRow> = {};
  for (const entry of CATALOG) stock[entry.sku] = { ...entry };
  return {
    order_counter: 0,
    receivables_milli: 0,
    stock,
    orders: {},
    shipments: {},
    idempotency: {},
  };
}

export class Store {
  state: StoreState;
  private durable: string;
  private readonly path: string | null;
  private readonly persistIdempotency: boolean;

  constructor(options: StoreOptions = {}) {
    this.path = options.path ?? null;
    this.persistIdempotency = options.persistIdempotency ?? true;
    if (this.path !== null && existsSync(this.path)) {
      this.durable = readFileSync(this.path, 'utf8');
      this.state = JSON.parse(this.durable) as StoreState;
    } else {
      this.state = initialState();
      this.durable = JSON.stringify(this.state);
      this.writeFile();
    }
  }

  /** Makes the working state durable. */
  commit(): void {
    const snapshot = this.persistIdempotency ? this.state : { ...this.state, idempotency: {} };
    this.durable = JSON.stringify(snapshot);
    this.writeFile();
  }

  /** Drops the working state and reloads the durable copy. */
  restart(): void {
    this.state = JSON.parse(this.durable) as StoreState;
  }

  /** Returns to the initial state and makes it durable. */
  reset(): void {
    this.state = initialState();
    this.commit();
  }

  private writeFile(): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, this.durable, 'utf8');
  }
}
