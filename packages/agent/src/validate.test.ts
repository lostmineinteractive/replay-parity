import { REDACTED } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { costUsd, estimateCostUsd, priceFor } from './pricing.js';
import { parseAnswer, validateCases } from './validate.js';

const TAGS = ['create-order', 'get-order'];
const create = { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 3 } };
const ok = {
  hypothesis: 'odd quantities round differently',
  tags: ['create-order'],
  steps: [{ request: create }],
};

describe('validateCases on a schema constrained answer', () => {
  it('decodes pairs and body text, then applies the same checks as a plain answer', () => {
    const text = JSON.stringify({
      cases: [
        {
          hypothesis: 'ship after create',
          tags: ['create-order'],
          steps: [
            {
              request: {
                method: 'POST',
                path: '/v1/orders',
                headers: [{ name: 'Authorization', value: REDACTED }],
                body_json: '{"sku":"A-100","qty":3}',
              },
              capture: { name: 'order', path: '$.order_id' },
            },
            {
              request: {
                method: 'GET',
                path: '/v1/orders/{{order}}',
                query: [
                  { name: 'fields', value: 'total' },
                  { name: 'fields', value: 'status' },
                ],
              },
            },
          ],
        },
        { ...ok, steps: [{ request: { method: 'GET', path: '/v1/orders', body_json: '{oops' } }] },
        {
          ...ok,
          steps: [{ request: { method: 'GET', path: '/v1/orders', headers: [{ name: 'a' }] } }],
        },
        {
          ...ok,
          steps: [{ request: { method: 'GET', path: '/v1/orders', body: {}, body_json: '{}' } }],
        },
        {
          ...ok,
          steps: [
            {
              request: {
                method: 'POST',
                path: '/v1/orders',
                headers: [{ name: 'authorization', value: 'Bearer live' }],
                body_json: '{}',
              },
            },
          ],
        },
      ],
    });
    const result = validateCases(text, TAGS);
    expect(result.proposed).toBe(5);
    expect(result.cases).toHaveLength(1);
    const c = result.cases[0]!;
    expect(c.steps[0]?.request.body).toEqual({ sku: 'A-100', qty: 3 });
    expect(c.steps[0]?.request.headers).toEqual({ authorization: REDACTED });
    expect(c.steps[1]?.request.query).toEqual({ fields: ['total', 'status'] });
    expect(c.repeat).toBe(1);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      expect.stringContaining('step 1 body_json is not valid JSON') as string,
      'step 1 headers must be a list of {name, value} pairs',
      'step 1 has both body and body_json',
      `step 1 sets header authorization to a value other than ${REDACTED}`,
    ]);
  });
});

describe('parseAnswer', () => {
  it('reads an object with cases, a bare array, and a fenced block', () => {
    expect(parseAnswer('{"cases": [1]}')).toEqual({ cases: [1] });
    expect(parseAnswer('[1, 2]')).toEqual({ cases: [1, 2] });
    expect(parseAnswer('Here you go:\n```json\n{"cases": []}\n```')).toEqual({ cases: [] });
    expect(parseAnswer('not json')).toEqual({
      error: expect.stringContaining('invalid JSON') as string,
    });
    expect(parseAnswer('{"nope": 1}')).toEqual({ error: 'expected an object with a cases array' });
  });
});

describe('validateCases', () => {
  it('keeps a single step case and a two step case with a capture', () => {
    const text = JSON.stringify({
      cases: [
        ok,
        {
          hypothesis: 'a read after create shows the rounded total',
          tags: ['get-order'],
          steps: [
            { request: create, capture: { name: 'id', path: '$.order_id' } },
            { request: { method: 'GET', path: '/v1/orders/{{id}}' } },
          ],
        },
      ],
    });
    const result = validateCases(text, TAGS);
    expect(result.proposed).toBe(2);
    expect(result.cases).toHaveLength(2);
    expect(result.dropped).toEqual([]);
    expect(result.cases[1]?.steps[1]?.request.query).toEqual({});
  });

  it('drops malformed cases with a reason each', () => {
    const text = JSON.stringify({
      cases: [
        { hypothesis: 'no steps', tags: ['create-order'], steps: [] },
        { ...ok, tags: ['restock'] },
        {
          ...ok,
          steps: [
            { request: create },
            { request: create },
            { request: create },
            { request: create },
          ],
        },
        {
          ...ok,
          steps: [{ request: { method: 'GET', path: '/v1/orders/{{id}}' } }],
        },
        {
          ...ok,
          steps: [{ request: { ...create, headers: { authorization: 'Bearer live' } } }],
        },
        { ...ok, extra: true },
        { ...ok, steps: [{ request: { method: 'GET', path: 'orders' } }] },
        { ...ok, steps: [{ request: create, capture: { name: 'x', path: '$..deep' } }] },
      ],
    });
    const result = validateCases(text, TAGS);
    expect(result.cases).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      expect.stringContaining('steps') as string,
      'unknown tag "restock"',
      expect.stringContaining('steps') as string,
      'step 1 uses {{id}} which no earlier step captured',
      `step 1 sets header authorization to a value other than ${REDACTED}`,
      expect.stringContaining('unknown key "extra"') as string,
      expect.stringContaining('path') as string,
      expect.stringContaining('JSONPath') as string,
    ]);
    expect(result.proposed).toBe(8);
  });

  it('accepts a redacted header value and a placeholder captured earlier in the body', () => {
    const text = JSON.stringify({
      cases: [
        {
          ...ok,
          steps: [
            {
              request: {
                ...create,
                headers: { authorization: REDACTED, 'content-type': 'application/json' },
              },
            },
          ],
        },
        {
          hypothesis: 'ship after create',
          tags: ['create-order'],
          steps: [
            { request: create, capture: { name: 'order', path: '$.order_id' } },
            {
              request: {
                method: 'POST',
                path: '/v1/orders/{{order}}/shipments',
                body: { order: '{{order}}', quantity: 1 },
              },
            },
          ],
        },
      ],
    });
    expect(validateCases(text, TAGS).cases).toHaveLength(2);
  });

  it('defaults repeat to 1 and drops a repeat outside 1 to 50', () => {
    const text = JSON.stringify({
      cases: [
        ok,
        { ...ok, repeat: 10 },
        { ...ok, repeat: 0 },
        { ...ok, repeat: 51 },
        { ...ok, repeat: 2.5 },
      ],
    });
    const result = validateCases(text, TAGS);
    expect(result.cases.map((c) => c.repeat)).toEqual([1, 10]);
    expect(result.dropped.map((d) => d.index)).toEqual([2, 3, 4]);
    for (const d of result.dropped) expect(d.reason).toContain('repeat');
  });

  it('reports a parse error for an unreadable answer', () => {
    const result = validateCases('I cannot help with that.', TAGS);
    expect(result.cases).toEqual([]);
    expect(result.parse_error).toContain('invalid JSON');
    expect(result.proposed).toBe(0);
  });
});

describe('pricing', () => {
  it('prices usage from the table and falls back for unknown models', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 500_000,
      cache_write_tokens: 200_000,
    };
    expect(costUsd('claude-sonnet-5-5', usage)).toBe(2 + 1 + 0.1 + 0.5);
    expect(costUsd('claude-opus-5-5', usage)).toBe(4 + 2 + 0.1 + 1);
    expect(priceFor('claude-sonnet-5-5').assumed).toBe(false);
    expect(priceFor('some-new-model')).toEqual({
      price: priceFor('claude-opus-5-5').price,
      assumed: true,
    });
    expect(costUsd('some-new-model', usage)).toBe(costUsd('claude-opus-5-5', usage));
    expect(estimateCostUsd('claude-sonnet-5-5', 3000, 8192)).toBeCloseTo(
      (1000 * 2 + 8192 * 10) / 1_000_000,
      9,
    );
  });
});
