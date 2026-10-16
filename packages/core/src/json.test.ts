import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  deepEqual,
  isJsonObject,
  jsonType,
  sha256Hex,
  stripUndefined,
} from './json.js';

describe('canonicalJson', () => {
  it('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes primitives like JSON.stringify', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('deepEqual', () => {
  it('ignores key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
  });

  it('detects differences', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('jsonType and isJsonObject', () => {
  it('names every type', () => {
    expect(jsonType(undefined)).toBe('undefined');
    expect(jsonType(null)).toBe('null');
    expect(jsonType(true)).toBe('boolean');
    expect(jsonType(1)).toBe('number');
    expect(jsonType('s')).toBe('string');
    expect(jsonType([])).toBe('array');
    expect(jsonType({})).toBe('object');
  });

  it('distinguishes objects from arrays and null', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });
});

describe('stripUndefined', () => {
  it('drops undefined members and keeps the rest', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });
});
