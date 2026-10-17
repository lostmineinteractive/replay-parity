import type { PacingMode } from '@replay-parity/core';

/**
 * Send schedules. Every time is in milliseconds since the run started.
 *
 * `as-recorded` keeps the gaps of the recording. `fixed-rate` spaces sends
 * evenly at the requested rate. `max` has no schedule: the engine sends as
 * soon as a slot is free, and the scheduled time of each exchange is the
 * moment it became eligible, so slip is near zero by construction.
 */
export function buildSchedule(
  offsets: readonly number[],
  mode: PacingMode,
  rps: number | null,
): number[] {
  if (offsets.length === 0) return [];
  switch (mode) {
    case 'as-recorded': {
      const first = offsets[0] as number;
      return offsets.map((o) => o - first);
    }
    case 'fixed-rate': {
      if (rps === null || !(rps > 0)) {
        throw new RangeError('fixed-rate pacing needs a positive rps');
      }
      return offsets.map((_, i) => (i * 1000) / rps);
    }
    case 'max':
      return offsets.map(() => 0);
  }
}

/** The rate the schedule asks for, or `null` when the mode has none. */
export function requestedRps(
  offsets: readonly number[],
  mode: PacingMode,
  rps: number | null,
): number | null {
  switch (mode) {
    case 'fixed-rate':
      return rps;
    case 'as-recorded': {
      if (offsets.length < 2) return null;
      const span = (offsets[offsets.length - 1] as number) - (offsets[0] as number);
      return span > 0 ? round3(((offsets.length - 1) * 1000) / span) : null;
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
