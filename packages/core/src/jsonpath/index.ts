import { canonicalJson, isJsonObject, type JsonValue } from '../json.js';

/**
 * A small JSONPath subset.
 *
 * Supported in rule paths: `$`, `.name`, `['name']`, `["name"]`, `[n]`, `[*]`, `.*`,
 * a filter, and recursive descent. A filter is `[?(@.name=='text')]` or
 * `[?(@.name!=1)]`: it selects the elements of an array whose child `name`
 * equals, or differs from, a string or number literal. The child may be
 * written `@.name` or `@['name']`, the literal is a string in single or
 * double quotes or a JSON number, and spaces around the operator are
 * allowed. Under `!=` an element without the child, or one that is not an
 * object, matches. Recursive descent is `..name`, `..['name']`, `..[n]`, or
 * `..[*]`: it matches the segment that follows at the current depth and at
 * every depth below. Both forms are evaluated by `select` and by `matchesIn`;
 * `matches` handles descent on its own and treats a filter as not matching,
 * because a filter needs the document.
 *
 * Concrete finding paths may also contain keyed segments produced by unordered
 * array comparison. A keyed segment is `[name=value]`, with `#n` before the
 * closing bracket for the nth later row that has the same key, as in
 * `[sku=A-100]` and `[sku=A-100#1]`. The name is bare when it is an identifier
 * and a JSON string otherwise, as in `["a b"=X]`. The value is the key text
 * from `keyValueText`, in one of three forms: bare for a string that is an
 * identifier such as `A-100` and for a number, `true`, `false`, or `null`, a
 * JSON string in double quotes for any other string, as in `[sku="it's"]` and
 * `[sku="1"]` for the string `1`, and the canonical JSON of an array or object
 * in single quotes, as in `[sku='[1,2]']`. A row without the key carries `#` and the
 * row's canonical JSON in single quotes, as in `[sku=#'{"qty":3}']`. The `#n`
 * suffix is always outside the quotes. The parser returns the value text as
 * written, so `parsePath(renderPath(segments))` gives the segments back for
 * every keyed segment the differ produces. A wildcard in a rule matches a
 * key, an index, or a keyed segment. A filter matches an index or a keyed
 * segment whose element satisfies the predicate.
 */

export type FilterOp = '==' | '!=';

export type Segment =
  | { type: 'key'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'keyed'; name: string; value: string; dup: number }
  | { type: 'filter'; key: string; op: FilterOp; literal: string | number }
  | { type: 'descent' };

export class JsonPathError extends Error {
  constructor(path: string, message: string) {
    super(`invalid JSONPath ${JSON.stringify(path)}: ${message}`);
    this.name = 'JsonPathError';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
/** The JSON words a bare string key could be mistaken for. */
const JSON_WORDS = new Set(['true', 'false', 'null']);
/** What a bare key value may hold when read back: the characters of plain tokens and JSON numbers. */
const BARE_TOKEN = /^[A-Za-z0-9_$.+-]+$/;
const QUOTED = `'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"`;
const NUMBER = `-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?`;
/** `?(@.name op literal)` with the child as a dotted identifier or a quoted bracket name. */
const FILTER = new RegExp(
  `^\\?\\(\\s*@(?:\\.([A-Za-z_$][A-Za-z0-9_$-]*)|\\[\\s*(${QUOTED})\\s*\\])\\s*(==|!=)\\s*(${QUOTED}|${NUMBER})\\s*\\)$`,
);
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
      if (path[i] === '.') {
        segments.push({ type: 'descent' });
        i += 1;
        if (i >= path.length) {
          throw new JsonPathError(path, 'recursive descent needs a name or a bracket after ".."');
        }
        if (path[i] === '[') continue;
      }
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

/** The `]` that closes the `[` at `open`. Quoted text is skipped, and a filter may nest a bracket name. */
function findClosingBracket(path: string, open: number): number {
  const filter = path[open + 1] === '?';
  let quote: string | null = null;
  let depth = 0;
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
    } else if (ch === '[' && filter) {
      depth += 1;
    } else if (ch === ']') {
      if (depth === 0) return i;
      depth -= 1;
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
  if (text.startsWith('?')) return parseFilter(path, text);
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
  throw new JsonPathError(path, `unsupported bracket content ${JSON.stringify(inner)}`);
}

function parseFilter(path: string, text: string): Segment {
  const m = FILTER.exec(text);
  if (!m) {
    throw new JsonPathError(
      path,
      `bad filter ${JSON.stringify(text)}: expected [?(@.name == literal)] with == or != and a string or number literal`,
    );
  }
  const key = m[1] ?? unquote(path, m[2] as string);
  const op = m[3] as FilterOp;
  const raw = m[4] as string;
  const literal = raw.startsWith("'") || raw.startsWith('"') ? unquote(path, raw) : Number(raw);
  return { type: 'filter', key, op, literal };
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

/**
 * True for a path in the plain subset: no filter and no descent. Captures,
 * keys, and every path outside the diff rules use this subset.
 */
export function isValidPath(path: string): boolean {
  try {
    return isPlainPath(parsePath(path));
  } catch {
    return false;
  }
}

/** True for a path the diff rules accept: the plain subset plus filters and recursive descent. */
export function isValidRulePath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the path holds no filter and no descent, so `matches` decides it without a document. */
export function isPlainPath(segments: readonly Segment[]): boolean {
  return segments.every((s) => s.type !== 'filter' && s.type !== 'descent');
}

function renderName(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

/** A string literal of a filter: single quotes with `\` and `'` escaped. */
function renderLiteral(literal: string | number): string {
  if (typeof literal === 'number') return JSON.stringify(literal);
  return `'${literal.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
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
    case 'filter': {
      const child = IDENT.test(segment.key) ? `.${segment.key}` : `[${renderLiteral(segment.key)}]`;
      return `[?(@${child}${segment.op}${renderLiteral(segment.literal)})]`;
    }
    case 'descent':
      return '..';
  }
}

/** Renders segments as a path. The segment after a descent is written without its leading dot, as in `$..name`. */
export function renderPath(segments: readonly Segment[]): string {
  let out = '$';
  let afterDescent = false;
  for (const segment of segments) {
    const text = renderSegment(segment);
    out += afterDescent && text.startsWith('.') ? text.slice(1) : text;
    afterDescent = segment.type === 'descent';
  }
  return out;
}

/** Wraps canonical JSON in single quotes, with `\` and `'` escaped as `\\` and `\'`. */
function quoteJson(text: string): string {
  return `'${text.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
}

/**
 * Renders a key value as the text of a keyed segment. The text tells the JSON
 * type apart. A string renders bare when it is an identifier other than
 * `true`, `false`, and `null`, so `A-100` stays `A-100`, and as a JSON string
 * in double quotes otherwise. A number, a boolean, and null render as their
 * JSON text. A bare text therefore starts with a letter, `_`, or `$` exactly
 * when it is a string, so the string `1` renders `"1"` and the number `1`
 * renders `1`. An array or an object renders as its canonical JSON in single
 * quotes, so the array `[1,2]` and the string `[1,2]` read differently too.
 */
export function keyValueText(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return IDENT.test(value) && !JSON_WORDS.has(value) ? value : JSON.stringify(value);
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  return quoteJson(canonicalJson(value));
}

/** The key text of a row that lacks the key: `#` and the row's canonical JSON in single quotes. */
export function rowKeyText(row: JsonValue): string {
  return `#${quoteJson(canonicalJson(row))}`;
}

/** Whether an array element satisfies a filter segment. */
export function satisfiesFilter(
  element: JsonValue | undefined,
  filter: { key: string; op: FilterOp; literal: string | number },
): boolean {
  const child =
    isJsonObject(element) && Object.hasOwn(element, filter.key) ? element[filter.key] : undefined;
  const equal = child === filter.literal;
  return filter.op === '==' ? equal : !equal;
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
  if (!segments.some((s) => s.type === 'descent')) return out;
  // Two descents in one rule can reach the same value along two routes. The first is kept.
  const seen = new Set<string>();
  return out.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
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
    case 'filter':
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (satisfiesFilter(item, segment)) {
            walk(item, segments, depth + 1, [...concrete, { type: 'index', index }], out);
          }
        });
      }
      return;
    case 'descent':
      // The rest of the rule at this depth first, then the same descent in every child.
      walk(value, segments, depth + 1, concrete, out);
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          walk(item, segments, depth, [...concrete, { type: 'index', index }], out),
        );
      } else if (isJsonObject(value)) {
        for (const name of Object.keys(value).sort()) {
          walk(
            value[name] as JsonValue,
            segments,
            depth,
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

/**
 * The key paths a keyed segment's name can stand for. The differ labels a
 * keyed segment with the key's own name when the key path is one key, as
 * `sku` for `$.sku` and `a b` for `$['a b']`, and with the key path after `$`
 * otherwise, as `k.id` for `$.k.id`. The one key reading is tried first.
 */
function keyPathsOf(label: string): Segment[][] {
  const out: Segment[][] = [[{ type: 'key', name: label }]];
  try {
    const parsed = parsePath(label.startsWith('[') ? `$${label}` : `$.${label}`);
    if (parsed.length !== 1 || parsed[0]?.type !== 'key') out.push(parsed);
  } catch {
    // The label is a key name the dotted form cannot spell.
  }
  return out;
}

/** The row of an array that a keyed segment names: the dup-th row whose key text is the segment's value. */
function keyedRow(
  rows: readonly JsonValue[],
  segment: Segment & { type: 'keyed' },
): JsonValue | undefined {
  for (const keyPath of keyPathsOf(segment.name)) {
    let seen = 0;
    for (const row of rows) {
      const value = get(row, keyPath);
      const text = value === undefined ? rowKeyText(row) : keyValueText(value);
      if (text !== segment.value) continue;
      if (seen === segment.dup) return row;
      seen += 1;
    }
  }
  return undefined;
}

/**
 * Returns the value at a concrete path, which may hold keyed segments from
 * unordered array comparison. A wildcard, a filter, or a descent in the path
 * is not concrete and gives `undefined`.
 */
export function resolveConcrete(
  doc: JsonValue | undefined,
  concrete: readonly Segment[],
): JsonValue | undefined {
  let value = doc;
  for (const segment of concrete) {
    if (value === undefined) return undefined;
    switch (segment.type) {
      case 'key':
        value =
          isJsonObject(value) && Object.hasOwn(value, segment.name)
            ? value[segment.name]
            : undefined;
        break;
      case 'index':
        value = Array.isArray(value) ? value[segment.index] : undefined;
        break;
      case 'keyed':
        value = Array.isArray(value) ? keyedRow(value, segment) : undefined;
        break;
      default:
        return undefined;
    }
  }
  return value;
}

/** Gives the value at the first `prefixLength` segments of the concrete path being matched. */
export type ElementAt = (prefixLength: number) => JsonValue | undefined;

/**
 * Tests whether a rule path matches a concrete path without a document. A
 * wildcard matches any one segment and a descent any run of segments. A
 * filter never matches here, because it needs the element; use `matchesIn`.
 */
export function matches(
  rule: string | readonly Segment[],
  concrete: string | readonly Segment[],
): boolean {
  return matchesWith(rule, concrete, undefined);
}

/**
 * Tests whether a rule path matches a concrete path of `document`. A filter
 * segment matches an index or keyed segment whose element, read from the
 * document at the concrete path so far, satisfies the predicate.
 */
export function matchesIn(
  rule: string | readonly Segment[],
  concrete: string | readonly Segment[],
  document: JsonValue | undefined,
): boolean {
  const c = typeof concrete === 'string' ? parsePath(concrete) : concrete;
  return matchesWith(rule, c, (n) => resolveConcrete(document, c.slice(0, n)));
}

/** Like `matchesIn`, with the elements of the concrete path supplied by `elementAt`. */
export function matchesWith(
  rule: string | readonly Segment[],
  concrete: string | readonly Segment[],
  elementAt: ElementAt | undefined,
): boolean {
  const r = typeof rule === 'string' ? parsePath(rule) : rule;
  const c = typeof concrete === 'string' ? parsePath(concrete) : concrete;
  if (!r.some((s) => s.type === 'descent') && r.length !== c.length) return false;
  const from = (ri: number, ci: number): boolean => {
    if (ri === r.length) return ci === c.length;
    const segment = r[ri] as Segment;
    if (segment.type === 'descent') {
      for (let k = ci; k <= c.length; k += 1) if (from(ri + 1, k)) return true;
      return false;
    }
    if (ci >= c.length) return false;
    return segmentMatches(segment, c[ci] as Segment, ci, elementAt) && from(ri + 1, ci + 1);
  };
  return from(0, 0);
}

function segmentMatches(
  rule: Segment,
  concrete: Segment,
  position: number,
  elementAt: ElementAt | undefined,
): boolean {
  switch (rule.type) {
    case 'wildcard':
      return true;
    case 'key':
      return concrete.type === 'key' && concrete.name === rule.name;
    case 'index':
      return concrete.type === 'index' && concrete.index === rule.index;
    case 'keyed':
      return (
        concrete.type === 'keyed' &&
        concrete.name === rule.name &&
        concrete.value === rule.value &&
        concrete.dup === rule.dup
      );
    case 'filter':
      if (concrete.type !== 'index' && concrete.type !== 'keyed') return false;
      if (elementAt === undefined) return false;
      return satisfiesFilter(elementAt(position + 1), rule);
    case 'descent':
      return false;
  }
}
