import { describe, expect, it } from 'vitest';
import { buildSchedule, requestedRps, summarizeSlip } from './pacing.js';

describe('buildSchedule', () => {
  const offsets = [120, 150, 400, 400, 1000];

  it('keeps recorded gaps relative to the first selected exchange', () => {
    expect(buildSchedule(offsets, 'as-recorded', null)).toEqual([0, 30, 280, 280, 880]);
  });

  it('spaces sends evenly at a fixed rate', () => {
    expect(buildSchedule(offsets, 'fixed-rate', 50)).toEqual([0, 20, 40, 60, 80]);
    expect(() => buildSchedule(offsets, 'fixed-rate', null)).toThrow(RangeError);
  });

  it('has no schedule under max', () => {
    expect(buildSchedule(offsets, 'max', null)).toEqual([0, 0, 0, 0, 0]);
    expect(buildSchedule([], 'as-recorded', null)).toEqual([]);
  });
});

describe('requestedRps', () => {
  it('reports the recording rate, the fixed rate, or nothing', () => {
    expect(requestedRps([0, 500, 1000], 'as-recorded', null)).toBe(2);
    expect(requestedRps([0], 'as-recorded', null)).toBeNull();
    expect(requestedRps([5, 5], 'as-recorded', null)).toBeNull();
    expect(requestedRps([0, 1], 'fixed-rate', 25)).toBe(25);
    expect(requestedRps([0, 1], 'max', null)).toBeNull();
  });
});

describe('summarizeSlip', () => {
  it('takes the median and the maximum, clamping negatives', () => {
    expect(summarizeSlip([])).toEqual({ p50_ms: 0, max_ms: 0 });
    expect(summarizeSlip([5, -1, 3, 40])).toEqual({ p50_ms: 3, max_ms: 40 });
    expect(summarizeSlip([1.23456])).toEqual({ p50_ms: 1.235, max_ms: 1.235 });
  });
});
