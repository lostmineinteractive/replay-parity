import {
  canonicalJson,
  get,
  isJsonObject,
  parsePath,
  type Exchange,
  type JsonValue,
  type Query,
  type RecordedRequest,
  type RecordedResponse,
  type Segment,
  type SubstitutionRule,
  type ValueEquivalences,
} from '@replay-parity/core';

/**
 * Substitutions. A rule captures a value at a JSONPath from the response of
 * every exchange carrying the capture tag, on the reference side and on the
 * candidate side, and later requests have the reference value replaced with
 * the candidate value in the chosen locations.
 *
 * The first exchange to produce a reference value wins. A later exchange that
 * produces the same reference value with a different candidate value is a
 * mismatch, which is what a lost idempotency key looks like.
 */

type Location = 'path' | 'query' | 'body';

interface CompiledRule {
  name: string;
  tag: string;
  segments: Segment[];
  apply: ReadonlySet<Location>;
}

function compileRules(rules: readonly SubstitutionRule[]): CompiledRule[] {
  return rules.map((r) => ({
    name: r.name,
    tag: r.capture.tag,
    segments: parsePath(r.capture.path),
    apply: new Set(r.apply),
  }));
}

function isLeaf(value: JsonValue | undefined): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/** The lookup keys for a text found in a path or a query. A number is tried too. */
function textKeys(text: string): string[] {
  const keys = [canonicalJson(text)];
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) keys.push(canonicalJson(Number(text)));
  return keys;
}

function leafKeys(value: JsonValue): string[] {
  return [canonicalJson(value)];
}

function* bodyLeaves(value: JsonValue | undefined): Generator<JsonValue> {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) yield* bodyLeaves(item);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) yield* bodyLeaves(item);
  } else {
    yield value;
  }
}

function mapBody(value: JsonValue, fn: (leaf: JsonValue) => JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => mapBody(item, fn));
  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapBody(v, fn);
    return out;
  }
  return fn(value);
}

/**
 * Finds, before anything is sent, which earlier exchange produces each value
 * a request will need. The engine waits for those producers.
 */
export class DependencyIndex {
  private readonly rules: CompiledRule[];
  /** rule name -> canonical reference value -> index of the first producer */
  private readonly producers = new Map<string, Map<string, number>>();

  constructor(selected: readonly Exchange[], rules: readonly SubstitutionRule[]) {
    this.rules = compileRules(rules);
    for (const rule of this.rules) {
      const map = new Map<string, number>();
      selected.forEach((exchange, index) => {
        if (!exchange.tags.includes(rule.tag)) return;
        const value = get(exchange.response.body, rule.segments);
        if (!isLeaf(value)) return;
        const key = canonicalJson(value);
        if (!map.has(key)) map.set(key, index);
      });
      this.producers.set(rule.name, map);
    }
  }

  /** Indices of earlier exchanges whose captured values appear in the request at `index`. */
  dependenciesOf(index: number, request: RecordedRequest): number[] {
    const out = new Set<number>();
    for (const rule of this.rules) {
      const map = this.producers.get(rule.name) as Map<string, number>;
      if (map.size === 0) continue;
      const note = (keys: string[]): void => {
        for (const key of keys) {
          const producer = map.get(key);
          if (producer !== undefined && producer < index) out.add(producer);
        }
      };
      if (rule.apply.has('path')) {
        for (const segment of request.path.split('/')) if (segment) note(textKeys(segment));
      }
      if (rule.apply.has('query')) {
        for (const value of Object.values(request.query)) {
          for (const v of Array.isArray(value) ? value : [value]) note(textKeys(v));
        }
      }
      if (rule.apply.has('body')) {
        for (const leaf of bodyLeaves(request.body)) if (isLeaf(leaf)) note(leafKeys(leaf));
      }
    }
    return [...out].sort((a, b) => a - b);
  }
}

/** The live table of reference to candidate value pairs. */
export class SubstitutionTable {
  private readonly rules: CompiledRule[];
  /** rule name -> canonical reference value -> candidate value */
  private readonly values = new Map<string, Map<string, string | number>>();
  /** rule name -> canonical reference value -> canonical candidate value */
  private readonly canonical = new Map<string, Map<string, string>>();

  constructor(rules: readonly SubstitutionRule[]) {
    this.rules = compileRules(rules);
    for (const rule of this.rules) {
      this.values.set(rule.name, new Map());
      this.canonical.set(rule.name, new Map());
    }
  }

  get size(): number {
    let n = 0;
    for (const map of this.values.values()) n += map.size;
    return n;
  }

  /** The equivalences the differ uses to tolerate mapped values. */
  get equivalences(): ValueEquivalences {
    return this.canonical;
  }

  /** Records the pairs produced by a completed exchange. The first producer of a reference value wins. */
  capture(tags: readonly string[], reference: RecordedResponse, candidate: RecordedResponse): void {
    for (const rule of this.rules) {
      if (!tags.includes(rule.tag)) continue;
      const refValue = get(reference.body, rule.segments);
      const candValue = get(candidate.body, rule.segments);
      if (!isLeaf(refValue) || !isLeaf(candValue)) continue;
      const key = canonicalJson(refValue);
      const values = this.values.get(rule.name) as Map<string, string | number>;
      if (values.has(key)) continue;
      values.set(key, candValue);
      (this.canonical.get(rule.name) as Map<string, string>).set(key, canonicalJson(candValue));
    }
  }

  /** Returns a copy of `request` with every stored reference value replaced. */
  apply(request: RecordedRequest): RecordedRequest {
    if (this.size === 0) return request;
    let path = request.path;
    let query: Query = request.query;
    let body = request.body;
    for (const rule of this.rules) {
      const values = this.values.get(rule.name) as Map<string, string | number>;
      if (values.size === 0) continue;
      const lookupText = (text: string): string => {
        for (const key of textKeys(text)) {
          const hit = values.get(key);
          if (hit !== undefined) return String(hit);
        }
        return text;
      };
      if (rule.apply.has('path')) {
        path = path
          .split('/')
          .map((segment) => (segment ? lookupText(segment) : segment))
          .join('/');
      }
      if (rule.apply.has('query')) {
        const next: Query = {};
        for (const [k, value] of Object.entries(query)) {
          next[k] = Array.isArray(value) ? value.map(lookupText) : lookupText(value);
        }
        query = next;
      }
      if (rule.apply.has('body') && body !== undefined && request.encoding === undefined) {
        body = mapBody(body, (leaf) => {
          if (!isLeaf(leaf)) return leaf;
          const hit = values.get(canonicalJson(leaf));
          return hit ?? leaf;
        });
      }
    }
    const out: RecordedRequest = { ...request, path, query };
    if (body !== undefined) out.body = body;
    return out;
  }
}
