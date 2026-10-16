import { canonicalJson, isJsonObject, type JsonValue } from '../json.js';

/**
 * A small JSONPath subset.
 *
 * Supported in rule paths: `$`, `.name`, `['name']`, `["name"]`, `[n]`, `[*]`, `.*`.
 * Concrete finding paths may also contain keyed segments such as `[sku=A-100]`
 * produced by unordered array comparison. A wildcard in a rule matches a key,
 * an index, or a keyed segment.
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

function parseBracket(path: string, inner: string): Segment {
  const text = inner.trim();
  if (text === '*') return { type: 'wildcard' };
  if (/^(0|[1-9][0-9]*)$/.test(text)) return { type: 'index', index: Number(text) };
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    if (text.length < 2) throw new JsonPathError(path, 'empty quoted key');
    const body = text.slice(1, -1);
    if (text.startsWith('"')) {
      try {
        return { type: 'key', name: JSON.parse(text) as string };
      } catch {
        throw new JsonPathError(path, `bad quoted key ${text}`);
      }
    }
    return { type: 'key', name: body.replace(/\\(['\\])/g, '$1') };
  }
  const eq = text.indexOf('=');
  if (eq > 0) {
    const name = text.slice(0, eq);
    let value = text.slice(eq + 1);
    let dup = 0;
    const dupMatch = /^(.*)#([1-9][0-9]*)$/.exec(value);
    if (dupMatch) {
      value = dupMatch[1] as string;
      dup = Number(dupMatch[2]);
    }
    return { type: 'keyed', name, value, dup };
  }
  if (text.includes(':')) throw new JsonPathError(path, 'slices are not supported');
  if (text.startsWith('?')) throw new JsonPathError(path, 'filters are not supported');
  throw new JsonPathError(path, `unsupported bracket content ${JSON.stringify(inner)}`);
}

export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    return false;
  }
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
      return `[${segment.name}=${segment.value}${segment.dup > 0 ? `#${segment.dup}` : ''}]`;
  }
}

export function renderPath(segments: readonly Segment[]): string {
  return `$${segments.map(renderSegment).join('')}`;
}

/** Renders a key value for use inside a keyed segment. */
export function keyValueText(value: JsonValue | undefined): string {
  if (typeof value === 'string' && !/[\]=#\s]/.test(value)) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return canonicalJson(value === undefined ? null : value);
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
