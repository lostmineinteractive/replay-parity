import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeBody, sha256Hex } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { CappedBody } from './capped-body.js';

function feed(bytes: Buffer, cap: number, chunkSize: number): CappedBody {
  const body = new CappedBody(cap);
  for (let i = 0; i < bytes.length; i += chunkSize) body.push(bytes.subarray(i, i + chunkSize));
  return body;
}

describe('CappedBody', () => {
  it('stores nothing for an empty body', () => {
    const body = new CappedBody(10);
    expect(body.size).toBe(0);
    expect(body.overCap).toBe(false);
    expect(body.fields('application/json', undefined)).toEqual({});
  });

  it('stores a body within the cap exactly as encodeBody does', () => {
    const json = Buffer.from('{"a":[1,2,3]}');
    expect(feed(json, 1024, 4).fields('application/json', undefined)).toEqual({
      body: { a: [1, 2, 3] },
    });
    const text = Buffer.from('hello there');
    expect(feed(text, text.length, 3).fields('text/plain', undefined)).toEqual(
      encodeBody(text, 'text/plain', text.length),
    );
    const wire = gzipSync('{"a":1}');
    expect(feed(wire, 1024, 5).fields('application/json', 'gzip')).toEqual({
      body: { a: 1 },
      content_encoding: 'gzip',
    });
  });

  it('keeps the hash and size of every byte and drops the chunks past the cap', () => {
    const bytes = randomBytes(300);
    const body = feed(bytes, 100, 30);
    expect(body.size).toBe(300);
    expect(body.overCap).toBe(true);
    expect(body.fields('text/plain', undefined)).toEqual({
      truncated: true,
      body_sha256: sha256Hex(bytes),
      body_size: 300,
    });
  });

  it('drops the chunks on the chunk that crosses the cap and keeps one exactly at it', () => {
    const bytes = Buffer.alloc(101, 'x');
    const body = new CappedBody(100);
    body.push(bytes.subarray(0, 60));
    expect(body.overCap).toBe(false);
    body.push(bytes.subarray(60));
    expect(body.overCap).toBe(true);
    expect(body.fields('text/plain', undefined)).toEqual(encodeBody(bytes, 'text/plain', 100));
    const exact = feed(Buffer.alloc(100, 'y'), 100, 7);
    expect(exact.overCap).toBe(false);
    expect(exact.fields('text/plain', undefined).encoding).toBe('base64');
  });

  it('notes the codings for a compressed body over the wire cap', () => {
    const wire = gzipSync(randomBytes(3000));
    expect(wire.length).toBeGreaterThan(1000);
    expect(feed(wire, 1000, 100).fields('application/octet-stream', 'gzip')).toEqual({
      truncated: true,
      body_sha256: sha256Hex(wire),
      body_size: wire.length,
      content_encoding: 'gzip',
    });
    expect(feed(wire, 1000, 100).fields('application/octet-stream', 'zstd')).toEqual({
      truncated: true,
      body_sha256: sha256Hex(wire),
      body_size: wire.length,
    });
  });

  it('applies the decoded cap to a compressed body within the wire cap', () => {
    const wire = gzipSync(Buffer.alloc(5000, 'x'));
    expect(wire.length).toBeLessThan(100);
    expect(feed(wire, 1000, 10).fields('text/plain', 'gzip')).toEqual({
      truncated: true,
      body_sha256: sha256Hex(wire),
      body_size: wire.length,
      content_encoding: 'gzip',
    });
  });
});
