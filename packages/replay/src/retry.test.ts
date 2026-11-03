import { ConfigError } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { backoffMs, isIdempotent, parseRetryOn } from './retry.js';

describe('isIdempotent', () => {
  it('accepts the idempotent methods and refuses POST and PATCH', () => {
    for (const m of ['GET', 'head', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']) {
      expect(isIdempotent(m)).toBe(true);
    }
    expect(isIdempotent('POST')).toBe(false);
    expect(isIdempotent('patch')).toBe(false);
  });
});

describe('parseRetryOn', () => {
  it('reads a list of kinds, drops repeats, and sorts them', () => {
    expect(parseRetryOn('timeout')).toEqual(['timeout']);
    expect(parseRetryOn(' timeout , connection,timeout ')).toEqual(['connection', 'timeout']);
  });

  it('rejects an empty list and an unknown kind', () => {
    expect(() => parseRetryOn('')).toThrow(ConfigError);
    expect(() => parseRetryOn('timeout,protocol')).toThrow(/--retry-on protocol/);
  });
});

describe('backoffMs', () => {
  it('doubles from the base and scales by a factor from 0.5 to 1', () => {
    expect(backoffMs(1, 100, () => 0)).toBe(50);
    expect(backoffMs(1, 100, () => 1)).toBe(100);
    expect(backoffMs(3, 100, () => 0.5)).toBe(300);
  });
});
