import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../json.js';
import { DiffRulesSchema, type DiffRulesInput } from '../rules/schema.js';
import type { DiffContext } from '../rules/scope.js';
import { jsonResponse, makeResponse } from '../testing.js';
import { createDiffer } from './diff.js';
import { explainFinding } from './explain.js';
import type { Finding } from './schema.js';

/** Unit tests for the scoped rules and the rule kinds beyond ignore, tolerances, and unordered. */

function differ(input: DiffRulesInput = {}) {
  return createDiffer(DiffRulesSchema.parse(input));
}

function bodies(ref: JsonValue, cand: JsonValue, input: DiffRulesInput, context?: DiffContext) {
  return differ(input).diff(jsonResponse(ref), jsonResponse(cand), undefined, context);
}

const LIST: DiffContext = { tags: ['list-inventory'], method: 'GET', path: '/v1/inventory' };
const CREATE: DiffContext = { tags: ['create-order'], method: 'POST', path: '/v1/orders' };

function only(findings: Finding[]): Finding {
  expect(findings).toHaveLength(1);
  return findings[0] as Finding;
}

describe('scope', () => {
  it('applies a scoped rule only when the context matches, and always without a context', () => {
    const rules = { ignore: [{ path: '$.at', when: { tags: ['list-inventory'] } }] };
    expect(bodies({ at: 1 }, { at: 2 }, rules, LIST).verdict).toBe('match');
    expect(bodies({ at: 1 }, { at: 2 }, rules, CREATE).verdict).toBe('mismatch');
    expect(bodies({ at: 1 }, { at: 2 }, rules, {}).verdict).toBe('mismatch');
    expect(bodies({ at: 1 }, { at: 2 }, rules).verdict).toBe('match');
  });

  it('requires every criterion given: a tag, a method, and a path glob', () => {
    const when = { tags: ['list-inventory'], methods: ['get'], paths: ['/v1/*'] };
    const rules = { ignore: [{ path: '$.at', when }] };
    expect(bodies({ at: 1 }, { at: 2 }, rules, LIST).verdict).toBe('match');
    expect(bodies({ at: 1 }, { at: 2 }, rules, { ...LIST, method: 'POST' }).verdict).toBe(
      'mismatch',
    );
    expect(bodies({ at: 1 }, { at: 2 }, rules, { ...LIST, path: '/v2/inventory' }).verdict).toBe(
      'mismatch',
    );
    expect(
      bodies(
        { at: 1 },
        { at: 2 },
        { ignore: [{ path: '$.at', when: { paths: ['/v1/**'] } }] },
        {
          path: '/v1/a/b',
        },
      ).verdict,
    ).toBe('match');
  });

  it('keeps global rules in force for every context and without one', () => {
    const rules = { ignore: ['$.at'] };
    for (const context of [LIST, CREATE, undefined]) {
      expect(bodies({ at: 1 }, { at: 2 }, rules, context).verdict).toBe('match');
    }
  });

  it('scopes tolerances, unordered, status classes, and compared headers', () => {
    expect(
      bodies(
        { n: 1 },
        { n: 1.5 },
        { tolerances: [{ path: '$.n', abs: 1, when: { tags: ['x'] } }] },
        {
          tags: ['x'],
        },
      ).findings[0]?.rule,
    ).toBe('tolerances[0]');
    const unordered = {
      unordered: [{ path: '$.items', key: '$.sku', when: { tags: ['list-inventory'] } }],
    };
    const a = { items: [{ sku: 'A' }, { sku: 'B' }] };
    const b = { items: [{ sku: 'B' }, { sku: 'A' }] };
    expect(bodies(a, b, unordered, LIST).verdict).toBe('match');
    expect(bodies(a, b, unordered, CREATE).verdict).toBe('mismatch');

    const status = differ({
      status: { equivalent: [{ classes: [[200, 201]], when: { methods: ['POST'] } }] },
    });
    const s200 = makeResponse({ status: 200 });
    const s201 = makeResponse({ status: 201 });
    expect(status.diff(s200, s201, undefined, CREATE).findings[0]?.rule).toBe(
      'status.equivalent[0].classes[0]',
    );
    expect(status.diff(s200, s201, undefined, LIST).verdict).toBe('mismatch');
    expect(status.diffStatus(s200, s201, CREATE).verdict).toBe('tolerated');

    const headers = differ({ headers: { compare: [{ name: 'X-A', when: { tags: ['x'] } }] } });
    const h1 = makeResponse({ headers: { 'x-a': '1' } });
    const h2 = makeResponse({ headers: { 'x-a': '2' } });
    expect(headers.diff(h1, h2, undefined, { tags: ['x'] }).findings[0]?.path).toBe('header:x-a');
    expect(headers.diff(h1, h2, undefined, { tags: ['y'] }).verdict).toBe('match');
  });

  it('rejects an empty when at load', () => {
    expect(() => DiffRulesSchema.parse({ ignore: [{ path: '$.a', when: {} }] })).toThrow(
      /when needs tags, methods, or paths/,
    );
  });
});

describe('extra_fields', () => {
  it('denies by default and tolerates an added field under allow', () => {
    expect(only(bodies({ a: 1 }, { a: 1, b: 2 }, {}).findings)).toEqual({
      path: '$.b',
      kind: 'unexpected',
      tolerated: false,
      candidate: 2,
    });
    const f = only(bodies({ a: 1 }, { a: 1, b: 2 }, { extra_fields: 'allow' }).findings);
    expect(f).toMatchObject({ kind: 'unexpected', tolerated: true, rule: 'extra_fields' });
    expect(explainFinding(f)).toBe(
      'The candidate has an extra value at $.b: 2. Tolerated by rule extra_fields: extra fields are allowed.',
    );
  });

  it('never tolerates an extra array element or a missing field', () => {
    const d = bodies({ a: [1], m: 1 }, { a: [1, 2] }, { extra_fields: 'allow' });
    expect(d.findings.map((f) => [f.path, f.kind, f.tolerated])).toEqual([
      ['$.a[1]', 'unexpected', false],
      ['$.m', 'missing', false],
    ]);
  });

  it('lets the first scoped entry whose scope matches decide', () => {
    const rules: DiffRulesInput = {
      extra_fields: 'deny',
      extra_fields_rules: [
        { allow: false, when: { tags: ['strict'] } },
        { allow: true, when: { methods: ['GET'] } },
      ],
    };
    expect(bodies({}, { b: 1 }, rules, LIST).findings[0]).toMatchObject({
      tolerated: true,
      rule: 'extra_fields_rules[1]',
    });
    expect(bodies({}, { b: 1 }, rules, { ...LIST, tags: ['strict'] }).verdict).toBe('mismatch');
    expect(bodies({}, { b: 1 }, rules, CREATE).verdict).toBe('mismatch');
  });
});

describe('equivalences', () => {
  it('tolerates null against absent on either side under null_absent', () => {
    const rules = { equivalences: { null_absent: true } };
    const d = bodies({ a: null }, { b: null }, rules);
    expect(d.verdict).toBe('tolerated');
    expect(d.findings.map((f) => [f.path, f.kind, f.rule])).toEqual([
      ['$.a', 'missing', 'equivalences.null_absent'],
      ['$.b', 'unexpected', 'equivalences.null_absent'],
    ]);
    expect(explainFinding(d.findings[0] as Finding)).toBe(
      'The candidate is missing $.a. The reference has null. Tolerated by rule equivalences.null_absent: null and absent are equivalent.',
    );
    expect(bodies({ a: 0 }, {}, rules).verdict).toBe('mismatch');
  });

  it('tolerates "", [], and {} against absent under empty_absent', () => {
    const rules = { equivalences: { empty_absent: true } };
    expect(bodies({ a: '', b: [], c: {} }, {}, rules).verdict).toBe('tolerated');
    expect(bodies({}, { a: '' }, rules).findings[0]?.rule).toBe('equivalences.empty_absent');
    expect(bodies({ a: 'x' }, {}, rules).verdict).toBe('mismatch');
    expect(bodies({ a: null }, {}, rules).verdict).toBe('mismatch');
  });

  it('tolerates a string that spells the number under numeric_strings', () => {
    const rules = { equivalences: { numeric_strings: true } };
    const f = only(bodies({ n: 12.5 }, { n: '12.5' }, rules).findings);
    expect(f).toMatchObject({
      kind: 'type',
      tolerated: true,
      rule: 'equivalences.numeric_strings',
    });
    expect(bodies({ n: 1 }, { n: '01' }, rules).verdict).toBe('mismatch');
    expect(bodies({ n: 1 }, { n: '1' }, {}).verdict).toBe('mismatch');
  });

  it('takes a list of scoped entries, named by index', () => {
    const rules: DiffRulesInput = {
      equivalences: [
        { null_absent: true, when: { tags: ['list-inventory'] } },
        { numeric_strings: true },
      ],
    };
    expect(bodies({ a: null }, {}, rules, LIST).findings[0]?.rule).toBe(
      'equivalences[0].null_absent',
    );
    expect(bodies({ a: null }, {}, rules, CREATE).verdict).toBe('mismatch');
    expect(bodies({ a: 1 }, { a: '1' }, rules).findings[0]?.rule).toBe(
      'equivalences[1].numeric_strings',
    );
  });
});

describe('decimal', () => {
  const rules = { decimal: [{ path: '$.total', scale: 2 }] };

  it('compares the decimal text at the scale, across strings and numbers', () => {
    const f = only(bodies({ total: '29.90' }, { total: 29.9 }, rules).findings);
    expect(f).toMatchObject({ tolerated: true, rule: 'decimal[0]' });
    expect(explainFinding(f)).toBe(
      'The value at $.total differs. The reference has "29.90" and the candidate has 29.9. Tolerated by rule decimal[0]: equal after rounding to 2 places.',
    );
    expect(bodies({ total: '1.005' }, { total: '1.01' }, rules).verdict).toBe('tolerated');
    expect(bodies({ total: '-1.005' }, { total: '-1.01' }, rules).verdict).toBe('tolerated');
    expect(bodies({ total: '1.004' }, { total: '1.01' }, rules).verdict).toBe('mismatch');
  });

  it('reports a difference after rounding with the rule in the detail', () => {
    const f = only(bodies({ total: '1.00' }, { total: '1.02' }, rules).findings);
    expect(f).toEqual({
      path: '$.total',
      kind: 'value',
      tolerated: false,
      reference: '1.00',
      candidate: '1.02',
      detail: 'differ after rounding to 2 places under decimal[0]',
    });
  });

  it('falls back to the ordinary comparison for a value that is not a decimal', () => {
    expect(only(bodies({ total: 'n/a' }, { total: '1.0' }, rules).findings).kind).toBe('value');
    expect(only(bodies({ total: true }, { total: 1 }, rules).findings).kind).toBe('type');
  });
});

describe('time', () => {
  it('tolerates ISO 8601 timestamps within the window', () => {
    const rules = { time: [{ path: '$.at', abs_ms: 1000 }] };
    const f = only(
      bodies({ at: '2026-10-16T20:50:45.687Z' }, { at: '2026-10-16T20:50:46.100Z' }, rules)
        .findings,
    );
    expect(f).toMatchObject({
      tolerated: true,
      rule: 'time[0]',
      detail: '413 ms apart, within 1000 ms',
    });
    expect(explainFinding(f)).toContain('Tolerated by rule time[0]: 413 ms apart, within 1000 ms.');
    expect(
      bodies({ at: '2026-10-16T20:50:45Z' }, { at: '2026-10-16T22:50:45+02:00' }, rules).verdict,
    ).toBe('tolerated');
    const late = only(
      bodies({ at: '2026-10-16T20:50:45Z' }, { at: '2026-10-16T20:50:47Z' }, rules).findings,
    );
    expect(late).toMatchObject({
      tolerated: false,
      detail: '2000 ms apart, outside 1000 ms of time[0]',
    });
  });

  it('reads epoch milliseconds and seconds, as numbers or numeric strings', () => {
    expect(
      bodies(
        { t: 1_000 },
        { t: '1500' },
        { time: [{ path: '$.t', abs_ms: 500, format: 'epoch_ms' }] },
      ).verdict,
    ).toBe('tolerated');
    expect(
      bodies({ t: 10 }, { t: 12 }, { time: [{ path: '$.t', abs_ms: 1999, format: 'epoch_s' }] })
        .verdict,
    ).toBe('mismatch');
  });

  it('falls back to the ordinary comparison for a value that does not parse', () => {
    const f = only(
      bodies({ at: 'soon' }, { at: 'later' }, { time: [{ path: '$.at', abs_ms: 10 }] }).findings,
    );
    expect(f).toEqual({
      path: '$.at',
      kind: 'value',
      tolerated: false,
      reference: 'soon',
      candidate: 'later',
    });
  });
});

describe('mask', () => {
  it('tolerates two strings that both match the anchored pattern', () => {
    const rules = { mask: [{ path: '$..id', pattern: 'ord_[0-9a-f]{8}' }] };
    const f = only(
      bodies({ o: { id: 'ord_0000abcd' } }, { o: { id: 'ord_1234beef' } }, rules).findings,
    );
    expect(f).toMatchObject({ path: '$.o.id', tolerated: true, rule: 'mask[0]' });
    expect(explainFinding(f)).toContain('Tolerated by rule mask[0]: both match ord_[0-9a-f]{8}.');
    // Anchored: a value with more around the match does not match.
    expect(bodies({ id: 'ord_0000abcd' }, { id: 'xord_1234beefx' }, rules).verdict).toBe(
      'mismatch',
    );
  });

  it('rejects a pattern that does not compile when the rules load', () => {
    expect(() => DiffRulesSchema.parse({ mask: [{ path: '$.a', pattern: '(' }] })).toThrow(
      /bad pattern/,
    );
    expect(() =>
      DiffRulesSchema.parse({ headers: { masks: [{ name: 'x', pattern: '[' }] } }),
    ).toThrow(/bad pattern/);
  });
});

describe('headers.ignore and headers.masks', () => {
  const ref = makeResponse({ headers: { 'x-request-id': 'r-1', etag: 'W/"1"' } });
  const cand = makeResponse({ headers: { 'x-request-id': 'r-2', etag: 'W/"2"' } });

  it('takes an ignored name out of the compared list', () => {
    const d = differ({
      headers: { compare: ['x-request-id', 'etag'], ignore: ['X-Request-Id'] },
    }).diff(ref, cand);
    expect(d.findings.map((f) => f.path)).toEqual(['header:etag']);
  });

  it('tolerates a compared header whose two values match the mask', () => {
    const d = differ({
      headers: {
        compare: ['x-request-id', 'etag'],
        masks: [{ name: 'X-Request-Id', pattern: 'r-\\d+' }],
      },
    }).diff(ref, cand);
    expect(d.findings.map((f) => [f.path, f.tolerated, f.rule ?? null])).toEqual([
      ['header:x-request-id', true, 'headers.masks[0]'],
      ['header:etag', false, null],
    ]);
    expect(explainFinding(d.findings[0] as Finding)).toBe(
      'Header x-request-id differs. The reference sent "r-1" and the candidate sent "r-2". Tolerated by rule headers.masks[0]: both match r-\\d+.',
    );
  });
});

describe('filters and recursive descent in rule paths', () => {
  const ref = {
    lines: [
      { type: 'fee', amount: 1 },
      { type: 'item', amount: 10 },
    ],
  };
  const cand = {
    lines: [
      { type: 'fee', amount: 2 },
      { type: 'item', amount: 11 },
    ],
  };

  it('applies a filter rule to the elements that satisfy it only', () => {
    const d = bodies(ref, cand, { ignore: ["$.lines[?(@.type=='fee')].amount"] });
    expect(d.findings.map((f) => f.path)).toEqual(['$.lines[1].amount']);
    const ne = bodies(ref, cand, {
      tolerances: [{ path: "$.lines[?(@.type != 'fee')].amount", abs: 1 }],
    });
    expect(ne.findings.map((f) => [f.path, f.tolerated])).toEqual([
      ['$.lines[0].amount', false],
      ['$.lines[1].amount', true],
    ]);
  });

  it('applies a filter inside a keyed unordered array', () => {
    const d = bodies(
      {
        lines: [
          { id: 'a', type: 'fee', amount: 1 },
          { id: 'b', type: 'item', amount: 2 },
        ],
      },
      {
        lines: [
          { id: 'b', type: 'item', amount: 3 },
          { id: 'a', type: 'fee', amount: 5 },
        ],
      },
      {
        unordered: [{ path: '$.lines', key: '$.id' }],
        ignore: ["$.lines[?(@.type=='fee')].amount"],
      },
    );
    expect(d.findings.map((f) => f.path)).toEqual(['$.lines[id=b].amount']);
  });

  it('applies a descent rule at every depth', () => {
    const d = bodies(
      { request_id: 1, a: { request_id: 2, b: [{ request_id: 3, v: 1 }] } },
      { request_id: 4, a: { request_id: 5, b: [{ request_id: 6, v: 1 }] } },
      { ignore: ['$..request_id'] },
    );
    expect(d.verdict).toBe('match');
  });

  it('lets ignore win over every other rule at its path', () => {
    const d = bodies(
      { at: '2026-01-01T00:00:00Z', n: '1.00' },
      { at: '2027-01-01T00:00:00Z', n: '9.00' },
      {
        ignore: ['$..at', '$.n'],
        time: [{ path: '$.at', abs_ms: 1 }],
        decimal: [{ path: '$.n', scale: 2 }],
      },
    );
    expect(d.verdict).toBe('match');
  });
});
