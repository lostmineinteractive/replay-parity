import { readFile } from 'node:fs/promises';
import { ConfigError, formatZodError } from '@replay-parity/core';
import { z } from 'zod';
import type { ModelUsage } from './client.js';

/**
 * Prices in US dollars per million tokens. Cache writes cost one quarter
 * more than plain input. A model that is not listed is priced like
 * `FALLBACK_PRICE_MODEL` and the transcript says so. The table is dated and
 * `pricingStaleness` warns when it is old; `loadPricingFile` and
 * `resolvePrices` let a run bring its own table.
 */
export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** The day the table below matched the first party API rates. */
export const PRICES_AS_OF = '2026-10-06';

/** How many days the table may be old before `pricingStaleness` warns. */
export const PRICING_MAX_AGE_DAYS = 90;

export const FALLBACK_PRICE_MODEL = 'claude-opus-5-5';

const FALLBACK_PRICE: Price = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 };

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  [FALLBACK_PRICE_MODEL]: FALLBACK_PRICE,
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

const DAY_MS = 86_400_000;

/** A warning when the table is older than `PRICING_MAX_AGE_DAYS`, else null. */
export function pricingStaleness(now: Date = new Date()): string | null {
  const asOf = Date.parse(`${PRICES_AS_OF}T00:00:00Z`);
  const days = Math.floor((now.getTime() - asOf) / DAY_MS);
  if (days <= PRICING_MAX_AGE_DAYS) return null;
  return `the price table is from ${PRICES_AS_OF}, ${days} days old; costs may be out of date`;
}

const PriceSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative(),
    cache_write: z.number().nonnegative(),
  })
  .strict();

const PricingFileSchema = z
  .record(z.string().min(1), PriceSchema)
  .refine((table) => Object.keys(table).length > 0, { message: 'at least one model is needed' });

/** Reads a JSON object of model id to price. Anything else is a `ConfigError` naming the path. */
export async function loadPricingFile(path: string): Promise<Readonly<Record<string, Price>>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  const result = PricingFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${path}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** The built in table with the override's entries applied on top. */
export function resolvePrices(
  override?: Readonly<Record<string, Price>>,
): Readonly<Record<string, Price>> {
  if (override === undefined) return PRICES;
  return { ...PRICES, ...override };
}

export function priceFor(
  model: string,
  prices: Readonly<Record<string, Price>> = PRICES,
): { price: Price; assumed: boolean } {
  const price = prices[model];
  if (price) return { price, assumed: false };
  // A caller supplied table may lack the fallback model; the built in row then applies.
  return { price: prices[FALLBACK_PRICE_MODEL] ?? FALLBACK_PRICE, assumed: true };
}

export function costUsd(
  model: string,
  usage: ModelUsage,
  prices: Readonly<Record<string, Price>> = PRICES,
): number {
  const { price } = priceFor(model, prices);
  const dollars =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_tokens * price.cache_read +
      usage.cache_write_tokens * price.cache_write) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/** A conservative estimate for a call that has not happened: every output token is spent. */
export function estimateCostUsd(
  model: string,
  promptChars: number,
  maxTokens: number,
  prices: Readonly<Record<string, Price>> = PRICES,
): number {
  const { price } = priceFor(model, prices);
  const inputTokens = Math.ceil(promptChars / 3);
  return (inputTokens * price.input + maxTokens * price.output) / 1_000_000;
}
