import { describe, expect, it } from 'vitest';
import { globToRegExp, matchGlob } from './glob.js';

describe('matchGlob', () => {
  it('matches literals exactly', () => {
    expect(matchGlob('/v1/orders', '/v1/orders')).toBe(true);
    expect(matchGlob('/v1/orders', '/v1/orders/1')).toBe(false);
    expect(matchGlob('/v1/orders', '/v2/orders')).toBe(false);
  });

  it('matches * within one segment', () => {
    expect(matchGlob('/v1/orders/*', '/v1/orders/o-1')).toBe(true);
    expect(matchGlob('/v1/orders/*', '/v1/orders/o-1/items')).toBe(false);
    expect(matchGlob('/v1/inventory/*/adjust', '/v1/inventory/A-100/adjust')).toBe(true);
  });

  it('matches ** across segments', () => {
    expect(matchGlob('/v1/**', '/v1/a/b/c')).toBe(true);
    expect(matchGlob('/v1/**', '/v1/')).toBe(true);
    expect(matchGlob('/v1/**/adjust', '/v1/inventory/A-100/adjust')).toBe(true);
  });

  it('matches ? as one character', () => {
    expect(matchGlob('/v?/x', '/v1/x')).toBe(true);
    expect(matchGlob('/v?/x', '/v12/x')).toBe(false);
  });

  it('escapes regular expression characters', () => {
    expect(matchGlob('/a.b', '/a.b')).toBe(true);
    expect(matchGlob('/a.b', '/aXb')).toBe(false);
    expect(matchGlob('/a+b(c)', '/a+b(c)')).toBe(true);
  });

  it('caches compiled patterns', () => {
    expect(globToRegExp('/cached/*')).toBe(globToRegExp('/cached/*'));
  });
});
