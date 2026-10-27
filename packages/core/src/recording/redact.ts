import type { HeaderMap } from '../headers.js';
import type { Query } from './types.js';

export const REDACTED = '<redacted>';

export const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
];

/** Returns a copy of `headers` with the listed names replaced by the redaction marker. */
export function redactHeaders(
  headers: HeaderMap,
  names: readonly string[] = DEFAULT_REDACTED_HEADERS,
): HeaderMap {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    out[key] = set.has(key) ? REDACTED : value;
  }
  return out;
}

/** Query parameter names whose values are replaced by the marker unless a list is given. */
export const DEFAULT_REDACTED_QUERY: readonly string[] = [
  'api_key',
  'apikey',
  'access_token',
  'token',
  'key',
  'secret',
  'signature',
  'password',
];

/**
 * Returns a copy of `query` with the value, or every value, of each listed
 * name replaced by the redaction marker. Names are compared lower cased and
 * the keys keep the case they arrived with.
 */
export function redactQuery(
  query: Query,
  names: readonly string[] = DEFAULT_REDACTED_QUERY,
): Query {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const out: Query = {};
  for (const [name, value] of Object.entries(query)) {
    if (!set.has(name.toLowerCase())) {
      out[name] = value;
    } else if (Array.isArray(value)) {
      out[name] = value.map(() => REDACTED);
    } else {
      out[name] = REDACTED;
    }
  }
  return out;
}

/** Drops headers whose value is the redaction marker. Used before sending a recorded request. */
export function dropRedactedHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== REDACTED) out[name] = value;
  }
  return out;
}
