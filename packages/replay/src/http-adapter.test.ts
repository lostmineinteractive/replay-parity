import { REDACTED } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { outgoingHeaders, pathWithQuery } from './http-adapter.js';

describe('pathWithQuery', () => {
  it('appends recorded query values, repeating arrays', () => {
    expect(pathWithQuery('/v1/items', {})).toBe('/v1/items');
    expect(pathWithQuery('/v1/items', { a: '1', b: ['x', 'y z'] })).toBe('/v1/items?a=1&b=x&b=y+z');
    expect(pathWithQuery('/v1/items?k=v', { a: '1' })).toBe('/v1/items?k=v&a=1');
  });
});

describe('outgoingHeaders', () => {
  it('drops hop by hop headers, host, content length, and redacted values', () => {
    expect(
      outgoingHeaders({
        Host: 'ref:3000',
        'content-length': '12',
        connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        authorization: REDACTED,
        'x-trace': 'abc',
        'Content-Type': 'application/json',
      }),
    ).toEqual({ 'x-trace': 'abc', 'content-type': 'application/json' });
  });
});
