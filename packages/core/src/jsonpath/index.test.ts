import { describe, expect, it } from 'vitest';
import {
  JsonPathError,
  get,
  isValidPath,
  keyValueText,
  matches,
  parsePath,
  renderPath,
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
    expect(renderPath([])).toBe('$');
  });

  it('round trips', () => {
    for (const p of ['$', '$.a.b', '$.items[2].sku', '$["a b"].c', '$.items[sku=A-1].qty']) {
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
    expect(keyValueText('has space')).toBe('"has space"');
    expect(keyValueText('a=b')).toBe('"a=b"');
    expect(keyValueText({ k: 1 })).toBe('{"k":1}');
    expect(keyValueText(undefined)).toBe('null');
  });
});
