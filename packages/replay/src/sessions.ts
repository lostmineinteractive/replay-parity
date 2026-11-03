import {
  ConfigError,
  canonicalJson,
  get,
  isValidPath,
  parsePath,
  type RecordedRequest,
  type Segment,
} from '@replay-parity/core';

/**
 * Session keys. `--session-key` names where a recorded request carries the
 * session it belongs to: a request header, a cookie, or a JSONPath into the
 * request body. The engine keeps the recorded happens-before order within a
 * session only, so exchanges of different sessions may overlap.
 *
 * Every exchange whose request has no value at the key belongs to one shared
 * session, the no value session, so exchanges the key cannot place keep their
 * recorded order among themselves.
 */
export type SessionKey =
  | { kind: 'header'; name: string; spec: string }
  | { kind: 'cookie'; name: string; spec: string }
  | { kind: 'jsonpath'; path: readonly Segment[]; spec: string };

/** The session of every exchange whose request has no value at the key. */
export const NO_SESSION = '\u0000none';

/** Parses `header:<name>`, `cookie:<name>`, or a JSONPath starting with `$`. */
export function parseSessionKey(spec: string): SessionKey {
  const text = spec.trim();
  if (text.startsWith('header:')) {
    const name = text.slice('header:'.length).trim().toLowerCase();
    if (name.length === 0) throw new ConfigError(`--session-key ${spec}: the header name is empty`);
    return { kind: 'header', name, spec: `header:${name}` };
  }
  if (text.startsWith('cookie:')) {
    const name = text.slice('cookie:'.length).trim();
    if (name.length === 0) throw new ConfigError(`--session-key ${spec}: the cookie name is empty`);
    return { kind: 'cookie', name, spec: `cookie:${name}` };
  }
  if (text.startsWith('$')) {
    if (!isValidPath(text)) {
      throw new ConfigError(`--session-key ${spec}: unsupported JSONPath`);
    }
    return { kind: 'jsonpath', path: parsePath(text), spec: text };
  }
  throw new ConfigError(
    `--session-key ${spec}: expected header:<name>, cookie:<name>, or a JSONPath into the request body`,
  );
}

/** The value of one cookie in a `cookie` header, or undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The session a recorded request belongs to, or `NO_SESSION`. A body value
 * that is not a string is keyed by its canonical JSON, so `1` and `"1"` are
 * one session, which can only add ordering. An empty string is no value.
 */
export function sessionOf(key: SessionKey, request: RecordedRequest): string {
  let value: string | undefined;
  switch (key.kind) {
    case 'header':
      value = request.headers[key.name];
      break;
    case 'cookie':
      value = cookieValue(request.headers.cookie, key.name);
      break;
    case 'jsonpath': {
      if (request.encoding !== undefined) break;
      const found = get(request.body, key.path);
      if (found === undefined || found === null) break;
      value = typeof found === 'string' ? found : canonicalJson(found);
      break;
    }
  }
  return value === undefined || value === '' ? NO_SESSION : `=${value}`;
}
