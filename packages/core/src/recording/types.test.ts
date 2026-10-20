import { describe, expect, it } from 'vitest';
import { ExchangeSchema, RecordedRequestSchema, RecordedResponseSchema } from './types.js';

const specExample = {
  id: '01JA9W2S5Y8R7Q6P5N4M3K2J1H',
  ts: '2026-10-16T18:22:03.123Z',
  offset_ms: 1234,
  adapter: 'http',
  request: {
    method: 'POST',
    path: '/v1/orders',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: { sku: 'A-100', qty: 3 },
  },
  response: {
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: { order_id: 'o-1', total: 29.97, items: [{ sku: 'A-100', qty: 3 }] },
    latency_ms: 12.4,
  },
  tags: ['create-order'],
};

describe('ExchangeSchema', () => {
  it('accepts the example from the spec', () => {
    expect(ExchangeSchema.parse(specExample)).toEqual(specExample);
  });

  it('defaults query, headers, and tags', () => {
    const parsed = ExchangeSchema.parse({
      ...specExample,
      request: { method: 'GET', path: '/x' },
      response: { status: 204, latency_ms: 1 },
      tags: undefined,
    });
    expect(parsed.request.query).toEqual({});
    expect(parsed.request.headers).toEqual({});
    expect(parsed.response.headers).toEqual({});
    expect(parsed.tags).toEqual([]);
  });

  it('rejects unknown keys and bad values', () => {
    expect(ExchangeSchema.safeParse({ ...specExample, extra: 1 }).success).toBe(false);
    expect(ExchangeSchema.safeParse({ ...specExample, ts: 'yesterday' }).success).toBe(false);
    expect(ExchangeSchema.safeParse({ ...specExample, offset_ms: -1 }).success).toBe(false);
    expect(
      ExchangeSchema.safeParse({ ...specExample, request: { ...specExample.request, path: 'v1' } })
        .success,
    ).toBe(false);
  });
});

describe('body refinements', () => {
  it('accepts base64 and truncated shapes', () => {
    expect(
      RecordedResponseSchema.safeParse({
        status: 200,
        latency_ms: 1,
        body: 'aGk=',
        encoding: 'base64',
      }).success,
    ).toBe(true);
    expect(
      RecordedRequestSchema.safeParse({
        method: 'POST',
        path: '/x',
        truncated: true,
        body_sha256: 'a'.repeat(64),
        body_size: 2_000_000,
      }).success,
    ).toBe(true);
  });

  it('accepts a content coding note with a body or a truncated body, and rejects it alone', () => {
    expect(
      RecordedResponseSchema.safeParse({
        status: 200,
        latency_ms: 1,
        body: { a: 1 },
        content_encoding: 'gzip',
      }).success,
    ).toBe(true);
    expect(
      RecordedResponseSchema.safeParse({
        status: 200,
        latency_ms: 1,
        truncated: true,
        body_sha256: 'a'.repeat(64),
        body_size: 9,
        content_encoding: 'br',
      }).success,
    ).toBe(true);
    expect(
      RecordedResponseSchema.safeParse({ status: 200, latency_ms: 1, content_encoding: 'gzip' })
        .success,
    ).toBe(false);
  });

  it('rejects inconsistent body fields', () => {
    expect(
      RecordedResponseSchema.safeParse({
        status: 200,
        latency_ms: 1,
        body: { a: 1 },
        encoding: 'base64',
      }).success,
    ).toBe(false);
    expect(
      RecordedResponseSchema.safeParse({ status: 200, latency_ms: 1, encoding: 'base64' }).success,
    ).toBe(false);
    expect(
      RecordedResponseSchema.safeParse({ status: 200, latency_ms: 1, truncated: true }).success,
    ).toBe(false);
    expect(
      RecordedResponseSchema.safeParse({
        status: 200,
        latency_ms: 1,
        truncated: true,
        body: 'x',
        body_sha256: 'a'.repeat(64),
        body_size: 1,
      }).success,
    ).toBe(false);
  });
});
