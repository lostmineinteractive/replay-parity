import { describe, expect, it } from 'vitest';
import {
  JsonPathError,
  get,
  isValidPath,
  keyValueText,
  matches,
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
      ['$..a', /recursive descent/],
      ['$[1:2]', /slices/],
      ['$[?(@.x)]', /filters/],
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
