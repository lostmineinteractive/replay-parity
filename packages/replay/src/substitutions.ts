import {
  canonicalJson,
  captureValue,
  isJsonObject,
  parseNumericText,
  type Exchange,
  type JsonValue,
  type Query,
  type RecordedRequest,
  type RecordedResponse,
  type SubstitutionCapture,
  type SubstitutionRule,
  type ValueEquivalences,
} from '@replay-parity/core';

/**
 * Substitutions. A rule captures a value from every exchange carrying the
 * capture tag, on the reference side and on the candidate side, and later
 * requests have the reference value replaced with the candidate value in the
 * chosen locations.
 *
 * The value comes from a JSONPath in the response body, from a response
 * header through an optional pattern, or, with `from: request`, from a
 * JSONPath in the request body. A request capture reads the recorded request
 * on the reference side and the request as sent on the candidate side. The
 * two are the same value unless an earlier substitution or an override
 * rewrote the request, so the capture seeds an equivalence for a response
 * that echoes the value and names the exchange that introduced the value as
 * a producer the later exchanges wait for.
 *
 * The first exchange to produce a reference value wins. A later exchange that
 * produces the same reference value with a different candidate value is a
 * mismatch, which is what a lost idempotency key looks like.
 */

type Location = 'path' | 'query' | 'body';

interface CompiledRule {
  name: string;
  tag: string;
  capture: SubstitutionCapture;
  apply: ReadonlySet<Location>;
}

/**
 * The requests of one exchange, for a request capture: the recorded request
 * on the reference side and the request as sent on the candidate side. Without
 * `sent` the recorded request stands for both.
 */
export interface CaptureRequests {
  recorded: RecordedRequest;
  sent?: RecordedRequest | undefined;
}

function requestPair(
  request: RecordedRequest | CaptureRequests | undefined,
): [RecordedRequest | undefined, RecordedRequest | undefined] {
  if (request === undefined) return [undefined, undefined];
  if ('recorded' in request) return [request.recorded, request.sent ?? request.recorded];
  return [request, request];
}

function compileRules(rules: readonly SubstitutionRule[]): CompiledRule[] {
  return rules.map((r) => ({
    name: r.name,
    tag: r.capture.tag,
    capture: r.capture,
    apply: new Set(r.apply),
  }));
}

function isLeaf(value: JsonValue | undefined): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/** The lookup keys for a text found in a path or a query. A number is tried too. */
function textKeys(text: string): string[] {
  const keys = [canonicalJson(text)];
  const n = parseNumericText(text);
  if (n !== undefined) keys.push(canonicalJson(n));
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
    for (const rule of this.rules) this.producers.set(rule.name, new Map());
    selected.forEach((exchange, index) => this.add(exchange, index));
  }

  /** True when no rule can capture anything, so no exchange depends on another. */
  get empty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Notes the values one more exchange produces. Exchanges are added in
   * recording order, which is how a streamed recording builds the index: a
   * producer always precedes the requests that use its value, so the index
   * answers `dependenciesOf` for an exchange as soon as every earlier one was
   * added, exactly as it does when it is built over the whole selection.
   */
  add(exchange: Exchange, index: number): void {
    for (const rule of this.rules) {
      if (!exchange.tags.includes(rule.tag)) continue;
      const value = captureValue(rule.capture, exchange.response, exchange.request);
      if (value === undefined) continue;
      const key = canonicalJson(value);
      const map = this.producers.get(rule.name) as Map<string, number>;
      if (!map.has(key)) map.set(key, index);
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

/**
 * The pairs of a table as a checkpoint stores them: per rule, the canonical
 * reference value, the candidate value, and the position of the exchange
 * that produced the pair, or null when the caller gave none.
 */
export type TableSnapshot = Record<string, [string, string | number, number | null][]>;

/** The live table of reference to candidate value pairs. */
export class SubstitutionTable {
  private readonly rules: CompiledRule[];
  /** rule name -> canonical reference value -> candidate value */
  private readonly values = new Map<string, Map<string, string | number>>();
  /** rule name -> canonical reference value -> canonical candidate value */
  private readonly canonical = new Map<string, Map<string, string>>();
  /** rule name -> canonical reference value -> position of the producing exchange */
  private readonly producers = new Map<string, Map<string, number | null>>();

  constructor(rules: readonly SubstitutionRule[]) {
    this.rules = compileRules(rules);
    for (const rule of this.rules) {
      this.values.set(rule.name, new Map());
      this.canonical.set(rule.name, new Map());
      this.producers.set(rule.name, new Map());
    }
  }

  /**
   * The pairs produced by exchanges before position `before`, for a checkpoint.
   * A pair recorded without a position is always included.
   */
  snapshot(before = Number.POSITIVE_INFINITY): TableSnapshot {
    const out: TableSnapshot = {};
    for (const rule of this.rules) {
      const values = this.values.get(rule.name) as Map<string, string | number>;
      const producers = this.producers.get(rule.name) as Map<string, number | null>;
      out[rule.name] = [...values.entries()]
        .map(([key, value]): [string, string | number, number | null] => [
          key,
          value,
          producers.get(key) ?? null,
        ])
        .filter(([, , at]) => at === null || at < before);
    }
    return out;
  }

  /** Adds the pairs of a snapshot. Pairs of a rule this table does not have are ignored. */
  restore(snapshot: TableSnapshot): void {
    for (const rule of this.rules) {
      const values = this.values.get(rule.name) as Map<string, string | number>;
      const canonical = this.canonical.get(rule.name) as Map<string, string>;
      const producers = this.producers.get(rule.name) as Map<string, number | null>;
      for (const [key, value, at] of snapshot[rule.name] ?? []) {
        if (values.has(key)) continue;
        values.set(key, value);
        canonical.set(key, canonicalJson(value));
        producers.set(key, at);
      }
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

  /**
   * Records the pairs produced by a completed exchange. The first producer of
   * a reference value wins. `request` is needed by request captures only: a
   * rule with `from: request` records nothing without it. It is the recorded
   * request, which then stands for both sides, or the recorded request and
   * the request as sent.
   */
  capture(
    tags: readonly string[],
    reference: RecordedResponse,
    candidate: RecordedResponse,
    request?: RecordedRequest | CaptureRequests,
    /** The position of the producing exchange, which a checkpoint uses. */
    position?: number,
  ): void {
    const [recorded, sent] = requestPair(request);
    for (const rule of this.rules) {
      if (!tags.includes(rule.tag)) continue;
      const refValue = captureValue(rule.capture, reference, recorded);
      const candValue = captureValue(rule.capture, candidate, sent);
      if (refValue === undefined || candValue === undefined) continue;
      const key = canonicalJson(refValue);
      const values = this.values.get(rule.name) as Map<string, string | number>;
      if (values.has(key)) continue;
      values.set(key, candValue);
      (this.canonical.get(rule.name) as Map<string, string>).set(key, canonicalJson(candValue));
      (this.producers.get(rule.name) as Map<string, number | null>).set(key, position ?? null);
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
