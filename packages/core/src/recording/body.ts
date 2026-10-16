import { Buffer } from 'node:buffer';
import { sha256Hex, type JsonValue } from '../json.js';

/**
 * Body storage rules. JSON content types are stored parsed. Other content is
 * stored as base64 with `encoding: "base64"`. A body over the size cap is
 * stored as its SHA-256, its size, and `truncated: true`.
 */

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface BodyFields {
  body?: JsonValue | undefined;
  encoding?: 'base64' | undefined;
  truncated?: true | undefined;
  body_sha256?: string | undefined;
  body_size?: number | undefined;
}

export type BodyKind = 'absent' | 'json' | 'base64' | 'truncated';

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

export function encodeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): BodyFields {
  if (bytes.byteLength === 0) return {};
  if (bytes.byteLength > maxBytes) {
    return { truncated: true, body_sha256: sha256Hex(bytes), body_size: bytes.byteLength };
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(buf.toString('utf8')) as JsonValue;
      return { body: parsed };
    } catch {
      // Fall through and store the raw bytes.
    }
  }
  return { body: buf.toString('base64'), encoding: 'base64' };
}

export function bodyKind(fields: BodyFields): BodyKind {
  if (fields.truncated) return 'truncated';
  if (fields.body === undefined) return 'absent';
  if (fields.encoding === 'base64') return 'base64';
  return 'json';
}

/**
 * Returns the bytes to send for a recorded body, or `null` when there is
 * nothing to send. A JSON body is re-serialized, so whitespace from the
 * original request is not preserved.
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

export function bodyFieldsOf<T extends BodyFields>(value: T): BodyFields {
  const out: BodyFields = {};
  if (value.body !== undefined) out.body = value.body;
  if (value.encoding !== undefined) out.encoding = value.encoding;
  if (value.truncated !== undefined) out.truncated = value.truncated;
  if (value.body_sha256 !== undefined) out.body_sha256 = value.body_sha256;
  if (value.body_size !== undefined) out.body_size = value.body_size;
  return out;
}
