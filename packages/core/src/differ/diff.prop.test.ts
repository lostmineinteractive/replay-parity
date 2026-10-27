import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, isJsonObject, type JsonObject, type JsonValue } from '../json.js';
import { parsePath } from '../jsonpath/index.js';
import type { RecordedResponse } from '../recording/types.js';
import { DiffRulesSchema, type DiffRules, type DiffRulesInput } from '../rules/schema.js';
import { jsonResponse, makeResponse } from '../testing.js';
import { createDiffer } from './diff.js';
import type { Diff } from './schema.js';

/**
 * Property based tests for the differ.
 *
 * Every property runs with the fixed seed below. On a failure fast-check
 * prints the seed, the path, and the shrunk counterexample, and the run is
 * replayed with `fc.assert(property, { seed, path, endOnFailure: true })`.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

const KEYS = ['a', 'b', 'c', 'id', 'items', 'a b', '', 'q"t'];
const STRINGS = ['', 'x', 'y', 'A-1', "it's", 'a]b', 'a b'];

const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 3 }),
  fc
    .double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true })
    .map((x) => (x === 0 ? 0 : x)),
  fc.constantFrom(...STRINGS),
);

/** JSON values of bounded depth and width, with keys drawn from a small alphabet. */
const { value: jsonValue } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}));

const identKey = fc.constantFrom('a', 'b', 'c', 'id', 'items');

/** Rule paths from the supported subset: `.name`, `["name"]`, `[n]`, `[*]`, and `.*`. */
const ruleSegment = fc.oneof(
  identKey.map((name) => `.${name}`),
  fc.constantFrom('a b', '', 'q"t').map((name) => `[${JSON.stringify(name)}]`),
  fc.integer({ min: 0, max: 3 }).map((i) => `[${i}]`),
  fc.constant('[*]'),
  fc.constant('.*'),
);
const rulePath = fc.array(ruleSegment, { maxLength: 3 }).map((segs) => `$${segs.join('')}`);

const toleranceArb = fc
  .tuple(
    rulePath,
    fc.double({ min: 0, max: 2, noNaN: true }),
    fc.double({ min: 0, max: 0.5, noNaN: true }),
    fc.constantFrom('abs', 'rel', 'both'),
  )
  .map(([path, abs, rel, which]) => {
    if (which === 'abs') return { path, abs };
    if (which === 'rel') return { path, rel };
    return { path, abs, rel };
  });

const unorderedArb = fc
  .tuple(
    rulePath,
    fc.option(
      identKey.map((k) => `$.${k}`),
      { nil: undefined },
    ),
  )
  .map(([path, key]) => (key === undefined ? { path } : { path, key }));

const rulesArb: fc.Arbitrary<DiffRules> = fc
  .record({
    ignore: fc.array(rulePath, { maxLength: 2 }),
    tolerances: fc.array(toleranceArb, { maxLength: 2 }),
    unordered: fc.array(unorderedArb, { maxLength: 2 }),
    status: fc.record({
      equivalent: fc.array(
        fc.uniqueArray(fc.constantFrom(200, 201, 204, 404, 500, 503), {
          minLength: 2,
          maxLength: 3,
        }),
        { maxLength: 2 },
      ),
    }),
    headers: fc.record({ compare: fc.subarray(['content-type', 'x-a', 'x-b']) }),
  })
  .map((input: DiffRulesInput) => DiffRulesSchema.parse(input));

const statusArb = fc.constantFrom(200, 201, 204, 404, 500, 503);
const headersArb = fc
  .dictionary(
    fc.constantFrom('content-type', 'x-a', 'x-b'),
    fc.constantFrom('application/json', 'text/plain', '1', '2'),
    { maxKeys: 3 },
  )
  .map((h) => ({ ...h }));

/**
 * Responses with a JSON body, a binary body, or no body. Truncated bodies are
 * excluded: the differ reports them as `body_too_large` by design.
 */
const responseArb: fc.Arbitrary<RecordedResponse> = fc.oneof(
  fc
    .tuple(statusArb, headersArb, jsonValue)
    .map(([status, headers, body]) => makeResponse({ status, headers, body })),
  fc.tuple(statusArb, headersArb, fc.uint8Array({ maxLength: 6 })).map(([status, headers, bytes]) =>
    makeResponse({
      status,
      headers,
      body: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
    }),
  ),
  fc
    .tuple(statusArb, headersArb)
    .map(([status, headers]) => makeResponse({ status, headers, body: undefined })),
);

/** A small deterministic generator for key shuffles. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Rebuilds every object with its keys in a shuffled insertion order. Values are unchanged. */
function permuteKeys(value: JsonValue, next: () => number): JsonValue {
  if (Array.isArray(value)) return value.map((v) => permuteKeys(v, next));
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const tmp = keys[i] as string;
      keys[i] = keys[j] as string;
      keys[j] = tmp;
    }
    const out: JsonObject = {};
    for (const k of keys) out[k] = permuteKeys(value[k] as JsonValue, next);
    return out;
  }
  return value;
}

/** Rebuilds every object with its keys in reverse insertion order. */
function reverseKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const k of Object.keys(value).reverse()) out[k] = reverseKeys(value[k] as JsonValue);
    return out;
  }
  return value;
}

function canonicalDiff(diff: Diff): string {
  return canonicalJson(diff as unknown as JsonValue);
}

/** The non value fields of every finding, in order. Byte identical across runs. */
function skeleton(diff: Diff): string {
  return JSON.stringify([
    diff.verdict,
    diff.findings.map((f) => [f.path, f.kind, f.tolerated, f.rule ?? null, f.detail ?? null]),
  ]);
}

function permutationOf<T>(items: T[]): fc.Arbitrary<T[]> {
  return fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length });
}

describe('differ properties', () => {
  it('diff(x, x) is a match with no findings for any response under any rules', () => {
    fc.assert(
      fc.property(rulesArb, responseArb, (rules, x) => {
        const differ = createDiffer(rules);
        expect(differ.diff(x, x)).toEqual({ verdict: 'match', findings: [] });
        expect(differ.diff(x, structuredClone(x))).toEqual({ verdict: 'match', findings: [] });
      }),
      params,
    );
  });

  it('findings do not depend on object key insertion order on either side', () => {
    // The reported reference and candidate values keep their own key order, so byte
    // identity is checked on the canonical form and on the non value fields.
    fc.assert(
      fc.property(
        rulesArb,
        jsonValue,
        jsonValue,
        fc.nat(),
        fc.nat(),
        (rules, ref, cand, s1, s2) => {
          const differ = createDiffer(rules);
          const base = differ.diff(jsonResponse(ref), jsonResponse(cand));
          const shuffled = differ.diff(
            jsonResponse(permuteKeys(ref, lcg(s1))),
            jsonResponse(permuteKeys(cand, lcg(s2))),
          );
          const reversed = differ.diff(
            jsonResponse(reverseKeys(ref)),
            jsonResponse(reverseKeys(cand)),
          );
          expect(skeleton(shuffled)).toBe(skeleton(base));
          expect(skeleton(reversed)).toBe(skeleton(base));
          expect(canonicalDiff(shuffled)).toBe(canonicalDiff(base));
          expect(canonicalDiff(reversed)).toBe(canonicalDiff(base));
        },
      ),
      params,
    );
  });

  it('under an unordered rule without a key, a permutation of an array matches', () => {
    const arrays = fc
      .array(jsonValue, { maxLength: 6 })
      .chain((items) => fc.tuple(fc.constant(items), permutationOf(items)));
    fc.assert(
      fc.property(arrays, fc.boolean(), ([items, permuted], atRoot) => {
        const rules = DiffRulesSchema.parse({ unordered: [{ path: atRoot ? '$' : '$.items' }] });
        const ref: JsonValue = atRoot ? items : { items };
        const cand: JsonValue = atRoot ? permuted : { items: permuted };
        const diff = createDiffer(rules).diff(jsonResponse(ref), jsonResponse(cand));
        expect(diff).toEqual({ verdict: 'match', findings: [] });
      }),
      params,
    );
  });

  it('under a keyed unordered rule, a permutation of rows with distinct keys matches', () => {
    const row = fc.record({
      sku: fc.constantFrom('A', 'B', 'C', 'D', 'E', 'A-1', 'a b', ''),
      qty: jsonValue,
    });
    const rows = fc
      .uniqueArray(row, { selector: (r) => r.sku, maxLength: 6 })
      .chain((items) => fc.tuple(fc.constant(items), permutationOf(items)));
    fc.assert(
      fc.property(rows, ([items, permuted]) => {
        const rules = DiffRulesSchema.parse({ unordered: [{ path: '$.items', key: '$.sku' }] });
        const diff = createDiffer(rules).diff(
          jsonResponse({ items }),
          jsonResponse({ items: permuted }),
        );
        expect(diff).toEqual({ verdict: 'match', findings: [] });
      }),
      params,
    );
  });

  it('every body finding path is a concrete path that parsePath accepts, under keyless rules', () => {
    const keyless = rulesArb.filter((r) => r.unordered.every((u) => u.key === undefined));
    fc.assert(
      fc.property(keyless, jsonValue, jsonValue, (rules, ref, cand) => {
        for (const finding of createDiffer(rules).diffBodies(ref, cand)) {
          expect(() => parsePath(finding.path), finding.path).not.toThrow();
        }
      }),
      params,
    );
  });

  it('every body finding path parses under a keyed rule whose keys are scalars without quote marks', () => {
    const safeKey: fc.Arbitrary<JsonValue> = fc.oneof(
      fc.constantFrom('A', 'B', 'A-1', 'a b', 'a=b', 'a#1', 'a]b', ''),
      fc.integer({ min: -2, max: 2 }),
      fc.boolean(),
      fc.constant(null),
    );
    const rows = fc.array(fc.record({ sku: safeKey, qty: jsonValue }), { maxLength: 5 });
    fc.assert(
      fc.property(rows, rows, (ref, cand) => {
        const rules = DiffRulesSchema.parse({ unordered: [{ path: '$.items', key: '$.sku' }] });
        for (const finding of createDiffer(rules).diffBodies({ items: ref }, { items: cand })) {
          expect(() => parsePath(finding.path), finding.path).not.toThrow();
        }
      }),
      params,
    );
  });

  it.fails(
    'every body finding path parses under a keyed rule for any key value (known bug)',
    () => {
      // Known bug. A keyed segment is rendered as `[name=value]` with the value unescaped,
      // so a key value holding a quote mark, an array, or an object with an array, a row
      // without the key that is an array, or a key path that needs the bracket form,
      // renders a finding path that parsePath rejects. Exact inputs, each under
      // `unordered: [{ path: "$.items", key: "$.sku" }]` with the `v` field differing:
      //   { sku: "it's", v }     -> $.items[sku=it's].v        missing "]"
      //   { sku: 'a"b', v }      -> $.items[sku=a"b].v         missing "]"
      //   { sku: [1, 2], v }     -> $.items[sku=[1,2]].v       unexpected character "]"
      //   { sku: { a: [1] }, v } -> $.items[sku={"a":[1]}].v   unexpected character "}"
      //   items [[]] against []  -> $.items[sku=#[]]           unexpected character "]"
      // and with key "$['a b']": $.items[["a b"]=X].v          unsupported bracket content.
      // The seeded run finds `{ path: "$", key: "$.a" }` with reference [[]] and candidate [].
      fc.assert(
        fc.property(rulesArb, jsonValue, jsonValue, (rules, ref, cand) => {
          for (const finding of createDiffer(rules).diffBodies(ref, cand)) {
            expect(() => parsePath(finding.path), finding.path).not.toThrow();
          }
        }),
        params,
      );
    },
  );

  it.fails(
    'a keyed unordered rule tells a number key from the string of its digits (known bug)',
    () => {
      // Known bug. keyValueText renders the number 1 and the string "1" as the same text, so
      // the rows { sku: 1 } and { sku: "1" } share one group, a permutation of them is
      // compared by position, and the differ reports a type mismatch at $.items[sku=1].sku.
      const rules = DiffRulesSchema.parse({ unordered: [{ path: '$.items', key: '$.sku' }] });
      const diff = createDiffer(rules).diff(
        jsonResponse({ items: [{ sku: 1 }, { sku: '1' }] }),
        jsonResponse({ items: [{ sku: '1' }, { sku: 1 }] }),
      );
      expect(diff).toEqual({ verdict: 'match', findings: [] });
    },
  );

  it('is deterministic: two runs on the same inputs give byte identical findings', () => {
    fc.assert(
      fc.property(rulesArb, responseArb, responseArb, (rules, ref, cand) => {
        const first = JSON.stringify(createDiffer(rules).diff(ref, cand));
        const second = JSON.stringify(createDiffer(rules).diff(ref, cand));
        expect(second).toBe(first);
      }),
      params,
    );
  });

  it('derives the verdict from the findings', () => {
    fc.assert(
      fc.property(rulesArb, responseArb, responseArb, (rules, ref, cand) => {
        const diff = createDiffer(rules).diff(ref, cand);
        if (diff.findings.length === 0) expect(diff.verdict).toBe('match');
        else if (diff.findings.every((f) => f.tolerated)) expect(diff.verdict).toBe('tolerated');
        else expect(diff.verdict).toBe('mismatch');
        for (const f of diff.findings) {
          if (f.tolerated) expect(f.rule).toBeDefined();
        }
      }),
      params,
    );
  });
});
