import { canonicalJson, isJsonObject, type JsonValue } from '../json.js';

/**
 * A small JSONPath subset.
 *
 * Supported in rule paths: `$`, `.name`, `['name']`, `["name"]`, `[n]`, `[*]`, `.*`.
 * Concrete finding paths may also contain keyed segments produced by unordered
 * array comparison. A keyed segment is `[name=value]`, with `#n` before the
 * closing bracket for the nth later row that has the same key, as in
 * `[sku=A-100]` and `[sku=A-100#1]`. The name is bare when it is an identifier
 * and a JSON string otherwise, as in `["a b"=X]`. The value is the key text
 * from `keyValueText`, in one of three forms: bare for a plain token such as
 * `A-100` or `42`, a JSON string in double quotes for any other string, as in
 * `[sku="it's"]`, and the canonical JSON of an array or object in single
 * quotes, as in `[sku='[1,2]']`. A row without the key carries `#` and the
 * row's canonical JSON in single quotes, as in `[sku=#'{"qty":3}']`. The `#n`
 * suffix is always outside the quotes. The parser returns the value text as
 * written, so `parsePath(renderPath(segments))` gives the segments back for
 * every keyed segment the differ produces. A wildcard in a rule matches a
 * key, an index, or a keyed segment.
 */

export type Segment =
  | { type: 'key'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'keyed'; name: string; value: string; dup: number };

export class JsonPathError extends Error {
  constructor(path: string, message: string) {
    super(`invalid JSONPath ${JSON.stringify(path)}: ${message}`);
    this.name = 'JsonPathError';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
/** A string key that renders bare: letters, digits, `_`, `$`, and `-`. */
const BARE_VALUE = /^[A-Za-z0-9_$-]+$/;
/** What a bare key value may hold when read back: the characters of plain tokens and JSON numbers. */
const BARE_TOKEN = /^[A-Za-z0-9_$.+-]+$/;
const cache = new Map<string, Segment[]>();

export function parsePath(path: string): Segment[] {
  const cached = cache.get(path);
  if (cached) return cached;
  const segments = parseUncached(path);
  cache.set(path, segments);
  return segments;
}

function parseUncached(path: string): Segment[] {
  if (!path.startsWith('$')) {
    throw new JsonPathError(path, 'must start with $');
  }
  const segments: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i] as string;
    if (ch === '.') {
      i += 1;
      if (path[i] === '.') throw new JsonPathError(path, 'recursive descent is not supported');
      if (path[i] === '*') {
        segments.push({ type: 'wildcard' });
        i += 1;
        continue;
      }
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j += 1;
      const name = path.slice(i, j);
      if (!IDENT.test(name)) {
        throw new JsonPathError(path, `bad key ${JSON.stringify(name)} after "."`);
      }
      segments.push({ type: 'key', name });
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = findClosingBracket(path, i);
      if (close < 0) throw new JsonPathError(path, 'missing "]"');
      const inner = path.slice(i + 1, close);
      segments.push(parseBracket(path, inner));
      i = close + 1;
      continue;
    }
    throw new JsonPathError(path, `unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return segments;
}

function findClosingBracket(path: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < path.length; i += 1) {
    const ch = path[i] as string;
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ']') {
      return i;
    }
  }
  return -1;
}

/** Returns the index of the quote mark that closes the one at `start`. */
function quoteEnd(path: string, text: string, start: number): number {
  const quote = text[start] as string;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === quote) {
      return i;
    }
  }
  throw new JsonPathError(path, `unterminated quote in ${JSON.stringify(text)}`);
}

/** Decodes a quoted name: a JSON string in double quotes, or `\'` and `\\` escapes in single quotes. */
function unquote(path: string, quoted: string): string {
  if (quoted.startsWith('"')) {
    try {
      return JSON.parse(quoted) as string;
    } catch {
      throw new JsonPathError(path, `bad quoted key ${quoted}`);
    }
  }
  return quoted.slice(1, -1).replace(/\\(['\\])/g, '$1');
}

function parseBracket(path: string, inner: string): Segment {
  const text = inner.trim();
  if (text === '*') return { type: 'wildcard' };
  if (/^(0|[1-9][0-9]*)$/.test(text)) return { type: 'index', index: Number(text) };
  if (text.startsWith("'") || text.startsWith('"')) {
    const end = quoteEnd(path, text, 0) + 1;
    const name = unquote(path, text.slice(0, end));
    const rest = text.slice(end);
    if (rest.length === 0) return { type: 'key', name };
    if (!rest.startsWith('=')) {
      throw new JsonPathError(path, `unexpected text ${JSON.stringify(rest)} after a quoted key`);
    }
    return parseKeyed(path, name, rest.slice(1));
  }
  const eq = text.indexOf('=');
  if (eq > 0) {
    const name = text.slice(0, eq);
    if (!IDENT.test(name))
      throw new JsonPathError(path, `bad key ${JSON.stringify(name)} before "="`);
    return parseKeyed(path, name, text.slice(eq + 1));
  }
  if (text.includes(':')) throw new JsonPathError(path, 'slices are not supported');
  if (text.startsWith('?')) throw new JsonPathError(path, 'filters are not supported');
  throw new JsonPathError(path, `unsupported bracket content ${JSON.stringify(inner)}`);
}

/** Checks that a quoted key value decodes: a JSON string in double quotes, or canonical JSON in single quotes. */
function checkQuotedValue(path: string, quoted: string): void {
  try {
    JSON.parse(quoted.startsWith('"') ? quoted : unquote(path, quoted));
  } catch {
    throw new JsonPathError(path, `bad quoted key value ${quoted}`);
  }
}

/**
 * Parses what follows `=` in a keyed segment: a bare token, a JSON string in
 * double quotes, canonical JSON in single quotes, or `#` and canonical JSON in
 * single quotes for a row without the key, then an optional `#n`.
 */
function parseKeyed(path: string, name: string, rest: string): Segment {
  const start = rest.startsWith('#') ? 1 : 0;
  let end: number;
  if (rest[start] === "'" || (start === 0 && rest[start] === '"')) {
    end = quoteEnd(path, rest, start) + 1;
    checkQuotedValue(path, rest.slice(start, end));
  } else if (start === 1) {
    throw new JsonPathError(
      path,
      `a row without the key needs its JSON in single quotes after "#"`,
    );
  } else {
    const hash = rest.indexOf('#');
    end = hash === -1 ? rest.length : hash;
    if (!BARE_TOKEN.test(rest.slice(0, end))) {
      throw new JsonPathError(path, `bad key value ${JSON.stringify(rest.slice(0, end))}`);
    }
  }
  const value = rest.slice(0, end);
  const suffix = rest.slice(end);
  let dup = 0;
  if (suffix.length > 0) {
    const match = /^#([1-9][0-9]*)$/.exec(suffix);
    if (!match) throw new JsonPathError(path, `bad duplicate suffix ${JSON.stringify(suffix)}`);
    dup = Number(match[1]);
  }
  return { type: 'keyed', name, value, dup };
}

export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    return false;
  }
}

function renderName(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

export function renderSegment(segment: Segment): string {
  switch (segment.type) {
    case 'key':
      return IDENT.test(segment.name) ? `.${segment.name}` : `[${JSON.stringify(segment.name)}]`;
    case 'index':
      return `[${segment.index}]`;
    case 'wildcard':
      return '[*]';
    case 'keyed':
      return `[${renderName(segment.name)}=${segment.value}${segment.dup > 0 ? `#${segment.dup}` : ''}]`;
  }
}

export function renderPath(segments: readonly Segment[]): string {
  return `$${segments.map(renderSegment).join('')}`;
}

/** Wraps canonical JSON in single quotes, with `\` and `'` escaped as `\\` and `\'`. */
function quoteJson(text: string): string {
  return `'${text.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
}

/**
 * Renders a key value as the text of a keyed segment. A string made of
 * letters, digits, `_`, `$`, and `-` renders bare, so `A-100` stays `A-100`,
 * and any other string renders as a JSON string in double quotes. A number,
 * a boolean, and null render as their JSON text. An array or an object
 * renders as its canonical JSON in single quotes, so the array `[1,2]` and
 * the string `[1,2]` read differently.
 */
export function keyValueText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return BARE_VALUE.test(value) ? value : JSON.stringify(value);
  if (value === undefined || value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  return quoteJson(canonicalJson(value));
}

/** The key text of a row that lacks the key: `#` and the row's canonical JSON in single quotes. */
export function rowKeyText(row: JsonValue): string {
  return `#${quoteJson(canonicalJson(row))}`;
}

export interface Match {
  path: string;
  segments: Segment[];
  value: JsonValue;
}

/** Returns every value reached by `path` together with its concrete path. */
export function select(doc: JsonValue | undefined, path: string | readonly Segment[]): Match[] {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  const out: Match[] = [];
  if (doc === undefined) return out;
  walk(doc, segments, 0, [], out);
  return out;
}

function walk(
  value: JsonValue,
  segments: readonly Segment[],
  depth: number,
  concrete: Segment[],
  out: Match[],
): void {
  if (depth === segments.length) {
    out.push({ path: renderPath(concrete), segments: [...concrete], value });
    return;
  }
  const segment = segments[depth] as Segment;
  switch (segment.type) {
    case 'key':
      if (isJsonObject(value) && Object.hasOwn(value, segment.name)) {
        walk(value[segment.name] as JsonValue, segments, depth + 1, [...concrete, segment], out);
      }
      return;
    case 'index':
      if (Array.isArray(value) && segment.index < value.length) {
        walk(value[segment.index] as JsonValue, segments, depth + 1, [...concrete, segment], out);
      }
      return;
    case 'wildcard':
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          walk(item, segments, depth + 1, [...concrete, { type: 'index', index }], out),
        );
      } else if (isJsonObject(value)) {
        for (const name of Object.keys(value).sort()) {
          walk(
            value[name] as JsonValue,
            segments,
            depth + 1,
            [...concrete, { type: 'key', name }],
            out,
          );
        }
      }
      return;
    case 'keyed':
      // Keyed segments only appear in concrete paths and are not evaluated against documents.
      return;
  }
}

/** Returns the first value reached by `path`, or `undefined`. */
export function get(
  doc: JsonValue | undefined,
  path: string | readonly Segment[],
): JsonValue | undefined {
  return select(doc, path)[0]?.value;
}

/** Tests whether a rule path (which may hold wildcards) matches a concrete path. */
export function matches(
  rule: string | readonly Segment[],
  concrete: string | readonly Segment[],
): boolean {
  const r = typeof rule === 'string' ? parsePath(rule) : rule;
  const c = typeof concrete === 'string' ? parsePath(concrete) : concrete;
  if (r.length !== c.length) return false;
  for (let i = 0; i < r.length; i += 1) {
    if (!segmentMatches(r[i] as Segment, c[i] as Segment)) return false;
  }
  return true;
}

function segmentMatches(rule: Segment, concrete: Segment): boolean {
  if (rule.type === 'wildcard') return true;
  if (rule.type === 'key') return concrete.type === 'key' && concrete.name === rule.name;
  if (rule.type === 'index') return concrete.type === 'index' && concrete.index === rule.index;
  return (
    concrete.type === 'keyed' &&
    concrete.name === rule.name &&
    concrete.value === rule.value &&
    concrete.dup === rule.dup
  );
}
