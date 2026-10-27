import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, deepEqual, isJsonObject, type JsonObject, type JsonValue } from './json.js';

/**
 * Property based tests for the JSON helpers. Fixed seed, see
 * differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

const KEYS = ['a', 'b', 'c', 'id', 'a b', '', 'q"t', 'ü'];

const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 3 }),
  fc
    .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
    .map((x) => (x === 0 ? 0 : x)),
  fc.string({ maxLength: 4 }),
);

const { value: jsonValue } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

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

/** Structural equality written independently of canonicalJson: same shape, same leaves, any key order. */
function structurallyEqual(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => structurallyEqual(v, b[i] as JsonValue))
    );
  }
  if (isJsonObject(a)) {
    if (!isJsonObject(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && structurallyEqual(a[k] as JsonValue, b[k] as JsonValue))
    );
  }
  return a === b;
}

/** Rewrites one leaf or drops one key, so the pair is usually but not always unequal. */
function mutate(value: JsonValue, next: () => number): JsonValue {
  if (Array.isArray(value)) {
    if (value.length === 0) return [null];
    const i = Math.floor(next() * value.length);
    return value.map((v, k) => (k === i ? mutate(v, next) : v));
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return { a: 1 };
    const k = keys[Math.floor(next() * keys.length)] as string;
    const out: JsonObject = { ...value };
    if (next() < 0.3) {
      delete out[k];
    } else {
      out[k] = mutate(value[k] as JsonValue, next);
    }
    return out;
  }
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}!`;
  if (typeof value === 'boolean') return !value;
  return 0;
}

/** Deep sort of keys, so JSON.stringify gives the canonical form. */
function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k] as JsonValue);
    return out;
  }
  return value;
}

/** Pairs that are equal, independent, or one mutation apart. */
const pairArb: fc.Arbitrary<[JsonValue, JsonValue]> = fc.oneof(
  fc
    .tuple(jsonValue, fc.nat())
    .map(([v, s]): [JsonValue, JsonValue] => [v, permuteKeys(v, lcg(s))]),
  fc.tuple(jsonValue, jsonValue),
  fc.tuple(jsonValue, fc.nat()).map(([v, s]): [JsonValue, JsonValue] => [v, mutate(v, lcg(s))]),
);

describe('canonicalJson properties', () => {
  it('is independent of key insertion order', () => {
    fc.assert(
      fc.property(jsonValue, fc.nat(), (v, s) => {
        expect(canonicalJson(permuteKeys(v, lcg(s)))).toBe(canonicalJson(v));
      }),
      params,
    );
  });

  it('is JSON.stringify with keys sorted at every level, and parses back to the value', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const text = canonicalJson(v);
        expect(text).toBe(JSON.stringify(sortKeys(v)));
        expect(structurallyEqual(JSON.parse(text) as JsonValue, v)).toBe(true);
      }),
      params,
    );
  });
});

describe('deepEqual properties', () => {
  it('agrees with structural equality', () => {
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        expect(deepEqual(a, b)).toBe(structurallyEqual(a, b));
        expect(deepEqual(b, a)).toBe(deepEqual(a, b));
      }),
      params,
    );
  });

  it('holds exactly when the canonical texts are equal', () => {
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        expect(canonicalJson(a) === canonicalJson(b)).toBe(deepEqual(a, b));
      }),
      params,
    );
  });
});
