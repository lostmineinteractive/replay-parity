/**
 * The four planted divergences of the candidate service. Each is switched by
 * the `divergences` option of `buildApp`, which `server.ts` reads from the
 * `DIVERGENCES` environment variable (`on` by default, `off` to disable).
 *
 * 1. Rounding: totals round half to even instead of half up.
 * 2. Ordering: `GET /v1/inventory` returns items in insertion order instead of SKU order.
 * 3. Latency: `POST /v1/inventory/:sku/adjust` sleeps 60 ms on 5 percent of calls.
 * 4. Behavior: `GET /v1/orders/:id` on an unknown id returns 200 with an empty body instead of 404.
 */

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
