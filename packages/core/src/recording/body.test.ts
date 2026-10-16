import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../json.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  bodyFieldsOf,
  bodyKind,
  decodeBody,
  encodeBody,
  isJsonContentType,
} from './body.js';

describe('isJsonContentType', () => {
  it('accepts application/json and +json suffixes with parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/problem+json')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('encodeBody', () => {
  it('omits an empty body', () => {
    expect(encodeBody(new Uint8Array(0), 'application/json')).toEqual({});
  });

  it('stores JSON parsed', () => {
    expect(encodeBody(Buffer.from('{"a":[1,2]}'), 'application/json; charset=utf-8')).toEqual({
      body: { a: [1, 2] },
    });
  });

  it('falls back to base64 when a JSON content type does not parse', () => {
    const bytes = Buffer.from('{not json');
    expect(encodeBody(bytes, 'application/json')).toEqual({
      body: bytes.toString('base64'),
      encoding: 'base64',
    });
  });

  it('stores other content as base64', () => {
    const bytes = Buffer.from('hello');
    expect(encodeBody(bytes, 'text/plain')).toEqual({ body: 'aGVsbG8=', encoding: 'base64' });
    expect(encodeBody(bytes, undefined)).toEqual({ body: 'aGVsbG8=', encoding: 'base64' });
  });

  it('records only a hash and size over the cap', () => {
    const bytes = Buffer.alloc(11, 'x');
    expect(encodeBody(bytes, 'text/plain', 10)).toEqual({
      truncated: true,
      body_sha256: sha256Hex(bytes),
      body_size: 11,
    });
  });

  it('stores a body exactly at the cap normally', () => {
    const bytes = Buffer.alloc(10, 'x');
    expect(encodeBody(bytes, 'text/plain', 10)).toEqual({
      body: bytes.toString('base64'),
      encoding: 'base64',
    });
  });

  it('defaults the cap to one MiB', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
    const big = Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 'y');
    expect(encodeBody(big, 'text/plain').truncated).toBe(true);
  });
});

describe('bodyKind and decodeBody', () => {
  it('classifies every kind', () => {
    expect(bodyKind({})).toBe('absent');
    expect(bodyKind({ body: { a: 1 } })).toBe('json');
    expect(bodyKind({ body: null })).toBe('json');
    expect(bodyKind({ body: 'aGk=', encoding: 'base64' })).toBe('base64');
    expect(bodyKind({ truncated: true, body_sha256: 'a'.repeat(64), body_size: 5 })).toBe(
      'truncated',
    );
  });

  it('decodes to bytes or null', () => {
    expect(decodeBody({})).toBeNull();
    expect(decodeBody({ truncated: true, body_sha256: 'a'.repeat(64), body_size: 5 })).toBeNull();
    expect(decodeBody({ body: 'aGk=', encoding: 'base64' })?.toString()).toBe('hi');
    expect(decodeBody({ body: { a: 1 } })?.toString()).toBe('{"a":1}');
  });
});

describe('bodyFieldsOf', () => {
  it('copies only the body fields that are present', () => {
    expect(bodyFieldsOf({ status: 200, body: 'x', encoding: 'base64' } as never)).toEqual({
      body: 'x',
      encoding: 'base64',
    });
    expect(bodyFieldsOf({ truncated: true, body_sha256: 'f'.repeat(64), body_size: 9 })).toEqual({
      truncated: true,
      body_sha256: 'f'.repeat(64),
      body_size: 9,
    });
  });
});
