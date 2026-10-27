import { Buffer } from 'node:buffer';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';
import { sha256Hex, type JsonValue } from '../json.js';

/**
 * Body storage rules. JSON content types are stored parsed. Other content is
 * stored as base64 with `encoding: "base64"`. A body over the size cap is
 * stored as its SHA-256, its size, and `truncated: true`.
 *
 * A body that arrived with a `content-encoding` of gzip, deflate, or br is
 * decoded first and stored by the same rules, with the coding noted in
 * `content_encoding`, so two systems that compress differently compare equal
 * when their decoded bodies are equal. The cap applies to the decoded size.
 * A coding this module cannot undo, or data that does not decode, is stored
 * as the bytes received with no note.
 */

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface BodyFields {
  body?: JsonValue | undefined;
  encoding?: 'base64' | undefined;
  truncated?: true | undefined;
  body_sha256?: string | undefined;
  body_size?: number | undefined;
  /** The content codings undone before the body was stored, in the order they were applied. */
  content_encoding?: string | undefined;
}

export type BodyKind = 'absent' | 'json' | 'base64' | 'truncated';

export type ContentCoding = 'gzip' | 'deflate' | 'br';

const CODINGS: Record<string, ContentCoding> = {
  gzip: 'gzip',
  'x-gzip': 'gzip',
  deflate: 'deflate',
  br: 'br',
};

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

/**
 * Parses a `content-encoding` header into the codings applied, in the order
 * they were applied. An absent header and `identity` give an empty list. A
 * coding this module cannot undo gives null.
 */
export function parseContentEncoding(header: string | undefined): ContentCoding[] | null {
  if (header === undefined) return [];
  const out: ContentCoding[] = [];
  for (const raw of header.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0 || token === 'identity') continue;
    const coding = CODINGS[token];
    if (coding === undefined) return null;
    out.push(coding);
  }
  return out;
}

function isTooLarge(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE';
}

function undo(bytes: Buffer, coding: ContentCoding, maxOutputLength: number): Buffer {
  const options = { maxOutputLength };
  switch (coding) {
    case 'gzip':
      return gunzipSync(bytes, options);
    case 'br':
      return brotliDecompressSync(bytes, options);
    case 'deflate':
      try {
        return inflateSync(bytes, options);
      } catch (err) {
        // Some servers send raw deflate without the zlib wrapper.
        if (isTooLarge(err)) throw err;
        return inflateRawSync(bytes, options);
      }
  }
}

/**
 * Undoes the codings, last applied first. Throws on data that does not
 * decode, and throws an error with code `ERR_BUFFER_TOO_LARGE` when the
 * output would exceed `maxBytes`.
 */
export function decodeContentEncoding(
  bytes: Buffer,
  codings: readonly ContentCoding[],
  maxBytes: number,
): Buffer {
  let out = bytes;
  for (let i = codings.length - 1; i >= 0; i -= 1) {
    out = undo(out, codings[i] as ContentCoding, maxBytes + 1);
  }
  return out;
}

/** Applies the codings in order, so the bytes match what the recorded headers announce. */
export function applyContentEncoding(bytes: Buffer, codings: readonly ContentCoding[]): Buffer {
  let out = bytes;
  for (const coding of codings) {
    switch (coding) {
      case 'gzip':
        out = gzipSync(out);
        break;
      case 'deflate':
        out = deflateSync(out);
        break;
      case 'br':
        out = brotliCompressSync(out);
        break;
    }
  }
  return out;
}

function truncatedFields(wire: Buffer): BodyFields {
  return { truncated: true, body_sha256: sha256Hex(wire), body_size: wire.byteLength };
}

/**
 * The fields for a body stored as its hash and size. The hash and size
 * describe the bytes as received. The codings named by `contentEncoding` are
 * noted when this module could have undone them, which is how `encodeBody`
 * notes a compressed body over the cap. A recorder that hashes while
 * streaming and stops keeping bytes past the cap uses this to store what it
 * saw without holding the body.
 */
export function truncatedBodyFields(
  bodySha256: string,
  bodySize: number,
  contentEncoding?: string,
): BodyFields {
  const fields: BodyFields = { truncated: true, body_sha256: bodySha256, body_size: bodySize };
  const codings = parseContentEncoding(contentEncoding);
  if (codings === null || codings.length === 0) return fields;
  return { ...fields, content_encoding: codings.join(', ') };
}

function storeDecoded(bytes: Buffer, contentType: string | undefined): BodyFields {
  if (bytes.byteLength === 0) return {};
  if (isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as JsonValue;
      return { body: parsed };
    } catch {
      // Fall through and store the raw bytes.
    }
  }
  return { body: bytes.toString('base64'), encoding: 'base64' };
}

function storeAsReceived(
  wire: Buffer,
  contentType: string | undefined,
  maxBytes: number,
): BodyFields {
  if (wire.byteLength > maxBytes) return truncatedFields(wire);
  return storeDecoded(wire, contentType);
}

/**
 * Turns the bytes received into body fields. `contentEncoding` is the value
 * of the `content-encoding` header the bytes arrived with, when any. For a
 * truncated body the hash and size always describe the bytes as received.
 */
export function encodeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  contentEncoding?: string,
): BodyFields {
  if (bytes.byteLength === 0) return {};
  const wire = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codings = parseContentEncoding(contentEncoding);
  if (codings === null || codings.length === 0) {
    return storeAsReceived(wire, contentType, maxBytes);
  }
  const noted = codings.join(', ');
  let decoded: Buffer;
  try {
    decoded = decodeContentEncoding(wire, codings, maxBytes);
  } catch (err) {
    if (isTooLarge(err)) {
      return truncatedBodyFields(sha256Hex(wire), wire.byteLength, contentEncoding);
    }
    return storeAsReceived(wire, contentType, maxBytes);
  }
  if (decoded.byteLength > maxBytes) {
    return truncatedBodyFields(sha256Hex(wire), wire.byteLength, contentEncoding);
  }
  const fields = storeDecoded(decoded, contentType);
  if (fields.body === undefined) return fields;
  return { ...fields, content_encoding: noted };
}

export function bodyKind(fields: BodyFields): BodyKind {
  if (fields.truncated) return 'truncated';
  if (fields.body === undefined) return 'absent';
  if (fields.encoding === 'base64') return 'base64';
  return 'json';
}

/**
 * Returns the stored body as bytes, or `null` when there is nothing. A JSON
 * body is re-serialized, so whitespace from the original is not preserved.
 * Content codings are not re-applied here. See `wireBody`.
 */
export function decodeBody(fields: BodyFields): Buffer | null {
  switch (bodyKind(fields)) {
    case 'absent':
    case 'truncated':
      return null;
    case 'base64':
      return Buffer.from(fields.body as string, 'base64');
    case 'json':
      return Buffer.from(JSON.stringify(fields.body), 'utf8');
  }
}

/**
 * Returns the bytes to put on the wire for a recorded body: the stored body
 * with its `content_encoding` applied again, so the bytes match the recorded
 * `content-encoding` header. `null` when there is nothing to send.
 */
export function wireBody(fields: BodyFields): Buffer | null {
  const bytes = decodeBody(fields);
  if (bytes === null) return null;
  const codings = parseContentEncoding(fields.content_encoding);
  if (codings === null || codings.length === 0) return bytes;
  return applyContentEncoding(bytes, codings);
}

export function bodyFieldsOf<T extends BodyFields>(value: T): BodyFields {
  const out: BodyFields = {};
  if (value.body !== undefined) out.body = value.body;
  if (value.encoding !== undefined) out.encoding = value.encoding;
  if (value.truncated !== undefined) out.truncated = value.truncated;
  if (value.body_sha256 !== undefined) out.body_sha256 = value.body_sha256;
  if (value.body_size !== undefined) out.body_size = value.body_size;
  if (value.content_encoding !== undefined) out.content_encoding = value.content_encoding;
  return out;
}
