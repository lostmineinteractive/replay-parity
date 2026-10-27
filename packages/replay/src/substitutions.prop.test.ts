import {
  DiffRulesSchema,
  canonicalJson,
  get,
  isJsonObject,
  jsonResponse,
  makeExchange,
  makeRequest,
  parsePath,
  type Exchange,
  type JsonValue,
  type Query,
  type RecordedRequest,
  type SubstitutionRule,
} from '@replay-parity/core';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DependencyIndex, SubstitutionTable } from './substitutions.js';

/**
 * Property based tests for substitutions. Fixed seed, see
 * packages/core/src/differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

/**
 * A small alphabet so captured values and request values collide often. With
 * these texts, "the text of a captured value" is the same set whether a path
 * segment is read as text or as a number, which keeps the oracle simple.
 */
const TEXTS = ['o-1', 'o-2', 'o-3', 's-1', '41', '7', 'x', 'o-12'];
const NUMBERS = [41, 7, 3];
const TAGS = ['create-order', 'ship-order', 'get-order'];
const PATHS = ['$.order_id', '$.shipment_id', '$.nested.id'];
/** Candidate values from a disjoint alphabet, for the idempotence property. */
const DISJOINT = ['c-1', 'c-2', 99];

const leaf: fc.Arbitrary<string | number> = fc.oneof(
  fc.constantFrom(...TEXTS),
  fc.constantFrom(...NUMBERS),
);

const ruleArb = fc.record({
  name: fc.constantFrom('order_id', 'shipment', 'other'),
  capture: fc.record({ tag: fc.constantFrom(...TAGS), path: fc.constantFrom(...PATHS) }),
  apply: fc.subarray<'path' | 'query' | 'body'>(['path', 'query', 'body'], { minLength: 1 }),
});

const rulesArb: fc.Arbitrary<SubstitutionRule[]> = fc
  .uniqueArray(ruleArb, { selector: (r) => r.name, minLength: 1, maxLength: 3 })
  .map((substitutions) => DiffRulesSchema.parse({ substitutions }).substitutions);

/** Puts `value` at a key only path such as `$.nested.id`. */
function bodyAt(path: string, value: JsonValue): JsonValue {
  const segments = parsePath(path);
  let out: JsonValue = value;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const s = segments[i];
    if (s?.type !== 'key') throw new Error('key paths only');
    out = { [s.name]: out };
  }
  return out;
}

interface Capture {
  rule: number;
  ref: string | number;
  cand: string | number;
}

function captureArb(candidates: fc.Arbitrary<string | number>): fc.Arbitrary<Capture[]> {
  return fc.array(fc.record({ rule: fc.nat({ max: 2 }), ref: leaf, cand: candidates }), {
    maxLength: 6,
  });
}

function fillTable(rules: SubstitutionRule[], captures: Capture[]): SubstitutionTable {
  const table = new SubstitutionTable(rules);
  for (const c of captures) {
    const rule = rules[c.rule % rules.length] as SubstitutionRule;
    table.capture(
      [rule.capture.tag],
      jsonResponse(bodyAt(rule.capture.path, c.ref), 201),
      jsonResponse(bodyAt(rule.capture.path, c.cand), 201),
    );
  }
  return table;
}

const textArb = fc.constantFrom(...TEXTS, 'v1', 'orders', '');
const queryArb: fc.Arbitrary<Query> = fc
  .dictionary(
    fc.constantFrom('ref', 'ids', 'q'),
    fc.oneof(textArb, fc.array(textArb, { maxLength: 3 })),
    { maxKeys: 3 },
  )
  .map((q) => ({ ...q }));
const bodyLeaf: fc.Arbitrary<JsonValue> = fc.oneof(leaf, fc.constant(null), fc.boolean());
const { value: bodyArb } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 2, depthSize: 'small' },
    bodyLeaf,
    fc.array(tie('value'), { maxLength: 3 }),
    fc
      .dictionary(fc.constantFrom('id', 'order', 'nested', 'list'), tie('value'), { maxKeys: 3 })
      .map((d) => ({ ...d })),
  ),
}));

const requestArb: fc.Arbitrary<RecordedRequest> = fc
  .tuple(
    fc.constantFrom('GET', 'POST'),
    fc.array(textArb, { maxLength: 4 }),
    queryArb,
    fc.constantFrom('none', 'json', 'binary'),
    bodyArb,
  )
  .map(([method, segs, query, kind, body]): RecordedRequest => {
    const base = makeRequest({ method, path: `/${segs.join('/')}`, query });
    if (kind === 'json') return { ...base, body };
    if (kind === 'binary') return { ...base, body: 'by0x', encoding: 'base64' };
    return base;
  });

/** Leaves of a body by their position, so two bodies can be compared leaf by leaf. */
function leaves(value: JsonValue | undefined, prefix: string, out: Map<string, JsonValue>): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaves(item, `${prefix}[${i}]`, out));
  } else if (isJsonObject(value)) {
    for (const k of Object.keys(value)) leaves(value[k], `${prefix}.${k}`, out);
  } else {
    out.set(prefix, value);
  }
}

function queryValues(query: Query): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((item, i) => out.push([`${k}[${i}]`, item]));
    else out.push([k, v]);
  }
  return out;
}

describe('SubstitutionTable properties', () => {
  it('returns the request itself when nothing has been captured', () => {
    fc.assert(
      fc.property(rulesArb, requestArb, (rules, request) => {
        const table = new SubstitutionTable(rules);
        expect(table.size).toBe(0);
        expect(table.apply(request)).toBe(request);
      }),
      params,
    );
  });

  it('never rewrites a value that was not captured, and never changes the shape of a request', () => {
    fc.assert(
      fc.property(rulesArb, captureArb(leaf), requestArb, (rules, captures, request) => {
        const table = fillTable(rules, captures);
        const capturedTexts = new Set(captures.map((c) => String(c.ref)));
        const capturedCanonical = new Set(captures.map((c) => canonicalJson(c.ref)));
        const applied = new Set(rules.flatMap((r) => r.apply));
        const out = table.apply(request);

        expect(out.method).toBe(request.method);
        expect(out.headers).toEqual(request.headers);
        expect(out.encoding).toBe(request.encoding);

        const inSegs = request.path.split('/');
        const outSegs = out.path.split('/');
        expect(outSegs).toHaveLength(inSegs.length);
        inSegs.forEach((seg, i) => {
          if (outSegs[i] !== seg) {
            expect(applied.has('path')).toBe(true);
            expect(capturedTexts.has(seg)).toBe(true);
          }
        });

        const inQuery = queryValues(request.query);
        const outQuery = queryValues(out.query);
        expect(outQuery.map(([k]) => k)).toEqual(inQuery.map(([k]) => k));
        inQuery.forEach(([, v], i) => {
          if (outQuery[i]?.[1] !== v) {
            expect(applied.has('query')).toBe(true);
            expect(capturedTexts.has(v)).toBe(true);
          }
        });

        if (request.encoding === 'base64') {
          expect(out.body).toBe(request.body);
        } else {
          const inLeaves = new Map<string, JsonValue>();
          const outLeaves = new Map<string, JsonValue>();
          leaves(request.body, '$', inLeaves);
          leaves(out.body, '$', outLeaves);
          expect([...outLeaves.keys()]).toEqual([...inLeaves.keys()]);
          for (const [path, v] of inLeaves) {
            const w = outLeaves.get(path) as JsonValue;
            if (canonicalJson(w) !== canonicalJson(v)) {
              expect(applied.has('body')).toBe(true);
              expect(capturedCanonical.has(canonicalJson(v))).toBe(true);
            }
          }
        }
      }),
      params,
    );
  });

  it('is idempotent when the candidate values are disjoint from the reference values', () => {
    fc.assert(
      fc.property(
        rulesArb,
        captureArb(fc.constantFrom(...DISJOINT)),
        requestArb,
        (rules, captures, request) => {
          const table = fillTable(rules, captures);
          const once = table.apply(request);
          expect(table.apply(once)).toEqual(once);
        },
      ),
      params,
    );
  });

  it('applies one hop per application, so a chained table is not idempotent', () => {
    // Shifted ids produce chains: reference o-1 maps to candidate o-2 and reference o-2
    // maps to candidate o-3. The engine applies the table once per request, which maps
    // o-1 to o-2. A second application would move it on to o-3, so idempotence only
    // holds when candidate values do not reappear as reference values.
    const rules = DiffRulesSchema.parse({
      substitutions: [{ name: 'order_id', capture: { tag: 'create-order', path: '$.order_id' } }],
    }).substitutions;
    const table = new SubstitutionTable(rules);
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-2' }),
    );
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-2' }),
      jsonResponse({ order_id: 'o-3' }),
    );
    const request = makeRequest({ path: '/v1/orders/o-1' });
    const once = table.apply(request);
    expect(once.path).toBe('/v1/orders/o-2');
    expect(table.apply(once).path).toBe('/v1/orders/o-3');
  });
});

describe('DependencyIndex properties', () => {
  const exchangesArb = rulesArb.chain((rules) =>
    fc
      .array(
        fc.record({
          tags: fc.subarray(TAGS),
          path: fc.constantFrom(...PATHS),
          value: leaf,
        }),
        { maxLength: 8 },
      )
      .map((rows) => ({
        rules,
        exchanges: rows.map((row, index) =>
          makeExchange({
            index,
            tags: row.tags,
            response: jsonResponse(bodyAt(row.path, row.value), 201),
          }),
        ),
      })),
  );

  /** The texts and canonical leaves a request carries, in any location. */
  function usedValues(request: RecordedRequest): Set<string> {
    const out = new Set<string>();
    for (const seg of request.path.split('/')) if (seg) out.add(seg);
    for (const [, v] of queryValues(request.query)) out.add(v);
    const body = new Map<string, JsonValue>();
    if (request.encoding === undefined) leaves(request.body, '$', body);
    for (const v of body.values()) out.add(canonicalJson(v));
    return out;
  }

  it('returns only earlier producers, sorted and unique, each of which produced a value the request uses', () => {
    fc.assert(
      fc.property(
        exchangesArb,
        fc.nat({ max: 10 }),
        requestArb,
        ({ rules, exchanges }, at, request) => {
          const index = Math.min(at, exchanges.length);
          const deps = new DependencyIndex(exchanges, rules).dependenciesOf(index, request);
          const used = usedValues(request);
          let previous = -1;
          for (const d of deps) {
            expect(d).toBeGreaterThan(previous);
            expect(d).toBeLessThan(index);
            previous = d;
            const producer = exchanges[d] as Exchange;
            const produces = rules.some((rule) => {
              if (!producer.tags.includes(rule.capture.tag)) return false;
              const value = get(producer.response.body, rule.capture.path);
              if (typeof value !== 'string' && typeof value !== 'number') return false;
              return used.has(String(value)) || used.has(canonicalJson(value));
            });
            expect(produces).toBe(true);
          }
          expect(new DependencyIndex(exchanges, rules).dependenciesOf(0, request)).toEqual([]);
        },
      ),
      params,
    );
  });
});
