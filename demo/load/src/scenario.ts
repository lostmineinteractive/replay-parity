/**
 * The synthetic traffic mix for the demo. A seeded generator produces a
 * sequence of requests across the four scenario tags. Order lookups use ids
 * returned by earlier order creations, which is what the replay engine's
 * substitutions handle, and a share of them use an unknown id on purpose.
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

export type LoadKind = 'create-order' | 'get-order' | 'list-inventory' | 'adjust-stock';

export interface LoadRequest {
  kind: LoadKind;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, string | number>;
}

/** The tag rules the demo passes to `rp capture`. Kept next to the traffic they describe. */
export const DEMO_TAG_RULES: readonly string[] = [
  'POST /v1/orders=create-order',
  'GET /v1/orders/*=get-order',
  'GET /v1/inventory=list-inventory',
  'POST /v1/inventory/*/adjust=adjust-stock',
];

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

export interface Scenario {
  next(knownOrderIds: readonly string[]): LoadRequest;
  /** A uniform draw from the same generator, for pacing jitter. */
  random(): number;
}

export const UNKNOWN_ORDER_SHARE = 0.15;

export function createScenario(seed: number): Scenario {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return {
    random,
    next(knownOrderIds) {
      const r = random();
      if (r < 0.35 || (r < 0.6 && knownOrderIds.length === 0)) {
        return {
          kind: 'create-order',
          method: 'POST',
          path: '/v1/orders',
          body: { sku: pick(SKUS), qty: 1 + Math.floor(random() * 6) },
        };
      }
      if (r < 0.6) {
        const unknown = random() < UNKNOWN_ORDER_SHARE;
        const id = unknown ? `o-${9000 + Math.floor(random() * 999)}` : pick(knownOrderIds);
        return { kind: 'get-order', method: 'GET', path: `/v1/orders/${id}` };
      }
      if (r < 0.8) {
        return { kind: 'list-inventory', method: 'GET', path: '/v1/inventory' };
      }
      let delta = Math.floor(random() * 31) - 15;
      if (delta === 0) delta = 1;
      return {
        kind: 'adjust-stock',
        method: 'POST',
        path: `/v1/inventory/${pick(SKUS)}/adjust`,
        body: { delta },
      };
    },
  };
}
