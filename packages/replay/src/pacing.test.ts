import { describe, expect, it } from 'vitest';
import { ScheduleBuilder, buildSchedule, requestedRps, summarizeSlip } from './pacing.js';

describe('buildSchedule', () => {
  const offsets = [120, 150, 400, 400, 1000];

  it('keeps recorded gaps relative to the first selected exchange', () => {
    expect(buildSchedule(offsets, 'as-recorded', null)).toEqual({
      times: [0, 30, 280, 280, 880],
      gapsCapped: 0,
    });
  });

  it('reduces every gap above the cap to the cap and counts them', () => {
    expect(buildSchedule(offsets, 'as-recorded', null, 100)).toEqual({
      times: [0, 30, 130, 130, 230],
      gapsCapped: 2,
    });
    // A cap no gap reaches changes nothing.
    expect(buildSchedule(offsets, 'as-recorded', null, 600)).toEqual({
      times: [0, 30, 280, 280, 880],
      gapsCapped: 0,
    });
    // A gap equal to the cap is kept.
    expect(buildSchedule([0, 250, 500], 'as-recorded', null, 250)).toEqual({
      times: [0, 250, 500],
      gapsCapped: 0,
    });
    expect(buildSchedule([0, 600_000, 600_010], 'as-recorded', null, 30_000)).toEqual({
      times: [0, 30_000, 30_010],
      gapsCapped: 1,
    });
    expect(() => buildSchedule(offsets, 'as-recorded', null, 0)).toThrow(RangeError);
  });

  it('spaces sends evenly at a fixed rate and ignores the cap', () => {
    expect(buildSchedule(offsets, 'fixed-rate', 50, 10)).toEqual({
      times: [0, 20, 40, 60, 80],
      gapsCapped: 0,
    });
    expect(() => buildSchedule(offsets, 'fixed-rate', null)).toThrow(RangeError);
  });

  it('has no schedule under max', () => {
    expect(buildSchedule(offsets, 'max', null, 10)).toEqual({
      times: [0, 0, 0, 0, 0],
      gapsCapped: 0,
    });
    expect(buildSchedule([], 'as-recorded', null)).toEqual({ times: [], gapsCapped: 0 });
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

  it('follows the capped schedule', () => {
    const { times } = buildSchedule([0, 100, 50_100, 50_200], 'as-recorded', null, 100);
    expect(times).toEqual([0, 100, 200, 300]);
    expect(requestedRps(times, 'as-recorded', null)).toBe(10);
  });
});

describe('summarizeSlip', () => {
  it('takes the median and the maximum, clamping negatives', () => {
    expect(summarizeSlip([])).toEqual({ p50_ms: 0, max_ms: 0 });
    expect(summarizeSlip([5, -1, 3, 40])).toEqual({ p50_ms: 3, max_ms: 40 });
    expect(summarizeSlip([1.23456])).toEqual({ p50_ms: 1.235, max_ms: 1.235 });
  });
});

describe('ScheduleBuilder', () => {
  it('gives one exchange at a time the times buildSchedule gives the whole list', () => {
    const offsets = [120, 150, 400, 400, 1000];
    for (const [mode, rps, cap] of [
      ['as-recorded', null, null],
      ['as-recorded', null, 100],
      ['fixed-rate', 50, null],
      ['max', null, null],
    ] as const) {
      const builder = new ScheduleBuilder(mode, rps, cap);
      const times = offsets.map((o) => builder.next(o));
      const whole = buildSchedule(offsets, mode, rps, cap);
      expect(times).toEqual(whole.times);
      expect(builder.gapsCapped).toBe(whole.gapsCapped);
      expect(builder.end).toBe(whole.times[whole.times.length - 1]);
      expect(builder.requestedRps()).toBe(requestedRps(whole.times, mode, rps));
    }
  });

  it('starts empty and rejects a bad cap or rate', () => {
    const builder = new ScheduleBuilder('as-recorded', null);
    expect(builder.end).toBe(0);
    expect(builder.requestedRps()).toBeNull();
    builder.next(5);
    expect(builder.requestedRps()).toBeNull();
    expect(() => new ScheduleBuilder('as-recorded', null, 0)).toThrow(RangeError);
    expect(() => new ScheduleBuilder('fixed-rate', null)).toThrow(RangeError);
  });
});

describe('the speed factor', () => {
  it('divides the recorded gaps after the cap under as-recorded', () => {
    const offsets = [120, 150, 400, 400, 1000];
    expect(buildSchedule(offsets, 'as-recorded', null, null, 2).times).toEqual([
      0, 15, 140, 140, 440,
    ]);
    expect(buildSchedule(offsets, 'as-recorded', null, 100, 2)).toEqual({
      times: [0, 15, 65, 65, 115],
      gapsCapped: 2,
    });
    expect(buildSchedule(offsets, 'as-recorded', null, null, 0.5).times).toEqual([
      0, 60, 560, 560, 1760,
    ]);
    const builder = new ScheduleBuilder('as-recorded', null, null, 4);
    for (const o of offsets) builder.next(o);
    // The requested rate scales with the speed: four gaps over 880 / 4 = 220 ms.
    expect(builder.requestedRps()).toBe(18.182);
  });

  it('rejects a factor that is not a positive number', () => {
    expect(() => new ScheduleBuilder('as-recorded', null, null, 0)).toThrow(RangeError);
    expect(() => new ScheduleBuilder('max', null, null, Number.NaN)).toThrow(RangeError);
  });
});
