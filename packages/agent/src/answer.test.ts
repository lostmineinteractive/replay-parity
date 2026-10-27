import { GeneratedCaseSchema } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { AnswerSchema, decodeCase } from './answer.js';

const plain = {
  hypothesis: 'h',
  tags: ['create-order'],
  steps: [{ request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 3 } } }],
};

describe('AnswerSchema', () => {
  it('takes the constrained shape and rejects the plain one', () => {
    const wire = {
      cases: [
        {
          hypothesis: 'h',
          tags: ['create-order'],
          steps: [
            {
              request: {
                method: 'POST',
                path: '/v1/orders',
                query: [{ name: 'a', value: '1' }],
                headers: [{ name: 'x-trace', value: 't' }],
                body_json: '{"sku":"A-100"}',
              },
              capture: { name: 'id', path: '$.order_id' },
            },
          ],
          repeat: 3,
        },
      ],
    };
    expect(AnswerSchema.safeParse(wire).success).toBe(true);
    expect(AnswerSchema.safeParse({ cases: [plain] }).success).toBe(false);
    expect(AnswerSchema.safeParse({ cases: [{ ...wire.cases[0], extra: 1 }] }).success).toBe(false);
  });
});

describe('decodeCase', () => {
  it('turns pairs into maps, repeated query names into lists, lower cases header names, and parses body text', () => {
    const decoded = decodeCase({
      hypothesis: 'h',
      tags: ['t'],
      steps: [
        {
          request: {
            method: 'GET',
            path: '/x',
            query: [
              { name: 'f', value: 'a' },
              { name: 'f', value: 'b' },
              { name: 'f', value: 'c' },
              { name: 'g', value: '1' },
            ],
            headers: [
              { name: 'X-One', value: '1' },
              { name: 'x-one', value: '2' },
            ],
            body_json: ' [1, "two", {"three": null}] ',
          },
        },
      ],
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        hypothesis: 'h',
        tags: ['t'],
        steps: [
          {
            request: {
              method: 'GET',
              path: '/x',
              query: { f: ['a', 'b', 'c'], g: '1' },
              headers: { 'x-one': '2' },
              body: [1, 'two', { three: null }],
            },
          },
        ],
      },
    });
  });

  it('leaves a plain answer, an empty body text, and anything that is not a case alone', () => {
    expect(decodeCase(plain)).toEqual({ ok: true, value: plain });
    expect(decodeCase('nope')).toEqual({ ok: true, value: 'nope' });
    expect(decodeCase({ steps: 'nope' })).toEqual({ ok: true, value: { steps: 'nope' } });
    expect(decodeCase({ steps: [1, { request: 2 }] })).toEqual({
      ok: true,
      value: { steps: [1, { request: 2 }] },
    });
    const empty = decodeCase({
      ...plain,
      steps: [{ request: { method: 'GET', path: '/x', body_json: '  ' } }],
    });
    expect(empty).toEqual({
      ok: true,
      value: { ...plain, steps: [{ request: { method: 'GET', path: '/x' } }] },
    });
  });

  it('names the step and the field when the encoding is wrong', () => {
    const step = (request: Record<string, unknown>) => ({
      ...plain,
      steps: [{ request: { method: 'GET', path: '/x' } }, { request }],
    });
    expect(decodeCase(step({ method: 'GET', path: '/y', query: [{ name: 'a' }] }))).toEqual({
      ok: false,
      reason: 'step 2 query must be a list of {name, value} pairs',
    });
    expect(
      decodeCase(step({ method: 'GET', path: '/y', query: [{ name: '', value: '' }] })),
    ).toEqual({ ok: false, reason: 'step 2 query must be a list of {name, value} pairs' });
    expect(decodeCase(step({ method: 'GET', path: '/y', headers: ['a: b'] }))).toEqual({
      ok: false,
      reason: 'step 2 headers must be a list of {name, value} pairs',
    });
    expect(decodeCase(step({ method: 'GET', path: '/y', body_json: 7 }))).toEqual({
      ok: false,
      reason: 'step 2 body_json must be a string of JSON text',
    });
    expect(decodeCase(step({ method: 'GET', path: '/y', body_json: '{', body: 1 }))).toEqual({
      ok: false,
      reason: 'step 2 has both body and body_json',
    });
    const bad = decodeCase(step({ method: 'GET', path: '/y', body_json: '{' }));
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toContain('step 2 body_json is not valid JSON');
  });

  it('round trips every constrained answer into the case schema', () => {
    const wire = {
      hypothesis: 'h',
      tags: ['t'],
      steps: [
        {
          request: { method: 'POST', path: '/v1/orders', body_json: '{"sku":"A-100","qty":3}' },
          capture: { name: 'id', path: '$.order_id' },
        },
        { request: { method: 'GET', path: '/v1/orders/{{id}}' } },
      ],
    };
    expect(AnswerSchema.safeParse({ cases: [wire] }).success).toBe(true);
    const decoded = decodeCase(wire) as { value: unknown };
    const parsed = GeneratedCaseSchema.safeParse(decoded.value);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.steps[0]?.request.body).toEqual({ sku: 'A-100', qty: 3 });
    expect(parsed.data?.steps[0]?.request.query).toEqual({});
    expect(parsed.data?.repeat).toBe(1);
  });
});
