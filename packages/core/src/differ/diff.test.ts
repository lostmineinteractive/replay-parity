import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../json.js';
import { parsePath, renderPath } from '../jsonpath/index.js';
import {
  parseDiffRules,
  emptyRules,
  type DiffRulesInput,
  DiffRulesSchema,
} from '../rules/schema.js';
import { jsonResponse, makeResponse } from '../testing.js';
import { createDiffer, mismatchPaths, type ValueEquivalences } from './diff.js';
import type { Finding } from './schema.js';

function differ(input: DiffRulesInput = {}) {
  return createDiffer(DiffRulesSchema.parse(input));
}

function bodies(
  ref: JsonValue,
  cand: JsonValue,
  input: DiffRulesInput = {},
  eq?: ValueEquivalences,
) {
  return differ(input).diff(jsonResponse(ref), jsonResponse(cand), eq);
}

function paths(findings: Finding[]): string[] {
  return findings.map((f) => f.path);
}

describe('verdicts', () => {
  it('matches identical responses', () => {
    const d = bodies({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 });
    expect(d).toEqual({ verdict: 'match', findings: [] });
  });

  it('is tolerated when every finding is covered by a rule', () => {
    const d = bodies(
      { total: 1.0 },
      { total: 1.004 },
      { tolerances: [{ path: '$.total', abs: 0.005 }] },
    );
    expect(d.verdict).toBe('tolerated');
    expect(d.findings[0]).toMatchObject({
      path: '$.total',
      tolerated: true,
      rule: 'tolerances[0]',
    });
  });

  it('mismatches when any finding is not covered', () => {
    const d = bodies(
      { total: 1.0, other: 'a' },
      { total: 1.004, other: 'b' },
      { tolerances: [{ path: '$.total', abs: 0.005 }] },
    );
    expect(d.verdict).toBe('mismatch');
    expect(mismatchPaths(d)).toEqual(['$.other']);
  });
});

describe('ignore', () => {
  it('drops ignored paths including wildcards and missing keys', () => {
    const rules = { ignore: ['$.request_id', '$.timestamps.*'] };
    const d = bodies(
      { request_id: 'r1', timestamps: { a: 1, b: 2 }, x: 1 },
      { timestamps: { a: 9, c: 3 }, x: 1 },
      rules,
    );
    expect(d.verdict).toBe('match');
  });

  it('still reports differences outside the ignored path', () => {
    const d = bodies({ a: { id: 1, v: 1 } }, { a: { id: 2, v: 2 } }, { ignore: ['$.a.id'] });
    expect(paths(d.findings)).toEqual(['$.a.v']);
  });
});

describe('tolerances', () => {
  it('applies absolute and relative tolerances', () => {
    expect(
      bodies({ v: 100 }, { v: 100.004 }, { tolerances: [{ path: '$.v', abs: 0.005 }] }).verdict,
    ).toBe('tolerated');
    expect(
      bodies({ v: 100 }, { v: 100.006 }, { tolerances: [{ path: '$.v', abs: 0.005 }] }).verdict,
    ).toBe('mismatch');
    expect(
      bodies({ v: 1000 }, { v: 1000.05 }, { tolerances: [{ path: '$.v', rel: 0.0001 }] }).verdict,
    ).toBe('tolerated');
    expect(
      bodies({ v: 1000 }, { v: 1000.2 }, { tolerances: [{ path: '$.v', rel: 0.0001 }] }).verdict,
    ).toBe('mismatch');
  });

  it('passes when either abs or rel is satisfied', () => {
    const rules = { tolerances: [{ path: '$.v', abs: 0.001, rel: 0.01 }] };
    expect(bodies({ v: 1000 }, { v: 1005 }, rules).verdict).toBe('tolerated');
    expect(bodies({ v: 0.1 }, { v: 0.1009 }, rules).verdict).toBe('tolerated');
    expect(bodies({ v: 1000 }, { v: 1020 }, rules).verdict).toBe('mismatch');
  });

  it('describes why a value was or was not tolerated', () => {
    const rules = { tolerances: [{ path: '$.v', abs: 0.005 }] };
    expect(bodies({ v: 1 }, { v: 1.001 }, rules).findings[0]?.detail).toBe('within abs 0.005');
    expect(bodies({ v: 1 }, { v: 2 }, rules).findings[0]?.detail).toBe(
      'outside abs 0.005 of tolerances[0]',
    );
    expect(bodies({ v: 1 }, { v: 2 }).findings[0]?.detail).toBe(
      'no tolerance rule covers this path',
    );
  });

  it('does not tolerate non numeric values at a tolerance path', () => {
    const rules = { tolerances: [{ path: '$.v', abs: 1 }] };
    expect(bodies({ v: 'a' }, { v: 'b' }, rules).findings[0]).toMatchObject({
      kind: 'value',
      tolerated: false,
    });
    expect(bodies({ v: 1 }, { v: '1' }, rules).findings[0]).toMatchObject({
      kind: 'type',
      tolerated: false,
    });
  });

  it('matches wildcard tolerance paths', () => {
    const rules = { tolerances: [{ path: '$.items[*].unit_price', rel: 0.0001 }] };
    const d = bodies(
      { items: [{ unit_price: 10 }, { unit_price: 20 }] },
      { items: [{ unit_price: 10.0005 }, { unit_price: 20.001 }] },
      rules,
    );
    expect(d.verdict).toBe('tolerated');
    expect(paths(d.findings)).toEqual(['$.items[0].unit_price', '$.items[1].unit_price']);
  });
});

describe('arrays', () => {
  it('compares ordered arrays by index and reports tails', () => {
    const d = bodies({ a: [1, 2, 3] }, { a: [1, 9] });
    expect(d.findings).toEqual([
      {
        path: '$.a[1]',
        kind: 'value',
        tolerated: false,
        reference: 2,
        candidate: 9,
        detail: 'no tolerance rule covers this path',
      },
      { path: '$.a[2]', kind: 'missing', tolerated: false, reference: 3 },
    ]);
    const extra = bodies({ a: [1] }, { a: [1, 2] });
    expect(extra.findings).toEqual([
      { path: '$.a[1]', kind: 'unexpected', tolerated: false, candidate: 2 },
    ]);
  });

  it('compares keyed unordered arrays as sets', () => {
    const rules = { unordered: [{ path: '$.items', key: '$.sku' }] };
    const ref = {
      items: [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 2 },
      ],
    };
    const sameDifferentOrder = {
      items: [
        { sku: 'B', qty: 2 },
        { sku: 'A', qty: 1 },
      ],
    };
    expect(bodies(ref, sameDifferentOrder, rules).verdict).toBe('match');
    expect(bodies(ref, sameDifferentOrder).verdict).toBe('mismatch');

    const changed = {
      items: [
        { sku: 'B', qty: 5 },
        { sku: 'C', qty: 1 },
      ],
    };
    const d = bodies(ref, changed, rules);
    expect(d.findings).toEqual([
      {
        path: '$.items[sku=A]',
        kind: 'missing',
        tolerated: false,
        reference: { sku: 'A', qty: 1 },
      },
      {
        path: '$.items[sku=B].qty',
        kind: 'value',
        tolerated: false,
        reference: 2,
        candidate: 5,
        detail: 'no tolerance rule covers this path',
      },
      {
        path: '$.items[sku=C]',
        kind: 'unexpected',
        tolerated: false,
        candidate: { sku: 'C', qty: 1 },
      },
    ]);
  });

  it('handles duplicate keys and elements without the key', () => {
    const rules = { unordered: [{ path: '$.items', key: '$.sku' }] };
    const ref = { items: [{ sku: 'A', qty: 1 }, { sku: 'A', qty: 2 }, { qty: 3 }] };
    const cand = { items: [{ qty: 3 }, { sku: 'A', qty: 2 }, { sku: 'A', qty: 1 }] };
    const d = bodies(ref, cand, rules);
    expect(paths(d.findings)).toEqual(['$.items[sku=A].qty', '$.items[sku=A#1].qty']);
    expect(bodies(ref, ref, rules).verdict).toBe('match');
  });

  it('renders keyed segments that read back for keys the syntax cannot hold bare', () => {
    const rules = { unordered: [{ path: '$.items', key: '$.sku' }] };
    const ref = {
      items: [
        { sku: "it's", v: 1 },
        { sku: 'a"b', v: 1 },
        { sku: [1, 2], v: 1 },
        { sku: { a: [1] }, v: 1 },
        { sku: 'a b', v: 1 },
        { v: 1 },
      ],
    };
    const cand = { items: ref.items.map((row) => ({ ...row, v: 2 })) };
    const d = bodies(ref, cand, rules);
    expect(paths(d.findings)).toEqual([
      '$.items[sku="a b"].v',
      '$.items[sku="a\\"b"].v',
      '$.items[sku="it\'s"].v',
      '$.items[sku=#\'{"v":1}\']',
      '$.items[sku=#\'{"v":2}\']',
      "$.items[sku='[1,2]'].v",
      '$.items[sku=\'{"a":[1]}\'].v',
    ]);
    for (const path of paths(d.findings)) {
      expect(renderPath(parsePath(path)), path).toBe(path);
    }
    const bracket = bodies(
      { items: [{ 'a b': 'X', v: 1 }] },
      { items: [{ 'a b': 'X', v: 2 }] },
      { unordered: [{ path: '$.items', key: "$['a b']" }] },
    );
    expect(paths(bracket.findings)).toEqual(['$.items["a b"=X].v']);
    const deep = bodies(
      { items: [{ k: { id: 'X' }, v: 1 }] },
      { items: [{ k: { id: 'X' }, v: 2 }] },
      { unordered: [{ path: '$.items', key: '$.k.id' }] },
    );
    expect(paths(deep.findings)).toEqual(['$.items["k.id"=X].v']);
  });

  it('tells a string key from the number, boolean, or null it spells', () => {
    const rules = { unordered: [{ path: '$.items', key: '$.sku' }] };
    const ref = {
      items: [
        { sku: 1, v: 1 },
        { sku: '1', v: 1 },
        { sku: true, v: 1 },
        { sku: 'true', v: 1 },
        { sku: null, v: 1 },
        { sku: 'null', v: 1 },
        { sku: -2.5, v: 1 },
        { sku: '-2.5', v: 1 },
      ],
    };
    const permuted = { items: [...ref.items].reverse() };
    expect(bodies(ref, permuted, rules)).toEqual({ verdict: 'match', findings: [] });
    const changed = { items: ref.items.map((row) => ({ ...row, v: 2 })).reverse() };
    expect(paths(bodies(ref, changed, rules).findings)).toEqual([
      '$.items[sku="-2.5"].v',
      '$.items[sku="1"].v',
      '$.items[sku="null"].v',
      '$.items[sku="true"].v',
      '$.items[sku=-2.5].v',
      '$.items[sku=1].v',
      '$.items[sku=null].v',
      '$.items[sku=true].v',
    ]);
  });

  it('nested tolerance rules still apply inside keyed segments', () => {
    const rules = {
      unordered: [{ path: '$.items', key: '$.sku' }],
      tolerances: [{ path: '$.items[*].price', abs: 0.01 }],
    };
    const d = bodies(
      { items: [{ sku: 'A', price: 1 }] },
      { items: [{ sku: 'A', price: 1.005 }] },
      rules,
    );
    expect(d.verdict).toBe('tolerated');
    expect(d.findings[0]?.path).toBe('$.items[sku=A].price');
  });

  it('compares keyless unordered arrays as multisets', () => {
    const rules = { unordered: [{ path: '$.tags' }] };
    expect(bodies({ tags: ['a', 'b', 'b'] }, { tags: ['b', 'a', 'b'] }, rules).verdict).toBe(
      'match',
    );
    const d = bodies({ tags: ['a', 'b', 'b'] }, { tags: ['b', 'c'] }, rules);
    expect(d.findings).toEqual([
      { path: '$.tags[0]', kind: 'missing', tolerated: false, reference: 'a' },
      { path: '$.tags[2]', kind: 'missing', tolerated: false, reference: 'b' },
      { path: '$.tags[1]', kind: 'unexpected', tolerated: false, candidate: 'c' },
    ]);
  });
});

describe('objects and types', () => {
  it('reports missing and unexpected keys', () => {
    const d = bodies({ a: 1, b: 2 }, { b: 2, c: 3 });
    expect(d.findings).toEqual([
      { path: '$.a', kind: 'missing', tolerated: false, reference: 1 },
      { path: '$.c', kind: 'unexpected', tolerated: false, candidate: 3 },
    ]);
  });

  it('reports type changes', () => {
    expect(bodies({ a: 1 }, { a: '1' }).findings[0]).toMatchObject({
      kind: 'type',
      detail: 'reference is number, candidate is string',
    });
    expect(bodies({ a: null }, { a: {} }).findings[0]).toMatchObject({
      kind: 'type',
      detail: 'reference is null, candidate is object',
    });
    expect(bodies({ a: [] }, { a: {} }).findings[0]).toMatchObject({
      kind: 'type',
      detail: 'reference is array, candidate is object',
    });
    expect(bodies({ a: true }, { a: false }).findings[0]).toMatchObject({
      kind: 'value',
      reference: true,
      candidate: false,
    });
  });

  it('reports a differing root scalar', () => {
    expect(bodies('a', 'b').findings[0]?.path).toBe('$');
  });
});

describe('status and headers', () => {
  it('mismatches on status unless the pair is in an equivalence class', () => {
    const d = differ().diff(
      makeResponse({ status: 404, body: { e: 1 } }),
      makeResponse({ status: 200, body: { e: 1 } }),
    );
    expect(d.verdict).toBe('mismatch');
    expect(d.findings).toEqual([
      { path: 'status', kind: 'status', tolerated: false, reference: 404, candidate: 200 },
    ]);

    const tolerant = differ({ status: { equivalent: [[200, 201]] } }).diff(
      makeResponse({ status: 200 }),
      makeResponse({ status: 201 }),
    );
    expect(tolerant.verdict).toBe('tolerated');
    expect(tolerant.findings[0]?.rule).toBe('status.equivalent[0]');
  });

  it('compares only the listed headers', () => {
    const ref = makeResponse({ headers: { 'content-type': 'application/json', 'x-a': '1' } });
    const cand = makeResponse({ headers: { 'content-type': 'text/plain', 'x-a': '2' } });
    expect(differ().diff(ref, cand).verdict).toBe('match');
    const d = differ({ headers: { compare: ['Content-Type'] } }).diff(ref, cand);
    expect(d.findings).toEqual([
      {
        path: 'header:content-type',
        kind: 'header',
        tolerated: false,
        reference: 'application/json',
        candidate: 'text/plain',
      },
    ]);
    const missing = differ({ headers: { compare: ['x-b'] } }).diff(
      makeResponse({ headers: { 'x-b': 'v' } }),
      makeResponse({ headers: {} }),
    );
    expect(missing.findings[0]).toEqual({
      path: 'header:x-b',
      kind: 'header',
      tolerated: false,
      reference: 'v',
    });
  });
});

describe('body kinds', () => {
  const absent = makeResponse({ body: undefined });
  const json = makeResponse({ body: { a: 1 } });
  const bin = (text: string) =>
    makeResponse({ body: Buffer.from(text).toString('base64'), encoding: 'base64' });
  const truncated = makeResponse({
    body: undefined,
    truncated: true,
    body_sha256: 'a'.repeat(64),
    body_size: 5_000_000,
  });

  it('treats two absent bodies as equal', () => {
    expect(differ().diff(absent, absent).verdict).toBe('match');
  });

  it('reports a missing or extra body at the root', () => {
    expect(differ().diff(json, absent).findings).toEqual([
      {
        path: '$',
        kind: 'missing',
        tolerated: false,
        reference: { a: 1 },
        detail: 'reference body is json, candidate body is absent',
      },
    ]);
    expect(differ().diff(absent, json).findings).toEqual([
      {
        path: '$',
        kind: 'unexpected',
        tolerated: false,
        candidate: { a: 1 },
        detail: 'reference body is absent, candidate body is json',
      },
    ]);
  });

  it('reports a format change between json and binary', () => {
    expect(differ().diff(json, bin('x')).findings[0]).toMatchObject({
      path: '$',
      kind: 'body_format',
    });
  });

  it('compares binary bodies by bytes', () => {
    expect(differ().diff(bin('same'), bin('same')).verdict).toBe('match');
    const d = differ().diff(bin('abc'), bin('abcd'));
    expect(d.findings).toEqual([
      {
        path: '$',
        kind: 'value',
        tolerated: false,
        detail: 'binary bodies differ (reference 3 bytes, candidate 4 bytes)',
      },
    ]);
  });

  it('never diffs a truncated body and reports it as a mismatch', () => {
    for (const [r, c] of [
      [truncated, json],
      [json, truncated],
      [truncated, truncated],
    ] as const) {
      const d = differ().diff(r, c);
      expect(d.verdict).toBe('mismatch');
      expect(d.findings).toHaveLength(1);
      expect(d.findings[0]).toMatchObject({ path: '$', kind: 'body_too_large', tolerated: false });
      expect(d.findings[0]?.detail).toContain('5000000 bytes');
    }
  });
});

describe('substitution equivalences', () => {
  const eq: ValueEquivalences = new Map([['order_id', new Map([['"o-1"', '"o-7"']])]]);

  it('tolerates a mapped pair and names the substitution', () => {
    const d = bodies({ order_id: 'o-1', total: 1 }, { order_id: 'o-7', total: 1 }, {}, eq);
    expect(d.verdict).toBe('tolerated');
    expect(d.findings[0]).toMatchObject({
      path: '$.order_id',
      rule: 'substitution:order_id',
      tolerated: true,
    });
  });

  it('does not tolerate an unmapped pair or the reverse direction', () => {
    expect(bodies({ order_id: 'o-1' }, { order_id: 'o-8' }, {}, eq).verdict).toBe('mismatch');
    expect(bodies({ order_id: 'o-7' }, { order_id: 'o-1' }, {}, eq).verdict).toBe('mismatch');
    expect(bodies({ order_id: 'o-1' }, { order_id: 'o-7' }).verdict).toBe('mismatch');
  });
});

describe('determinism', () => {
  it('produces identical findings regardless of key order', () => {
    const ref = { z: 1, a: { y: [1, 2], x: 'p' }, m: 3 };
    const cand = { a: { x: 'q', y: [1, 3] }, m: 4, z: 1 };
    const first = JSON.stringify(bodies(ref, cand));
    const second = JSON.stringify(
      bodies(JSON.parse(JSON.stringify(ref)) as JsonValue, {
        z: 1,
        m: 4,
        a: { y: [1, 3], x: 'q' },
      }),
    );
    expect(first).toBe(second);
    expect(paths(bodies(ref, cand).findings)).toEqual(['$.a.x', '$.a.y[1]', '$.m']);
  });
});

describe('diffBodies and parsed rules', () => {
  it('diffs bare JSON values', () => {
    const findings = differ().diffBodies({ a: 1 }, { a: 2 });
    expect(findings).toHaveLength(1);
    expect(differ().diffBodies(undefined, undefined)).toEqual([]);
  });

  it('works with rules parsed from YAML and exposes them', () => {
    const rules = parseDiffRules('unordered:\n  - path: "$.items"\n    key: "$.sku"\n');
    const d = createDiffer(rules);
    expect(d.rules).toBe(rules);
    expect(
      d.diff(
        jsonResponse({ items: [{ sku: 'A' }, { sku: 'B' }] }),
        jsonResponse({ items: [{ sku: 'B' }, { sku: 'A' }] }),
      ).verdict,
    ).toBe('match');
    expect(createDiffer(emptyRules()).rules.ignore).toEqual([]);
  });
});

describe('diffStatus', () => {
  it('compares the status alone and honors equivalence classes', () => {
    const differ = createDiffer(parseDiffRules('status:\n  equivalent:\n    - [200, 201]\n'));
    const ref = jsonResponse({ restarted: true }, 200);
    expect(differ.diffStatus(ref, jsonResponse({ different: 1 }, 200))).toEqual({
      verdict: 'match',
      findings: [],
    });
    expect(differ.diffStatus(ref, jsonResponse({}, 201)).verdict).toBe('tolerated');
    const mismatch = differ.diffStatus(ref, jsonResponse({}, 500));
    expect(mismatch.verdict).toBe('mismatch');
    expect(mismatch.findings).toEqual([
      { path: 'status', kind: 'status', tolerated: false, reference: 200, candidate: 500 },
    ]);
  });
});
