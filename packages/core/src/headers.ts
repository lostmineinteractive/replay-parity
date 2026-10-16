/**
 * Header helpers. Header names are lower cased everywhere in this project.
 */

export type HeaderMap = Record<string, string>;

export class HeaderParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderParseError';
  }
}

/** Parses one `name: value` line. The name is lower cased and both sides are trimmed. */
export function parseHeaderLine(line: string): [string, string] {
  const idx = line.indexOf(':');
  if (idx <= 0) {
    throw new HeaderParseError(`expected "name: value", got ${JSON.stringify(line)}`);
  }
  const name = line.slice(0, idx).trim().toLowerCase();
  const value = line.slice(idx + 1).trim();
  if (name.length === 0) {
    throw new HeaderParseError(`empty header name in ${JSON.stringify(line)}`);
  }
  return [name, value];
}

/**
 * Parses a headers file. One `name: value` per line. Blank lines and lines
 * starting with `#` are skipped.
 */
export function parseHeadersText(text: string): HeaderMap {
  const out: HeaderMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const [name, value] = parseHeaderLine(line);
    out[name] = value;
  }
  return out;
}

/** Converts a Node style header object to a lower cased string map. */
export function normalizeHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (Array.isArray(value)) {
      out[key] = value.join(', ');
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/** Returns `base` with every entry of `overrides` applied. Keys are lower cased. */
export function mergeHeaders(base: HeaderMap, overrides: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(base)) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(overrides)) out[k.toLowerCase()] = v;
  return out;
}
