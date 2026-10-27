import type { PacingMode } from '@replay-parity/core';

/**
 * Send schedules. Every time is in milliseconds since the run started.
 *
 * `as-recorded` keeps the gaps of the recording, except that a gap longer
 * than `maxGapMs` is reduced to the cap so an idle period in the recording
 * does not replay as silence. `fixed-rate` spaces sends evenly at the
 * requested rate. `max` has no schedule: the engine sends as soon as a slot
 * is free, and the scheduled time of each exchange is the moment it became
 * eligible, so slip is near zero by construction.
 */
export interface Schedule {
  /** The scheduled send time of each exchange. */
  times: number[];
  /** How many recorded gaps were reduced to the cap. */
  gapsCapped: number;
}

export function buildSchedule(
  offsets: readonly number[],
  mode: PacingMode,
  rps: number | null,
  maxGapMs: number | null = null,
): Schedule {
  if (offsets.length === 0) return { times: [], gapsCapped: 0 };
  switch (mode) {
    case 'as-recorded': {
      if (maxGapMs !== null && !(maxGapMs > 0)) {
        throw new RangeError('the gap cap must be positive or null');
      }
      const first = offsets[0] as number;
      // The time removed by capping so far. Without a cap every time is the recorded offset
      // relative to the first exchange, exactly as before.
      let removed = 0;
      let gapsCapped = 0;
      const times = offsets.map((o, i) => {
        if (i > 0 && maxGapMs !== null) {
          const gap = o - (offsets[i - 1] as number);
          if (gap > maxGapMs) {
            removed += gap - maxGapMs;
            gapsCapped += 1;
          }
        }
        return o - first - removed;
      });
      return { times, gapsCapped };
    }
    case 'fixed-rate': {
      if (rps === null || !(rps > 0)) {
        throw new RangeError('fixed-rate pacing needs a positive rps');
      }
      return { times: offsets.map((_, i) => (i * 1000) / rps), gapsCapped: 0 };
    }
    case 'max':
      return { times: offsets.map(() => 0), gapsCapped: 0 };
  }
}

/**
 * The rate the schedule asks for, or `null` when the mode has none. Under
 * `as-recorded` the engine passes the scheduled times, so the rate reflects
 * the capped gaps.
 */
export function requestedRps(
  times: readonly number[],
  mode: PacingMode,
  rps: number | null,
): number | null {
  switch (mode) {
    case 'fixed-rate':
      return rps;
    case 'as-recorded': {
      if (times.length < 2) return null;
      const span = (times[times.length - 1] as number) - (times[0] as number);
      return span > 0 ? round3(((times.length - 1) * 1000) / span) : null;
    }
    case 'max':
      return null;
  }
}

export interface SlipSummary {
  p50_ms: number;
  max_ms: number;
}

/** The median and the largest value of `sent - scheduled`, clamped at zero. */
export function summarizeSlip(slips: readonly number[]): SlipSummary {
  if (slips.length === 0) return { p50_ms: 0, max_ms: 0 };
  const sorted = slips.map((s) => Math.max(0, s)).sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return {
    p50_ms: round3(sorted[mid] as number),
    max_ms: round3(sorted[sorted.length - 1] as number),
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
