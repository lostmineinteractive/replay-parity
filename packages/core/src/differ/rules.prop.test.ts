import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../json.js';
import { matches, matchesIn, parsePath } from '../jsonpath/index.js';
import type { RecordedResponse } from '../recording/types.js';
import { DiffRulesSchema, type DiffRules, type DiffRulesInput } from '../rules/schema.js';
import type { DiffContext } from '../rules/scope.js';
import { makeResponse } from '../testing.js';
import { createDiffer } from './diff.js';
import type { Diff } from './schema.js';

/**
 * Properties of the scoped rules and the rule kinds beyond ignore,
 * tolerances, and unordered. Every property runs with the fixed seed below;
 * on a failure fast-check prints the seed, the path, and the shrunk
 * counterexample.
 */
const params = { seed: 20261103, numRuns: 200 };

const KEYS = ['a', 'b', 'id', 'at', 'n', 'type', 'items'];
const TEXTS = [
  '',
  'x',
  'fee',
  'item',
  '1',
  '1.0',
  '1.005',
  '-2.50',
  '2026-10-16T20:50:45Z',
  'ord_1a',
];

const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom(0.5, 1.005, 29.9, 1_700_000_000_000),
  fc.constantFrom(...TEXTS),
);

const { value: jsonValue } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}));

const key = fc.constantFrom(...KEYS);
const literal = fc.oneof(
  fc.constantFrom("'fee'", "'item'", '"x"'),
  fc.constantFrom('1', '-2', '0.5'),
);
const segment = fc.oneof(
  key.map((k) => `.${k}`),
  fc.integer({ min: 0, max: 2 }).map((i) => `[${i}]`),
  fc.constant('[*]'),
  fc.tuple(key, fc.constantFrom('==', '!='), literal).map(([k, op, l]) => `[?(@.${k}${op}${l})]`),
  key.map((k) => `..${k}`),
);
const rulePath = fc.array(segment, { maxLength: 3 }).map((segs) => `$${segs.join('')}`);

const TAGS = ['t1', 't2'];
const whenArb = fc.option(
  fc.oneof(
    fc.record({ tags: fc.subarray(TAGS, { minLength: 1 }) }),
    fc.record({ methods: fc.subarray(['GET', 'POST'], { minLength: 1 }) }),
    fc.record({ paths: fc.subarray(['/v1/*', '/v2/**'], { minLength: 1 }) }),
  ),
  { nil: undefined },
);

function scoped<T extends object>(arb: fc.Arbitrary<T>): fc.Arbitrary<T> {
  return fc.tuple(arb, whenArb).map(([r, when]): T => (when === undefined ? r : { ...r, when }));
}

/** One arbitrary per rule kind, so each kind is exercised alone as well as together. */
const kinds: Record<string, fc.Arbitrary<DiffRulesInput>> = {
  ignore: fc
    .array(fc.oneof(rulePath, scoped(rulePath.map((path) => ({ path })))), { maxLength: 2 })
    .map((ignore) => ({ ignore })),
  tolerances: fc
    .array(scoped(fc.record({ path: rulePath, abs: fc.constantFrom(0, 0.5, 2) })), { maxLength: 2 })
    .map((tolerances) => ({ tolerances })),
  unordered: fc
    .array(
      scoped(
        fc.record(
          { path: rulePath, key: fc.constantFrom('$.id', '$.type') },
          { requiredKeys: ['path'] },
        ),
      ),
      { maxLength: 2 },
    )
    .map((unordered) => ({ unordered })),
  extra_fields: fc
    .tuple(
      fc.constantFrom('allow' as const, 'deny' as const),
      fc.array(scoped(fc.record({ allow: fc.boolean() })), { maxLength: 2 }),
    )
    .map(([extra_fields, extra_fields_rules]) => ({ extra_fields, extra_fields_rules })),
  equivalences: fc
    .array(
      scoped(
        fc.record({
          null_absent: fc.boolean(),
          empty_absent: fc.boolean(),
          numeric_strings: fc.boolean(),
        }),
      ),
      { minLength: 1, maxLength: 2 },
    )
    .map((equivalences) => ({ equivalences })),
  decimal: fc
    .array(scoped(fc.record({ path: rulePath, scale: fc.integer({ min: 0, max: 3 }) })), {
      maxLength: 2,
    })
    .map((decimal) => ({ decimal })),
  time: fc
    .array(
      scoped(
        fc.record({
          path: rulePath,
          abs_ms: fc.constantFrom(0, 1000),
          format: fc.constantFrom('iso8601' as const, 'epoch_ms' as const, 'epoch_s' as const),
        }),
      ),
      { maxLength: 2 },
    )
    .map((time) => ({ time })),
  mask: fc
    .array(
      scoped(fc.record({ path: rulePath, pattern: fc.constantFrom('.*', '[a-z_0-9]+', '\\d') })),
      { maxLength: 2 },
    )
    .map((mask) => ({ mask })),
  headers: fc
    .record({
      compare: fc.subarray(['x-a', 'x-b']),
      ignore: fc.subarray(['x-b']),
      masks: fc.array(
        scoped(
          fc.record({ name: fc.constantFrom('x-a', 'x-b'), pattern: fc.constantFrom('\\d', '.*') }),
        ),
        { maxLength: 1 },
      ),
    })
    .map((headers) => ({ headers })),
  status: fc
    .array(
      fc.oneof(
        fc.constant([200, 201]).map((c) => [...c]),
        scoped(fc.record({ classes: fc.constant([[200, 201]]).map((c) => c.map((x) => [...x])) })),
      ),
      { maxLength: 2 },
    )
    .map((equivalent) => ({ status: { equivalent } })),
};

const allKinds: fc.Arbitrary<DiffRules> = fc
  .tuple(...Object.values(kinds))
  .map((parts) => DiffRulesSchema.parse(Object.assign({}, ...parts)));

const contextArb: fc.Arbitrary<DiffContext | undefined> = fc.option(
  fc.record({
    tags: fc.subarray(TAGS),
    method: fc.constantFrom('GET', 'POST'),
    path: fc.constantFrom('/v1/a', '/v2/a/b', '/v3'),
  }),
  { nil: undefined },
);

const responseArb: fc.Arbitrary<RecordedResponse> = fc
  .tuple(
    fc.constantFrom(200, 201, 404),
    fc.dictionary(fc.constantFrom('x-a', 'x-b'), fc.constantFrom('1', '2', 'v'), { maxKeys: 2 }),
    jsonValue,
  )
  .map(([status, headers, body]) => makeResponse({ status, headers: { ...headers }, body }));

describe('rule kind properties', () => {
  for (const [kind, arb] of Object.entries(kinds)) {
    it(`${kind}: two runs on the same inputs give byte identical findings`, () => {
      fc.assert(
        fc.property(
          arb.map((input) => DiffRulesSchema.parse(input)),
          responseArb,
          responseArb,
          contextArb,
          (rules, ref, cand, context) => {
            const first = JSON.stringify(createDiffer(rules).diff(ref, cand, undefined, context));
            const second = JSON.stringify(createDiffer(rules).diff(ref, cand, undefined, context));
            expect(second).toBe(first);
          },
        ),
        params,
      );
    });
  }

  it('every kind together: deterministic, and diff(x, x) is a match', () => {
    fc.assert(
      fc.property(allKinds, responseArb, responseArb, contextArb, (rules, ref, cand, context) => {
        const differ = createDiffer(rules);
        const first = JSON.stringify(differ.diff(ref, cand, undefined, context));
        expect(JSON.stringify(createDiffer(rules).diff(ref, cand, undefined, context))).toBe(first);
        expect(differ.diff(ref, ref, undefined, context)).toEqual({
          verdict: 'match',
          findings: [],
        });
        for (const f of differ.diff(ref, cand, undefined, context).findings) {
          if (f.tolerated)
            expect(f.rule).toMatch(/^[a-z_.]+(\[\d+\])*(\.[a-z_]+(\[\d+\])*)*$|^substitution:/);
        }
      }),
      params,
    );
  });

  it('a rule whose scope does not match changes nothing', () => {
    fc.assert(
      fc.property(allKinds, responseArb, responseArb, (rules, ref, cand) => {
        // A context that no generated `when` matches: no tags, an unused method, an unused path.
        const nowhere: DiffContext = { tags: [], method: 'PATCH', path: '/none' };
        // Removing entries renumbers the rest, so rule names and details are left out.
        const globalOnly = stripScoped(rules);
        expect(outcome(createDiffer(rules).diff(ref, cand, undefined, nowhere))).toEqual(
          outcome(createDiffer(globalOnly).diff(ref, cand, undefined, nowhere)),
        );
        // Without a context every rule applies, as if none were scoped.
        expect(createDiffer(rules).diff(ref, cand)).toEqual(
          createDiffer(unscoped(rules)).diff(ref, cand),
        );
      }),
      params,
    );
  });

  it('no finding lies under a path an active ignore rule matches', () => {
    fc.assert(
      fc.property(allKinds, rulePath, responseArb, responseArb, (rules, ignored, ref, cand) => {
        const withIgnore = DiffRulesSchema.parse({ ...rules, ignore: [...rules.ignore, ignored] });
        const segs = parsePath(ignored);
        for (const f of createDiffer(withIgnore).diff(ref, cand).findings) {
          if (f.path === 'status' || f.path.startsWith('header:')) continue;
          const concrete = parsePath(f.path);
          // A missing value is read from the reference and an extra one from the candidate.
          const docs: JsonValue[] = [];
          if (f.kind !== 'unexpected') docs.push(ref.body as JsonValue);
          if (f.kind !== 'missing') docs.push(cand.body as JsonValue);
          for (let n = 0; n <= concrete.length; n += 1) {
            const prefix = concrete.slice(0, n);
            const hit = matches(segs, prefix) || docs.some((doc) => matchesIn(segs, prefix, doc));
            expect(hit, `${f.path} under ${ignored}`).toBe(false);
          }
        }
      }),
      params,
    );
  });
});

/** Each finding without its rule name and detail. */
function outcome(diff: Diff): unknown {
  return [
    diff.verdict,
    diff.findings.map((f) => [
      f.path,
      f.kind,
      f.tolerated,
      f.reference ?? null,
      f.candidate ?? null,
    ]),
  ];
}

/** The rules with every scope removed, so every entry is global under the same name. */
function unscoped(rules: DiffRules): DiffRules {
  return JSON.parse(
    JSON.stringify(rules, (k, v: unknown) => (k === 'when' ? undefined : v)),
  ) as DiffRules;
}

/** The rules with every scoped entry removed. */
function stripScoped(rules: DiffRules): DiffRules {
  const global = <T>(list: readonly T[]): T[] =>
    list.filter(
      (r) =>
        typeof r !== 'object' ||
        r === null ||
        Array.isArray(r) ||
        !('when' in r) ||
        r.when === undefined,
    );
  return {
    ...rules,
    ignore: global(rules.ignore),
    tolerances: global(rules.tolerances),
    unordered: global(rules.unordered),
    decimal: global(rules.decimal),
    time: global(rules.time),
    mask: global(rules.mask),
    extra_fields_rules: global(rules.extra_fields_rules),
    equivalences: Array.isArray(rules.equivalences)
      ? global(rules.equivalences)
      : rules.equivalences,
    status: { equivalent: global(rules.status.equivalent) },
    headers: {
      compare: global(rules.headers.compare),
      ignore: global(rules.headers.ignore),
      masks: global(rules.headers.masks),
    },
  };
}

describe('rule kinds inside unordered arrays', () => {
  it('a keyed permutation with reformatted decimals and shifted times is never a mismatch', () => {
    const rules = DiffRulesSchema.parse({
      unordered: [{ path: '$.items', key: '$.id' }],
      decimal: [{ path: '$.items[*].amount', scale: 2 }],
      time: [{ path: '$..at', abs_ms: 1000, format: 'epoch_ms' }],
    });
    const rowArb = fc.record({
      cents: fc.integer({ min: -100_000, max: 100_000 }),
      at: fc.integer({ min: 0, max: 1_000_000 }),
      shift: fc.integer({ min: -1000, max: 1000 }),
    });
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 5 }).chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.shuffledSubarray(
              rows.map((_, i) => i),
              { minLength: rows.length, maxLength: rows.length },
            ),
          ),
        ),
        ([rows, order]) => {
          const ref = rows.map((r, i) => ({ id: `r${i}`, amount: r.cents / 100, at: r.at }));
          const cand = order.map((i) => {
            const r = rows[i] as (typeof rows)[number];
            const text = `${r.cents < 0 ? '-' : ''}${Math.floor(Math.abs(r.cents) / 100)}.${String(Math.abs(r.cents) % 100).padStart(2, '0')}0`;
            return { id: `r${i}`, amount: text, at: r.at + r.shift };
          });
          const diff = createDiffer(rules).diff(
            makeResponse({ body: { items: ref } }),
            makeResponse({ body: { items: cand } }),
          );
          expect(diff.verdict).not.toBe('mismatch');
        },
      ),
      params,
    );
  });
});
