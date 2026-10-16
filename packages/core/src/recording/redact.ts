import type { HeaderMap } from '../headers.js';

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

/** Drops headers whose value is the redaction marker. Used before sending a recorded request. */
export function dropRedactedHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== REDACTED) out[name] = value;
  }
  return out;
}
