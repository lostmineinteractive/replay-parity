/**
 * The planted divergences of the candidate service. Each is one marked line
 * in `app.ts`. The set is chosen with the `divergences` option of `buildApp`,
 * which `server.ts` reads from the `DIVERGENCES` environment variable.
 *
 * `on` enables the original four. `off` enables none. A comma separated list
 * enables exactly the named ones.
 *
 * Original four (DIVERGENCE):
 *   rounding-half-even          totals round half to even instead of half up
 *   inventory-insertion-order   GET /v1/inventory returns insertion order instead of SKU order
 *   adjust-stock-delay          POST /v1/inventory/:sku/adjust sleeps 60 ms on 5 percent of calls
 *   unknown-order-200           GET /v1/orders/:id on an unknown id returns 200 with an empty body
 *
 * Seeded defects (DEFECT):
 *   shipment-applied-twice          a repeated shipment id is applied again while the original response is returned
 *   quantity-as-additional          the quantity command adds to the quantity instead of setting it
 *   drop-late-precancel-shipment    a shipment that originated before cancellation but arrives after it is rejected
 *   idempotency-lost-on-restart     idempotency keys are not written to the store, so a retry after restart creates a second order
 */

export const CLASSIC_DIVERGENCES = [
  'rounding-half-even',
  'inventory-insertion-order',
  'adjust-stock-delay',
  'unknown-order-200',
] as const;

export const SEEDED_DEFECTS = [
  'shipment-applied-twice',
  'quantity-as-additional',
  'drop-late-precancel-shipment',
  'idempotency-lost-on-restart',
] as const;

export const ALL_DIVERGENCES = [...CLASSIC_DIVERGENCES, ...SEEDED_DEFECTS] as const;

export type DivergenceName = (typeof ALL_DIVERGENCES)[number];
export type DivergenceSetting = 'on' | 'off' | Iterable<DivergenceName>;

export class DivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DivergenceError';
  }
}

export function isDivergenceName(value: string): value is DivergenceName {
  return (ALL_DIVERGENCES as readonly string[]).includes(value);
}

/** Parses the `DIVERGENCES` environment value. Missing or empty means `on`. */
export function parseDivergences(text: string | undefined): Set<DivergenceName> {
  const trimmed = (text ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'on') return new Set(CLASSIC_DIVERGENCES);
  if (trimmed === 'off') return new Set();
  const names = new Set<DivergenceName>();
  for (const part of trimmed.split(',')) {
    const name = part.trim();
    if (name === '') continue;
    if (!isDivergenceName(name)) {
      throw new DivergenceError(
        `unknown divergence "${name}"; known names: ${ALL_DIVERGENCES.join(', ')}`,
      );
    }
    names.add(name);
  }
  return names;
}

export function resolveDivergences(setting: DivergenceSetting | undefined): Set<DivergenceName> {
  if (setting === undefined || setting === 'on') return new Set(CLASSIC_DIVERGENCES);
  if (setting === 'off') return new Set();
  return new Set(setting);
}

export const DELAY_MS = 60;
export const DELAY_FRACTION = 0.05;

/** Rounds a thousandths amount to cents, ties to the even cent. */
export function roundHalfEvenToCents(milli: number): number {
  const q = Math.floor(milli / 10);
  const r = milli - q * 10;
  if (r > 5) return q + 1;
  if (r < 5) return q;
  return q % 2 === 0 ? q : q + 1;
}

/** A small deterministic generator so the delayed calls are reproducible for a seed. */
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

/** Returns a function that answers, per adjust call, whether this call is delayed. */
export function createDelayPlan(seed: number): () => boolean {
  const random = mulberry32(seed);
  return () => random() < DELAY_FRACTION;
}
