import type { ModelUsage } from './client.js';

/**
 * Prices in US dollars per million tokens. Cache writes cost one quarter
 * more than plain input. A model that is not listed is priced like the most
 * expensive listed one and the transcript says so.
 */
export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

export const FALLBACK_PRICE_MODEL = 'claude-opus-5-5';

export function priceFor(model: string): { price: Price; assumed: boolean } {
  const price = PRICES[model];
  if (price) return { price, assumed: false };
  return { price: PRICES[FALLBACK_PRICE_MODEL] as Price, assumed: true };
}

export function costUsd(model: string, usage: ModelUsage): number {
  const { price } = priceFor(model);
  const dollars =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_tokens * price.cache_read +
      usage.cache_write_tokens * price.cache_write) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/** A conservative estimate for a call that has not happened: every output token is spent. */
export function estimateCostUsd(model: string, promptChars: number, maxTokens: number): number {
  const { price } = priceFor(model);
  const inputTokens = Math.ceil(promptChars / 3);
  return (inputTokens * price.input + maxTokens * price.output) / 1_000_000;
}
