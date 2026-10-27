import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepEqual, isJsonObject, type JsonValue } from '../json.js';
import {
  get,
  keyValueText,
  matches,
  parsePath,
  renderPath,
  rowKeyText,
  select,
  type Segment,
} from './index.js';

/**
 * Property based tests for the JSONPath subset. Fixed seed, see
 * ../differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

/** Names the parser accepts after a dot. */
const identName = fc.stringMatching(/^[A-Za-z_$][A-Za-z0-9_$-]{0,5}$/);
/** Names that need the bracket form. */
const oddName = fc.oneof(
  fc.constantFrom('a b', '', 'q"t', 'a.b', 'a]b', "it's", 'back\\slash', '1', '-x', 'ünï'),
  fc.string({ unit: 'grapheme', maxLength: 4 }),
);
const keyName = fc.oneof(identName, oddName);

const keySegment: fc.Arbitrary<Segment> = keyName.map((name) => ({ type: 'key', name }));
const indexSegment: fc.Arbitrary<Segment> = fc
  .nat({ max: 20 })
  .map((index) => ({ type: 'index', index }));
const wildcardSegment: fc.Arbitrary<Segment> = fc.constant({ type: 'wildcard' });

/** Segments a rule may hold. */
const ruleSegments = fc.array(fc.oneof(keySegment, indexSegment, wildcardSegment), {
  maxLength: 5,
});

const KEYS = ['a', 'b', 'items', 'a b', '', 'q"t', 'x-y'];
const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom('', 'x', 'A-1'),
);
const { value: docArb } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}));

/** Key values and rows, with the strings that once broke the keyed segment syntax. */
const keyedJson: fc.Arbitrary<JsonValue> = fc.oneof(
  docArb,
  fc.constantFrom("it's", 'a"b', 'a b', 'a]b', 'a=b', 'a#1', 'back\\slash', '1', 'true', 'null'),
);
/**
 * Keyed segments as the differ renders them: the name is the key's name, bare
 * or quoted, and the value is the key text of any JSON value, or the row key
 * text of a row without the key.
 */
const keyedValue = fc.oneof(keyedJson.map(keyValueText), keyedJson.map(rowKeyText));
const keyedSegment: fc.Arbitrary<Segment> = fc
  .tuple(keyName, keyedValue, fc.nat({ max: 3 }))
  .map(([name, value, dup]) => ({ type: 'keyed', name, value, dup }));
/** Segments a concrete finding path may hold. */
const concreteSegments = fc.array(fc.oneof(keySegment, indexSegment, keyedSegment), {
  maxLength: 5,
});

/** Every concrete path in a document, including the root. */
function concretePaths(value: JsonValue, prefix: Segment[], out: Segment[][]): void {
  out.push(prefix);
  if (Array.isArray(value)) {
    value.forEach((item, index) => concretePaths(item, [...prefix, { type: 'index', index }], out));
  } else if (isJsonObject(value)) {
    for (const name of Object.keys(value)) {
      concretePaths(value[name] as JsonValue, [...prefix, { type: 'key', name }], out);
    }
  }
}

/** A document, one of its concrete paths, and that path with some segments replaced by wildcards. */
const docAndRule = docArb.chain((doc) => {
  const paths: Segment[][] = [];
  concretePaths(doc, [], paths);
  return fc.constantFrom(...paths).chain((concrete) =>
    fc
      .array(fc.boolean(), { minLength: concrete.length, maxLength: concrete.length })
      .map((mask) => ({
        doc,
        concrete,
        rule: concrete.map((s, i): Segment => (mask[i] ? { type: 'wildcard' } : s)),
      })),
  );
});

describe('parsePath and renderPath properties', () => {
  it('parsePath(renderPath(segments)) round trips rule and concrete segments', () => {
    fc.assert(
      fc.property(fc.oneof(ruleSegments, concreteSegments), (segments) => {
        expect(parsePath(renderPath(segments))).toEqual(segments);
      }),
      params,
    );
  });

  it('renderPath(parsePath(p)) is the identity on normalized paths', () => {
    fc.assert(
      fc.property(fc.oneof(ruleSegments, concreteSegments), (segments) => {
        const normalized = renderPath(segments);
        expect(renderPath(parsePath(normalized))).toBe(normalized);
      }),
      params,
    );
  });

  it('parses the alternative spellings to the same segments', () => {
    const plain = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,5}$/);
    fc.assert(
      fc.property(fc.array(fc.tuple(plain, fc.boolean()), { maxLength: 4 }), (parts) => {
        const dotted = `$${parts.map(([n, w]) => (w ? '.*' : `.${n}`)).join('')}`;
        const single = `$${parts.map(([n, w]) => (w ? '[*]' : `['${n}']`)).join('')}`;
        const double = `$${parts.map(([n, w]) => (w ? '[*]' : `["${n}"]`)).join('')}`;
        expect(parsePath(single)).toEqual(parsePath(dotted));
        expect(parsePath(double)).toEqual(parsePath(dotted));
        expect(renderPath(parsePath(single))).toBe(renderPath(parsePath(dotted)));
      }),
      params,
    );
  });
});

describe('matches properties', () => {
  it('a rule built by replacing segments of a concrete path with wildcards matches that path', () => {
    const cases = concreteSegments.chain((concrete) =>
      fc
        .array(fc.boolean(), { minLength: concrete.length, maxLength: concrete.length })
        .map((mask) => ({
          concrete,
          rule: concrete.map((s, i): Segment => (mask[i] ? { type: 'wildcard' } : s)),
        })),
    );
    fc.assert(
      fc.property(cases, ({ concrete, rule }) => {
        expect(matches(rule, concrete)).toBe(true);
        expect(matches(renderPath(rule), renderPath(concrete))).toBe(true);
        expect(matches(rule, [...concrete, { type: 'index', index: 0 }])).toBe(false);
        if (concrete.length > 0) expect(matches(rule, concrete.slice(0, -1))).toBe(false);
      }),
      params,
    );
  });
});

describe('select and get properties', () => {
  it('select returns only values that get reaches at their own concrete path, and finds the path the rule came from', () => {
    fc.assert(
      fc.property(docAndRule, ({ doc, concrete, rule }) => {
        const found = select(doc, rule);
        expect(found.map((m) => m.path)).toContain(renderPath(concrete));
        for (const m of found) {
          expect(parsePath(m.path)).toEqual(m.segments);
          expect(matches(rule, m.segments)).toBe(true);
          const reached = get(doc, m.path);
          expect(reached).toBeDefined();
          expect(deepEqual(reached as JsonValue, m.value)).toBe(true);
        }
        const first = found[0];
        if (first !== undefined) expect(get(doc, rule)).toBe(first.value);
      }),
      params,
    );
  });

  it('select on a rendered path returns the same matches as on its segments', () => {
    fc.assert(
      fc.property(docAndRule, ({ doc, rule }) => {
        expect(select(doc, renderPath(rule))).toEqual(select(doc, rule));
      }),
      params,
    );
  });
});
