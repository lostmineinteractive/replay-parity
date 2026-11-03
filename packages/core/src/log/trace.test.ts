import { describe, expect, it } from 'vitest';
import {
  generateTraceId,
  isSpanId,
  isTraceId,
  parseTraceparent,
  spanIdFor,
  traceparent,
} from './trace.js';

describe('trace ids', () => {
  it('generates 32 lower case hex characters that differ per call', () => {
    const a = generateTraceId();
    const b = generateTraceId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(isTraceId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('never generates the all zero id', () => {
    const id = generateTraceId((n) => new Uint8Array(n));
    expect(id).toBe('00000000000000000000000000000001');
    expect(isTraceId(id)).toBe(true);
    expect(isTraceId('0'.repeat(32))).toBe(false);
    expect(isTraceId('ABCDEF' + '0'.repeat(26))).toBe(false);
    expect(isTraceId('abc')).toBe(false);
  });

  it('derives the same span id from the same exchange id', () => {
    const a = spanIdFor('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(isSpanId(a)).toBe(true);
    expect(spanIdFor('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(a);
    expect(spanIdFor('01ARZ3NDEKTSV4RRFFQ69G5FAW')).not.toBe(a);
    expect(isSpanId('0'.repeat(16))).toBe(false);
  });

  it('formats and parses a traceparent', () => {
    const traceId = generateTraceId();
    const spanId = spanIdFor('x');
    const header = traceparent(traceId, spanId);
    expect(header).toBe(`00-${traceId}-${spanId}-01`);
    expect(parseTraceparent(header)).toEqual({ version: '00', traceId, spanId, flags: '01' });
    expect(parseTraceparent(` ${header} `)).not.toBeNull();
    expect(parseTraceparent('nope')).toBeNull();
    expect(parseTraceparent(`ff-${traceId}-${spanId}-01`)).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${spanId}-01`)).toBeNull();
    expect(() => traceparent('short', spanId)).toThrow(RangeError);
    expect(() => traceparent(traceId, 'short')).toThrow(RangeError);
  });
});
