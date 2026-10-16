import { describe, expect, it } from 'vitest';
import { createUlidFactory, decodeTime, encodeTime, isUlid, ulid } from './ulid.js';

describe('ulid', () => {
  it('produces 26 character Crockford base32 ids', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('encodes and decodes the timestamp', () => {
    expect(encodeTime(0)).toBe('0000000000');
    const t = 1_760_638_923_123;
    expect(decodeTime(`${encodeTime(t)}${'0'.repeat(16)}`)).toBe(t);
    expect(decodeTime(ulid())).toBeGreaterThan(1_700_000_000_000);
  });

  it('rejects bad input', () => {
    expect(() => encodeTime(-1)).toThrow(RangeError);
    expect(() => encodeTime(1.5)).toThrow(RangeError);
    expect(() => decodeTime('not-a-ulid')).toThrow(RangeError);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });

  it('is monotonic within one millisecond', () => {
    let now = 1000;
    const next = createUlidFactory({
      now: () => now,
      random: (n) => new Uint8Array(n).fill(0),
    });
    const a = next();
    const b = next();
    const c = next();
    expect(a < b && b < c).toBe(true);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(b.endsWith('1')).toBe(true);
    now = 1001;
    const d = next();
    expect(d > c).toBe(true);
    expect(d.slice(0, 10)).not.toBe(c.slice(0, 10));
  });

  it('wraps the random part instead of overflowing', () => {
    const next = createUlidFactory({
      now: () => 5,
      random: (n) => new Uint8Array(n).fill(0xff),
    });
    const first = next();
    const second = next();
    expect(first).toHaveLength(26);
    expect(second.slice(10)).toBe('0000000000000000');
  });

  it('sorts a batch of ids in creation order', () => {
    const ids = Array.from({ length: 200 }, () => ulid());
    expect([...ids].sort()).toEqual(ids);
  });
});
