import { parsePath, select, type JsonValue } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { minimalValue, setAt, valueAt } from './lowering.js';

const doc: JsonValue = { a: [{ n: 5 }, { n: 6 }], s: 'text', o: { k: 1 } };

describe('valueAt and setAt', () => {
  it('read and replace a value by its concrete path without touching the original', () => {
    const [match] = select(doc, '$.a[1].n');
    const segments = match?.segments ?? [];
    expect(valueAt(doc, segments)).toBe(6);
    const changed = setAt(doc, segments, 1);
    expect(valueAt(changed, segments)).toBe(1);
    expect(valueAt(doc, segments)).toBe(6);
    expect(changed).toEqual({ a: [{ n: 5 }, { n: 1 }], s: 'text', o: { k: 1 } });
  });

  it('answer undefined or the document unchanged for a path that leads nowhere', () => {
    expect(valueAt(doc, parsePath('$.a[9].n'))).toBeUndefined();
    expect(valueAt(doc, parsePath('$.s.x'))).toBeUndefined();
    expect(valueAt(undefined, parsePath('$.s'))).toBeUndefined();
    expect(valueAt(doc, [])).toBe(doc);
    expect(setAt(doc, parsePath('$.nope.deeper'), 1)).toBe(doc);
    expect(setAt(doc, parsePath('$.a[9]'), 1)).toEqual(doc);
    expect(setAt(doc, [], 7)).toBe(7);
  });
});

describe('minimalValue', () => {
  it('maps strings, arrays, and objects to their empty form', () => {
    expect(minimalValue('x')).toBe('');
    expect(minimalValue([1])).toEqual([]);
    expect(minimalValue({ a: 1 })).toEqual({});
  });

  it('is undefined for a value already empty and for other kinds', () => {
    for (const v of ['', [], {}, 3, true, null]) expect(minimalValue(v)).toBeUndefined();
  });
});
