import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../json.js';
import {
  JsonPathError,
  get,
  isValidPath,
  isValidRulePath,
  keyValueText,
  matches,
  matchesIn,
  parsePath,
  renderPath,
  rowKeyText,
  select,
} from './index.js';

describe('parsePath', () => {
  it('parses every supported token', () => {
    expect(parsePath('$')).toEqual([]);
    expect(parsePath('$.a.b')).toEqual([
      { type: 'key', name: 'a' },
      { type: 'key', name: 'b' },
    ]);
    expect(parsePath("$['a b']")).toEqual([{ type: 'key', name: 'a b' }]);
    expect(parsePath('$["q\\"x"]')).toEqual([{ type: 'key', name: 'q"x' }]);
    expect(parsePath("$['it\\'s']")).toEqual([{ type: 'key', name: "it's" }]);
    expect(parsePath('$[0]')).toEqual([{ type: 'index', index: 0 }]);
    expect(parsePath('$[*]')).toEqual([{ type: 'wildcard' }]);
    expect(parsePath('$.*')).toEqual([{ type: 'wildcard' }]);
    expect(parsePath('$.items[*].unit_price')).toEqual([
      { type: 'key', name: 'items' },
      { type: 'wildcard' },
      { type: 'key', name: 'unit_price' },
    ]);
    expect(parsePath('$.order-id')).toEqual([{ type: 'key', name: 'order-id' }]);
  });

  it('parses keyed segments from concrete paths', () => {
    expect(parsePath('$.items[sku=A-100].qty')).toEqual([
      { type: 'key', name: 'items' },
      { type: 'keyed', name: 'sku', value: 'A-100', dup: 0 },
      { type: 'key', name: 'qty' },
    ]);
    expect(parsePath('$.items[sku=A-100#2]')).toEqual([
      { type: 'key', name: 'items' },
      { type: 'keyed', name: 'sku', value: 'A-100', dup: 2 },
    ]);
  });

  it('parses quoted names, quoted values, and rows without the key in keyed segments', () => {
    const keyed = (name: string, value: string, dup = 0) => [{ type: 'keyed', name, value, dup }];
    expect(parsePath('$[sku="it\'s"]')).toEqual(keyed('sku', '"it\'s"'));
    expect(parsePath('$[sku="a\\"b"#3]')).toEqual(keyed('sku', '"a\\"b"', 3));
    expect(parsePath('$[sku="[1,2]"]')).toEqual(keyed('sku', '"[1,2]"'));
    expect(parsePath('$[sku=""]')).toEqual(keyed('sku', '""'));
    expect(parsePath("$[sku='[1,2]']")).toEqual(keyed('sku', "'[1,2]'"));
    expect(parsePath('$[sku=\'{"a":"it\\\'s"}\'#2]')).toEqual(
      keyed('sku', '\'{"a":"it\\\'s"}\'', 2),
    );
    expect(parsePath('$[sku=#\'{"qty":3}\']')).toEqual(keyed('sku', '#\'{"qty":3}\''));
    expect(parsePath("$[sku=#'[]'#1]")).toEqual(keyed('sku', "#'[]'", 1));
    expect(parsePath("$[sku=#'5']")).toEqual(keyed('sku', "#'5'"));
    expect(parsePath('$["a b"=X]')).toEqual(keyed('a b', 'X'));
    expect(parsePath("$['a b'=X#2]")).toEqual(keyed('a b', 'X', 2));
    expect(parsePath('$[""="x y"]')).toEqual(keyed('', '"x y"'));
    expect(parsePath('$[n=-1.5e+21]')).toEqual(keyed('n', '-1.5e+21'));
    expect(parsePath('$[ sku=A ]')).toEqual(keyed('sku', 'A'));
  });

  it('rejects keyed segments outside the grammar with a clear message', () => {
    const bad: [string, RegExp][] = [
      ["$.items[sku=it's].v", /missing "\]"/],
      ['$.items[sku=a"b].v', /missing "\]"/],
      ['$.items[sku=[1,2]].v', /bad key value "\[1,2"/],
      ['$.items[sku={"a":[1]}].v', /bad key value/],
      ['$[a=#[]]', /needs its JSON in single quotes after "#"/],
      ['$[a=#1]', /needs its JSON in single quotes after "#"/],
      ['$[a=#"x"]', /needs its JSON in single quotes after "#"/],
      ["$[a='{bad']", /bad quoted key value '\{bad'/],
      ['$[a=]', /bad key value ""/],
      ['$[a.b=X]', /bad key "a.b" before "="/],
      ['$[=X]', /unsupported bracket content/],
      ['$[sku=A#0]', /bad duplicate suffix "#0"/],
      ['$[sku="A"x]', /bad duplicate suffix "x"/],
      ['$[sku="a\\qb"]', /bad quoted key value/],
      ['$["a b"x]', /unexpected text "x" after a quoted key/],
      ['$["a\\qb"]', /bad quoted key/],
    ];
    for (const [path, pattern] of bad) {
      expect(() => parsePath(path), path).toThrow(JsonPathError);
      expect(() => parsePath(path), path).toThrow(pattern);
    }
  });

  it('rejects unsupported syntax with a clear message', () => {
    const bad: [string, RegExp][] = [
      ['items', /must start with \$/],
      ['$..', /recursive descent needs a name/],
      ['$[1:2]', /slices/],
      ['$[?(@.x)]', /bad filter/],
      ['$[?(@.x > 1)]', /bad filter/],
      ['$[?(@.x == true)]', /bad filter/],
      ['$.a.', /bad key ""/],
      ['$[unclosed', /missing "\]"/],
      ['$x', /unexpected character/],
      ['$[-1]', /unsupported bracket/],
    ];
    for (const [path, pattern] of bad) {
      expect(() => parsePath(path), path).toThrow(JsonPathError);
      expect(() => parsePath(path), path).toThrow(pattern);
      expect(isValidPath(path)).toBe(false);
    }
    expect(isValidPath('$.ok[0]')).toBe(true);
    // Filters and descent parse, but only rule paths accept them.
    expect(isValidPath('$..a')).toBe(false);
    expect(isValidPath("$.a[?(@.t=='x')]")).toBe(false);
    expect(isValidRulePath('$..a')).toBe(true);
    expect(isValidRulePath("$.a[?(@.t=='x')]")).toBe(true);
    expect(isValidRulePath('$[1:2]')).toBe(false);
    expect(parsePath('$[""]')).toEqual([{ type: 'key', name: '' }]);
    expect(parsePath("$['']")).toEqual([{ type: 'key', name: '' }]);
  });

  it('caches parsed paths', () => {
    expect(parsePath('$.cached')).toBe(parsePath('$.cached'));
  });
});

describe('renderPath', () => {
  it('renders identifiers with dots and other keys with quotes', () => {
    expect(renderPath(parsePath('$.a[0][*].b'))).toBe('$.a[0][*].b');
    expect(renderPath([{ type: 'key', name: 'a b' }])).toBe('$["a b"]');
    expect(renderPath([{ type: 'keyed', name: 'sku', value: 'X', dup: 1 }])).toBe('$[sku=X#1]');
    expect(renderPath([{ type: 'keyed', name: 'a b', value: '"x y"', dup: 2 }])).toBe(
      '$["a b"="x y"#2]',
    );
    expect(renderPath([])).toBe('$');
  });

  it('round trips', () => {
    for (const p of [
      '$',
      '$.a.b',
      '$.items[2].sku',
      '$["a b"].c',
      '$.items[sku=A-1].qty',
      '$.items[sku="it\'s"].v',
      '$.items[sku="a\\"b"#1].v',
      '$.items[sku="[1,2]"].v',
      "$.items[sku='[1,2]'].v",
      '$.items[sku=\'{"a":[1]}\'].v',
      "$[a=#'[]']",
      '$.items["a b"=X].v',
      '$[""=""#2]',
    ]) {
      expect(renderPath(parsePath(p))).toBe(p);
    }
  });
});

describe('select and get', () => {
  const doc = {
    total: 1.5,
    items: [
      { sku: 'B', qty: 2 },
      { sku: 'A', qty: 1 },
    ],
    meta: { z: 1, a: 2 },
  };

  it('selects keys, indexes, and wildcards with concrete paths', () => {
    expect(select(doc, '$.total')).toEqual([
      { path: '$.total', segments: [{ type: 'key', name: 'total' }], value: 1.5 },
    ]);
    expect(select(doc, '$.items[1].sku').map((m) => m.value)).toEqual(['A']);
    expect(select(doc, '$.items[*].sku').map((m) => [m.path, m.value])).toEqual([
      ['$.items[0].sku', 'B'],
      ['$.items[1].sku', 'A'],
    ]);
    expect(select(doc, '$.meta.*').map((m) => [m.path, m.value])).toEqual([
      ['$.meta.a', 2],
      ['$.meta.z', 1],
    ]);
    expect(select(doc, '$').map((m) => m.path)).toEqual(['$']);
  });

  it('returns nothing for missing paths and undefined documents', () => {
    expect(select(doc, '$.nope')).toEqual([]);
    expect(select(doc, '$.items[9]')).toEqual([]);
    expect(select(doc, '$.total[0]')).toEqual([]);
    expect(select(doc, '$.items.sku')).toEqual([]);
    expect(select(undefined, '$.a')).toEqual([]);
    expect(select(doc, '$.items[sku=A]')).toEqual([]);
  });

  it('get returns the first match or undefined', () => {
    expect(get(doc, '$.items[*].qty')).toBe(2);
    expect(get(doc, '$.missing')).toBeUndefined();
    expect(get(doc, parsePath('$.meta.a'))).toBe(2);
  });
});

describe('matches', () => {
  it('matches wildcards against keys, indexes, and keyed segments', () => {
    expect(matches('$.items[*].sku', '$.items[3].sku')).toBe(true);
    expect(matches('$.items[*].sku', '$.items[sku=A-1].sku')).toBe(true);
    expect(matches('$.*', '$.anything')).toBe(true);
    expect(matches('$.items[*]', '$.items')).toBe(false);
    expect(matches('$.items[0]', '$.items[1]')).toBe(false);
    expect(matches('$.a', '$.b')).toBe(false);
    expect(matches('$.items[sku=A]', '$.items[sku=A]')).toBe(true);
    expect(matches('$.items[sku=A]', '$.items[sku=A#1]')).toBe(false);
    expect(matches(parsePath('$.x'), parsePath('$.x'))).toBe(true);
  });
});

describe('keyValueText', () => {
  it('renders plain scalars bare and others as JSON', () => {
    expect(keyValueText('A-100')).toBe('A-100');
    expect(keyValueText(42)).toBe('42');
    expect(keyValueText(true)).toBe('true');
    expect(keyValueText(null)).toBe('null');
    expect(keyValueText('has space')).toBe('"has space"');
    expect(keyValueText('a=b')).toBe('"a=b"');
    expect(keyValueText(undefined)).toBe('null');
  });

  it('tells a string key from the number, word, or JSON it spells', () => {
    const spelledAlike: [JsonValue, string][] = [
      [1, '1'],
      [-2, '-2'],
      [0.5, '0.5'],
      [1e21, '1e+21'],
      [true, 'true'],
      [false, 'false'],
      [null, 'null'],
      [[1, 2], '[1,2]'],
      [{ a: 1 }, '{"a":1}'],
    ];
    for (const [value, text] of spelledAlike) {
      expect(keyValueText(value), text).not.toBe(keyValueText(text));
      expect(keyValueText(text), text).toBe(JSON.stringify(text));
    }
    expect(keyValueText(1)).toBe('1');
    expect(keyValueText('1')).toBe('"1"');
    expect(keyValueText('100A')).toBe('"100A"');
    expect(keyValueText('-x')).toBe('"-x"');
    expect(keyValueText('o-1')).toBe('o-1');
    expect(keyValueText('_x$')).toBe('_x$');
  });

  it('quotes every string the keyed segment syntax cannot hold bare and every non scalar', () => {
    expect(keyValueText("it's")).toBe('"it\'s"');
    expect(keyValueText('a"b')).toBe('"a\\"b"');
    expect(keyValueText('a]b')).toBe('"a]b"');
    expect(keyValueText('a#1')).toBe('"a#1"');
    expect(keyValueText('a.b')).toBe('"a.b"');
    expect(keyValueText('')).toBe('""');
    expect(keyValueText([1, 2])).toBe("'[1,2]'");
    expect(keyValueText('[1,2]')).toBe('"[1,2]"');
    expect(keyValueText({ b: [1], a: 'x' })).toBe('\'{"a":"x","b":[1]}\'');
    expect(keyValueText({ k: 1 })).toBe('\'{"k":1}\'');
    expect(keyValueText({ a: "it's" })).toBe('\'{"a":"it\\\'s"}\'');
    expect(keyValueText({ a: 'q"\\' })).toBe(String.raw`'{"a":"q\\"\\\\"}'`);
    expect(rowKeyText({ qty: 3 })).toBe('#\'{"qty":3}\'');
    expect(rowKeyText(5)).toBe("#'5'");
    expect(rowKeyText('abc')).toBe('#\'"abc"\'');
    for (const value of ["it's", 'a"b', [1, 2], { a: [1] }, { a: "it's" }, '', 'a b']) {
      const path = `$[k=${keyValueText(value)}#1]`;
      expect(parsePath(path), path).toEqual([
        { type: 'keyed', name: 'k', value: keyValueText(value), dup: 1 },
      ]);
      const row = `$[k=${rowKeyText(value)}#1]`;
      expect(parsePath(row), row).toEqual([
        { type: 'keyed', name: 'k', value: rowKeyText(value), dup: 1 },
      ]);
    }
  });
});

describe('filters and recursive descent', () => {
  const doc: JsonValue = {
    items: [
      { type: 'fee', amount: 1 },
      { type: 'item', amount: 10 },
      { type: 'fee', amount: 2, meta: { request_id: 'r2' } },
      { n: 3 },
    ],
    request_id: 'r0',
  };

  it('parses filters in their spellings and renders them back', () => {
    expect(parsePath("$.items[?(@.type=='fee')].amount")).toEqual([
      { type: 'key', name: 'items' },
      { type: 'filter', key: 'type', op: '==', literal: 'fee' },
      { type: 'key', name: 'amount' },
    ]);
    expect(parsePath('$.items[?( @["type"] != "fee" )]')).toEqual(
      parsePath("$.items[?(@.type!='fee')]"),
    );
    expect(parsePath('$.items[?(@.n==3)]')[1]).toEqual({
      type: 'filter',
      key: 'n',
      op: '==',
      literal: 3,
    });
    expect(renderPath(parsePath('$.items[?(@["a b"]=="it\'s")]'))).toBe(
      "$.items[?(@['a b']=='it\\'s')]",
    );
    expect(renderPath(parsePath('$..request_id'))).toBe('$..request_id');
    expect(renderPath(parsePath('$.a..[0]'))).toBe('$.a..[0]');
  });

  it('selects the elements a filter admits, in order', () => {
    expect(select(doc, "$.items[?(@.type=='fee')].amount").map((m) => [m.path, m.value])).toEqual([
      ['$.items[0].amount', 1],
      ['$.items[2].amount', 2],
    ]);
    // Under != an element without the child matches.
    expect(select(doc, "$.items[?(@.type!='fee')]").map((m) => m.path)).toEqual([
      '$.items[1]',
      '$.items[3]',
    ]);
    // A number literal never equals a string child.
    expect(select(doc, "$.items[?(@.amount=='1')]")).toEqual([]);
  });

  it('selects by descent at every depth, the shallowest first', () => {
    expect(select(doc, '$..request_id').map((m) => m.path)).toEqual([
      '$.request_id',
      '$.items[2].meta.request_id',
    ]);
  });

  it('matches a filter only against a document, and a descent with or without one', () => {
    const rule = "$.items[?(@.type=='fee')].amount";
    expect(matches(rule, '$.items[0].amount')).toBe(false);
    expect(matchesIn(rule, '$.items[0].amount', doc)).toBe(true);
    expect(matchesIn(rule, '$.items[1].amount', doc)).toBe(false);
    expect(matchesIn(rule, '$.items[9].amount', doc)).toBe(false);
    expect(matches('$..request_id', '$.items[2].meta.request_id')).toBe(true);
    expect(matches('$..request_id', '$.request_id')).toBe(true);
    expect(matches('$..request_id', '$.request_id.x')).toBe(false);
    expect(matchesIn('$..meta.request_id', '$.items[2].meta.request_id', doc)).toBe(true);
  });

  it('resolves keyed segments for a filter inside an unordered array', () => {
    expect(matchesIn("$.items[?(@.type=='item')].amount", '$.items[amount=10].amount', doc)).toBe(
      true,
    );
  });
});
