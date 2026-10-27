import { brotliCompressSync, deflateRawSync, deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../json.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  applyContentEncoding,
  bodyFieldsOf,
  bodyKind,
  decodeBody,
  decodeContentEncoding,
  encodeBody,
  isJsonContentType,
  parseContentEncoding,
  truncatedBodyFields,
  wireBody,
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

describe('truncatedBodyFields', () => {
  it('notes the codings it could have undone and nothing for an unknown or absent coding', () => {
    const sha = 'a'.repeat(64);
    expect(truncatedBodyFields(sha, 9)).toEqual({
      truncated: true,
      body_sha256: sha,
      body_size: 9,
    });
    expect(truncatedBodyFields(sha, 9, 'identity')).toEqual({
      truncated: true,
      body_sha256: sha,
      body_size: 9,
    });
    expect(truncatedBodyFields(sha, 9, 'zstd')).toEqual({
      truncated: true,
      body_sha256: sha,
      body_size: 9,
    });
    expect(truncatedBodyFields(sha, 9, 'x-gzip, BR')).toEqual({
      truncated: true,
      body_sha256: sha,
      body_size: 9,
      content_encoding: 'gzip, br',
    });
  });

  it('matches what encodeBody stores for a compressed body over the cap', () => {
    const wire = gzipSync(Buffer.alloc(5000, 'x'));
    expect(encodeBody(wire, 'text/plain', 1000, 'gzip')).toEqual(
      truncatedBodyFields(sha256Hex(wire), wire.length, 'gzip'),
    );
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

describe('content codings', () => {
  const json = Buffer.from('{"a":[1,2]}');

  it('parses the header into codings in the order applied', () => {
    expect(parseContentEncoding(undefined)).toEqual([]);
    expect(parseContentEncoding('identity')).toEqual([]);
    expect(parseContentEncoding('GZIP')).toEqual(['gzip']);
    expect(parseContentEncoding('x-gzip')).toEqual(['gzip']);
    expect(parseContentEncoding('gzip, br')).toEqual(['gzip', 'br']);
    expect(parseContentEncoding('zstd')).toBeNull();
    expect(parseContentEncoding('gzip, compress')).toBeNull();
  });

  it('undoes gzip, deflate, and brotli before storing and notes the coding', () => {
    expect(encodeBody(gzipSync(json), 'application/json', 1024, 'gzip')).toEqual({
      body: { a: [1, 2] },
      content_encoding: 'gzip',
    });
    expect(encodeBody(deflateSync(json), 'application/json', 1024, 'deflate')).toEqual({
      body: { a: [1, 2] },
      content_encoding: 'deflate',
    });
    expect(encodeBody(deflateRawSync(json), 'application/json', 1024, 'deflate')).toEqual({
      body: { a: [1, 2] },
      content_encoding: 'deflate',
    });
    expect(encodeBody(brotliCompressSync(json), 'application/json', 1024, 'br')).toEqual({
      body: { a: [1, 2] },
      content_encoding: 'br',
    });
    expect(encodeBody(gzipSync(Buffer.from('hi')), 'text/plain', 1024, 'X-Gzip')).toEqual({
      body: 'aGk=',
      encoding: 'base64',
      content_encoding: 'gzip',
    });
  });

  it('undoes stacked codings last applied first', () => {
    const stacked = brotliCompressSync(gzipSync(json));
    expect(encodeBody(stacked, 'application/json', 1024, 'gzip, br')).toEqual({
      body: { a: [1, 2] },
      content_encoding: 'gzip, br',
    });
  });

  it('holds only the final decoded size to the cap under stacked codings', () => {
    // The gzip layer inside `gzip, br` is larger than the ten byte cap; the body is not.
    const ten = Buffer.alloc(10, 'x');
    const inner = gzipSync(ten);
    expect(inner.length).toBeGreaterThan(10);
    const wire = brotliCompressSync(inner);
    expect(encodeBody(wire, 'text/plain', 10, 'gzip, br')).toEqual({
      body: ten.toString('base64'),
      encoding: 'base64',
      content_encoding: 'gzip, br',
    });
    expect(encodeBody(wire, 'text/plain', 9, 'gzip, br')).toEqual(
      truncatedBodyFields(sha256Hex(wire), wire.length, 'gzip, br'),
    );
  });

  it('stops an intermediate layer over 16 MiB under a small cap and stores the body as truncated', () => {
    const bomb = Buffer.alloc(16 * 1024 * 1024 + 1);
    const wire = brotliCompressSync(gzipSync(bomb));
    let code: unknown;
    try {
      decodeContentEncoding(wire, ['gzip', 'br'], 10);
    } catch (err) {
      code = (err as { code?: unknown }).code;
    }
    expect(code).toBe('ERR_BUFFER_TOO_LARGE');
    expect(encodeBody(wire, 'text/plain', 10, 'gzip, br')).toEqual(
      truncatedBodyFields(sha256Hex(wire), wire.length, 'gzip, br'),
    );
  });

  it('treats identity as no coding', () => {
    expect(encodeBody(json, 'application/json', 1024, 'identity')).toEqual({ body: { a: [1, 2] } });
  });

  it('keeps the bytes as received, without a note, for an unknown coding or data that does not decode', () => {
    const bytes = Buffer.from('zzz');
    expect(encodeBody(bytes, 'text/plain', 1024, 'zstd')).toEqual({
      body: bytes.toString('base64'),
      encoding: 'base64',
    });
    expect(encodeBody(bytes, 'text/plain', 1024, 'gzip')).toEqual({
      body: bytes.toString('base64'),
      encoding: 'base64',
    });
    expect(encodeBody(bytes, 'text/plain', 1024, 'br')).toEqual({
      body: bytes.toString('base64'),
      encoding: 'base64',
    });
  });

  it('applies the cap to the decoded size and hashes the bytes as received when over it', () => {
    const wire = gzipSync(Buffer.alloc(5000, 'x'));
    expect(wire.length).toBeLessThan(100);
    expect(encodeBody(wire, 'text/plain', 1000, 'gzip')).toEqual({
      truncated: true,
      body_sha256: sha256Hex(wire),
      body_size: wire.length,
      content_encoding: 'gzip',
    });
    expect(encodeBody(wire, 'text/plain', 5000, 'gzip')).toMatchObject({
      encoding: 'base64',
      content_encoding: 'gzip',
    });
  });

  it('stores an empty decoded body as absent', () => {
    expect(encodeBody(gzipSync(Buffer.alloc(0)), 'application/json', 1024, 'gzip')).toEqual({});
  });

  it('re-applies the coding for the wire and not for the stored bytes', () => {
    const fields = encodeBody(gzipSync(json), 'application/json', 1024, 'gzip');
    expect(decodeBody(fields)?.toString()).toBe('{"a":[1,2]}');
    const wire = wireBody(fields) as Buffer;
    expect(gunzipSync(wire).toString()).toBe('{"a":[1,2]}');
    expect(wireBody({ body: { a: 1 } })?.toString()).toBe('{"a":1}');
    expect(
      wireBody({ body: 'aGk=', encoding: 'base64', content_encoding: 'zstd' })?.toString(),
    ).toBe('hi');
    expect(wireBody({})).toBeNull();
    const stacked = applyContentEncoding(json, ['gzip', 'br']);
    expect(encodeBody(stacked, 'application/json', 1024, 'gzip, br').body).toEqual({ a: [1, 2] });
  });
});

describe('bodyFieldsOf', () => {
  it('copies only the body fields that are present', () => {
    expect(bodyFieldsOf({ status: 200, body: 'x', encoding: 'base64' } as never)).toEqual({
      body: 'x',
      encoding: 'base64',
    });
    expect(bodyFieldsOf({ body: { a: 1 }, content_encoding: 'gzip' })).toEqual({
      body: { a: 1 },
      content_encoding: 'gzip',
    });
    expect(bodyFieldsOf({ truncated: true, body_sha256: 'f'.repeat(64), body_size: 9 })).toEqual({
      truncated: true,
      body_sha256: 'f'.repeat(64),
      body_size: 9,
    });
  });
});
