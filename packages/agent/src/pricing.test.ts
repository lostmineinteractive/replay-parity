import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PRICE_MODEL,
  PRICES,
  PRICES_AS_OF,
  PRICING_MAX_AGE_DAYS,
  costUsd,
  estimateCostForTokens,
  estimateCostUsd,
  loadPricingFile,
  priceFor,
  pricingStaleness,
  resolvePrices,
  type Price,
} from './pricing.js';

const usage = {
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  cache_read_tokens: 500_000,
  cache_write_tokens: 200_000,
};

const custom: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
  'my-model': { input: 3, output: 6, cache_read: 0.3, cache_write: 3.75 },
};

async function pricingFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-prices-'));
  const path = join(dir, 'prices.json');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('PRICES', () => {
  it('lists the current models by plain id with a date', () => {
    expect(Object.keys(PRICES).sort()).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
    ]);
    for (const id of Object.keys(PRICES)) expect(id).not.toMatch(/\d{8}$/);
    // The fallback target of the default model is priced like the default model.
    expect(PRICES['claude-sonnet-5']).toEqual(PRICES['claude-sonnet-5-5']);
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(PRICES_AS_OF))).toBe(false);
    expect(PRICES[FALLBACK_PRICE_MODEL]).toBeDefined();
  });

  it('charges one quarter more for a cache write than for plain input', () => {
    for (const [id, price] of Object.entries(PRICES)) {
      expect(price.cache_write, id).toBeCloseTo(price.input * 1.25, 9);
      expect(price.cache_read, id).toBeLessThan(price.input);
      expect(price.output, id).toBeGreaterThan(price.input);
    }
  });
});

describe('priceFor', () => {
  it('finds a listed model and falls back for an unknown one', () => {
    expect(priceFor('claude-haiku-5-5')).toEqual({
      price: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
      assumed: false,
    });
    expect(priceFor('some-new-model')).toEqual({
      price: PRICES[FALLBACK_PRICE_MODEL],
      assumed: true,
    });
  });

  it('reads a caller supplied table and keeps the built in fallback', () => {
    expect(priceFor('my-model', custom)).toEqual({ price: custom['my-model'], assumed: false });
    expect(priceFor('claude-sonnet-5-5', custom).price.input).toBe(1);
    expect(priceFor('claude-opus-5-5', custom)).toEqual({
      price: PRICES[FALLBACK_PRICE_MODEL],
      assumed: true,
    });
    const withFallback = { ...custom, [FALLBACK_PRICE_MODEL]: custom['my-model'] as Price };
    expect(priceFor('unknown', withFallback).price).toEqual(custom['my-model']);
  });
});

describe('costUsd', () => {
  it('prices usage from the table and rounds to a millionth of a dollar', () => {
    expect(costUsd('claude-sonnet-5-5', usage)).toBe(2 + 1 + 0.1 + 0.5);
    expect(costUsd('claude-fable-5-1', usage)).toBe(10 + 5 + 0.125 + 2.5);
    expect(costUsd('some-new-model', usage)).toBe(costUsd(FALLBACK_PRICE_MODEL, usage));
    expect(costUsd('claude-haiku-5-5', { ...usage, input_tokens: 1, output_tokens: 0 })).toBe(0.03);
  });

  it('uses a caller supplied table', () => {
    expect(costUsd('claude-sonnet-5-5', usage, custom)).toBe(1 + 0.2 + 0.05 + 0.25);
    expect(costUsd('my-model', usage, custom)).toBe(3 + 0.6 + 0.15 + 0.75);
  });
});

describe('estimateCostForTokens', () => {
  it('prices a counted input at the plain rate and spends every output token', () => {
    expect(estimateCostForTokens('claude-sonnet-5-5', 1000, 8192)).toBeCloseTo(
      (1000 * 2 + 8192 * 10) / 1_000_000,
      9,
    );
    expect(estimateCostForTokens('my-model', 10, 1, custom)).toBeCloseTo(
      (10 * 3 + 1 * 6) / 1_000_000,
      9,
    );
    expect(estimateCostForTokens('unknown', 0, 0)).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  it('counts three characters per token and spends every output token', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', 3000, 8192)).toBeCloseTo(
      (1000 * 2 + 8192 * 10) / 1_000_000,
      9,
    );
    expect(estimateCostUsd('claude-sonnet-5-5', 3001, 10)).toBeCloseTo(
      (1001 * 2 + 10 * 10) / 1_000_000,
      9,
    );
    expect(estimateCostUsd('my-model', 3000, 100, custom)).toBeCloseTo(
      (1000 * 3 + 100 * 6) / 1_000_000,
      9,
    );
  });
});

describe('pricingStaleness', () => {
  const asOf = Date.parse(`${PRICES_AS_OF}T00:00:00Z`);
  const day = 86_400_000;

  it('is quiet up to the limit and warns after it', () => {
    expect(pricingStaleness(new Date(asOf))).toBeNull();
    expect(pricingStaleness(new Date(asOf - 5 * day))).toBeNull();
    expect(pricingStaleness(new Date(asOf + PRICING_MAX_AGE_DAYS * day))).toBeNull();
    expect(pricingStaleness(new Date(asOf + (PRICING_MAX_AGE_DAYS + 1) * day - 1))).toBeNull();
    expect(pricingStaleness(new Date(asOf + (PRICING_MAX_AGE_DAYS + 1) * day))).toBe(
      `the price table is from ${PRICES_AS_OF}, ${PRICING_MAX_AGE_DAYS + 1} days old; costs may be out of date`,
    );
    expect(pricingStaleness(new Date(asOf + 120 * day + day / 2))).toBe(
      `the price table is from ${PRICES_AS_OF}, 120 days old; costs may be out of date`,
    );
  });

  it('defaults to the clock', () => {
    const now = pricingStaleness();
    expect(now === null || typeof now === 'string').toBe(true);
    expect(now).toBe(pricingStaleness(new Date()));
  });
});

describe('loadPricingFile', () => {
  it('reads a table of model id to price', async () => {
    const path = await pricingFile(JSON.stringify(custom));
    expect(await loadPricingFile(path)).toEqual(custom);
  });

  it('names the file and the problem on a bad table', async () => {
    const bad = async (content: string, pattern: RegExp) => {
      const path = await pricingFile(content);
      await expect(loadPricingFile(path)).rejects.toThrow(ConfigError);
      await expect(loadPricingFile(path)).rejects.toThrow(pattern);
      await expect(loadPricingFile(path)).rejects.toThrow(path);
    };
    await bad('{oops', /invalid JSON/);
    await bad('{}', /at least one model is needed/);
    await bad('[]', /\(root\)/);
    await bad('{"m": {"input": -1, "output": 1, "cache_read": 1, "cache_write": 1}}', /m\.input/);
    await bad('{"m": {"input": 1, "output": 1, "cache_read": 1}}', /m\.cache_write/);
    await bad(
      '{"m": {"input": 1, "output": 1, "cache_read": 1, "cache_write": 1, "extra": 1}}',
      /unknown key "extra" at m/,
    );
    await bad('{"m": {"input": "1", "output": 1, "cache_read": 1, "cache_write": 1}}', /m\.input/);
    await expect(loadPricingFile(join(tmpdir(), 'rp-no-such-prices.json'))).rejects.toThrow(
      /rp-no-such-prices\.json: /,
    );
  });
});

describe('resolvePrices', () => {
  it('returns the built in table when there is no override', () => {
    expect(resolvePrices()).toBe(PRICES);
    expect(resolvePrices(undefined)).toBe(PRICES);
  });

  it('applies the override on top of the built in table', () => {
    const resolved = resolvePrices(custom);
    expect(resolved['claude-sonnet-5-5']).toEqual(custom['claude-sonnet-5-5']);
    expect(resolved['my-model']).toEqual(custom['my-model']);
    expect(resolved['claude-opus-5-5']).toEqual(PRICES['claude-opus-5-5']);
    expect(Object.keys(resolved)).toHaveLength(Object.keys(PRICES).length + 1);
    expect(PRICES['claude-sonnet-5-5']?.input).toBe(2);
    expect(costUsd('my-model', usage, resolved)).toBe(3 + 0.6 + 0.15 + 0.75);
    expect(priceFor('unknown', resolved)).toEqual({
      price: PRICES[FALLBACK_PRICE_MODEL],
      assumed: true,
    });
  });
});
