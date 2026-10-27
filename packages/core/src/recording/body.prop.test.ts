import { Buffer } from 'node:buffer';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepEqual, sha256Hex, type JsonValue } from '../json.js';
import {
  bodyKind,
  decodeBody,
  decodeContentEncoding,
  encodeBody,
  parseContentEncoding,
  wireBody,
  type BodyFields,
  type ContentCoding,
} from './body.js';

/**
 * Property based tests for body storage. Fixed seed, see
 * ../differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

const KEYS = ['a', 'b', 'items', 'a b', '', 'ü'];
const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1000, max: 1000 }),
  fc
    .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
    .map((x) => (x === 0 ? 0 : x)),
  fc.string({ unit: 'grapheme', maxLength: 6 }),
);
const { value: jsonValue } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}));

const jsonContentType = fc.constantFrom(
  'application/json',
  'application/json; charset=utf-8',
  'Application/JSON',
  'application/problem+json',
);
const otherContentType = fc.constantFrom('text/plain', 'application/octet-stream', undefined);
const anyContentType = fc.oneof(jsonContentType, otherContentType);

const bytesArb = fc.uint8Array({ maxLength: 96 }).map((b) => Buffer.from(b));
const nonEmptyBytes = fc.uint8Array({ minLength: 1, maxLength: 96 }).map((b) => Buffer.from(b));

type Coding = 'gzip' | 'deflate' | 'br' | 'gzip, br';
const codingArb = fc.constantFrom<Coding>('gzip', 'deflate', 'br', 'gzip, br');

function encode(bytes: Buffer, coding: Coding): Buffer {
  switch (coding) {
    case 'gzip':
      return gzipSync(bytes);
    case 'deflate':
      return deflateSync(bytes);
    case 'br':
      return brotliCompressSync(bytes);
    case 'gzip, br':
      return brotliCompressSync(gzipSync(bytes));
  }
}

function withoutNote(fields: BodyFields): BodyFields {
  const { content_encoding: _note, ...rest } = fields;
  return rest;
}

describe('encodeBody and decodeBody properties', () => {
  it('round trips any JSON body within the cap', () => {
    fc.assert(
      fc.property(jsonValue, jsonContentType, fc.nat({ max: 32 }), (value, contentType, slack) => {
        const bytes = Buffer.from(JSON.stringify(value), 'utf8');
        const fields = encodeBody(bytes, contentType, bytes.byteLength + slack);
        expect(bodyKind(fields)).toBe('json');
        expect(fields.encoding).toBeUndefined();
        const back = decodeBody(fields);
        expect(back).not.toBeNull();
        expect(deepEqual(JSON.parse((back as Buffer).toString('utf8')) as JsonValue, value)).toBe(
          true,
        );
      }),
      params,
    );
  });

  it('round trips any non empty bytes under a non JSON content type through base64', () => {
    fc.assert(
      fc.property(
        nonEmptyBytes,
        otherContentType,
        fc.nat({ max: 32 }),
        (bytes, contentType, slack) => {
          const fields = encodeBody(bytes, contentType, bytes.byteLength + slack);
          expect(bodyKind(fields)).toBe('base64');
          expect(decodeBody(fields)).toEqual(bytes);
          expect(wireBody(fields)).toEqual(bytes);
        },
      ),
      params,
    );
  });

  it('stores empty bytes as absent regardless of content type and coding', () => {
    fc.assert(
      fc.property(
        anyContentType,
        fc.option(codingArb, { nil: undefined }),
        (contentType, coding) => {
          const empty = Buffer.alloc(0);
          const wire = coding === undefined ? empty : encode(empty, coding);
          expect(encodeBody(wire, contentType, 1024, coding)).toEqual({});
        },
      ),
      params,
    );
  });

  it('a coded body stores the same body as the plain bytes, with the coding noted', () => {
    fc.assert(
      fc.property(
        bytesArb,
        anyContentType,
        codingArb,
        fc.nat({ max: 32 }),
        (bytes, contentType, coding, slack) => {
          // The cap applies to the decoded size only, so a stacked coding needs no room
          // for its inner layer: the cap may sit exactly at the byte length.
          const cap = bytes.byteLength + slack;
          const plain = encodeBody(bytes, contentType, cap);
          const coded = encodeBody(encode(bytes, coding), contentType, cap, coding);
          expect(withoutNote(coded)).toEqual(plain);
          expect(coded.content_encoding).toBe(plain.body === undefined ? undefined : coding);
          if (coded.body !== undefined) {
            // The wire form carries the coding again and undoes to the stored bytes.
            const codings = parseContentEncoding(coding) as ContentCoding[];
            const wire = wireBody(coded) as Buffer;
            expect(decodeContentEncoding(wire, codings, cap)).toEqual(decodeBody(coded));
          }
        },
      ),
      params,
    );
  });

  it('a stacked coding stores the same body as a single coding at the same cap', () => {
    // decodeContentEncoding once bounded every layer by the cap, not only the final
    // decoded size, so a stacked coding whose inner layer was larger than the cap was
    // truncated although the decoded body fit. Exact input: ten bytes of "x" with cap 10.
    // Under `gzip` the body was stored; under `gzip, br` the result was truncated with
    // the hash of the 27 wire bytes. The seeded property found it with empty bytes and
    // cap 16. Only the final layer is held to the cap now.
    const ten = Buffer.alloc(10, 'x');
    const single = encodeBody(gzipSync(ten), 'text/plain', 10, 'gzip');
    const stacked = encodeBody(brotliCompressSync(gzipSync(ten)), 'text/plain', 10, 'gzip, br');
    expect(single.truncated).toBeUndefined();
    expect(withoutNote(stacked)).toEqual(withoutNote(single));
  });

  it('a body over the cap is truncated with the hash and size of the bytes received', () => {
    const cases = nonEmptyBytes.chain((bytes) =>
      fc.tuple(fc.constant(bytes), fc.nat({ max: bytes.byteLength - 1 })),
    );
    fc.assert(
      fc.property(cases, anyContentType, ([bytes, cap], contentType) => {
        expect(encodeBody(bytes, contentType, cap)).toEqual({
          truncated: true,
          body_sha256: sha256Hex(bytes),
          body_size: bytes.byteLength,
        });
      }),
      params,
    );
  });

  it('a coded body whose decoded size is over the cap is truncated with the hash and size of the wire bytes', () => {
    const cases = nonEmptyBytes.chain((bytes) =>
      fc.tuple(fc.constant(bytes), fc.nat({ max: bytes.byteLength - 1 })),
    );
    fc.assert(
      fc.property(cases, anyContentType, codingArb, ([bytes, cap], contentType, coding) => {
        const wire = encode(bytes, coding);
        expect(encodeBody(wire, contentType, cap, coding)).toEqual({
          truncated: true,
          body_sha256: sha256Hex(wire),
          body_size: wire.byteLength,
          content_encoding: coding,
        });
      }),
      params,
    );
  });
});
