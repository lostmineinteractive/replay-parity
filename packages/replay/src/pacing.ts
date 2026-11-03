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

/**
 * Builds a schedule one exchange at a time, so a recording read as a stream
 * gets the same times as one held in memory. `next` takes the recorded offset
 * of the next selected exchange and returns its scheduled time.
 */
export class ScheduleBuilder {
  private first: number | null = null;
  private previous = 0;
  /** The time removed by capping so far. */
  private removed = 0;
  private count = 0;
  private lastTime = 0;
  /** How many recorded gaps were reduced to the cap. */
  gapsCapped = 0;

  constructor(
    private readonly mode: PacingMode,
    private readonly rps: number | null,
    private readonly maxGapMs: number | null = null,
  ) {
    if (mode === 'as-recorded' && maxGapMs !== null && !(maxGapMs > 0)) {
      throw new RangeError('the gap cap must be positive or null');
    }
    if (mode === 'fixed-rate' && (rps === null || !(rps > 0))) {
      throw new RangeError('fixed-rate pacing needs a positive rps');
    }
  }

  next(offset: number): number {
    const i = this.count;
    this.count += 1;
    let time: number;
    switch (this.mode) {
      case 'as-recorded': {
        if (this.first === null) {
          this.first = offset;
        } else if (this.maxGapMs !== null) {
          const gap = offset - this.previous;
          if (gap > this.maxGapMs) {
            this.removed += gap - this.maxGapMs;
            this.gapsCapped += 1;
          }
        }
        this.previous = offset;
        // Without a cap every time is the recorded offset relative to the first exchange.
        time = offset - this.first - this.removed;
        break;
      }
      case 'fixed-rate':
        time = (i * 1000) / (this.rps as number);
        break;
      case 'max':
        time = 0;
        break;
    }
    this.lastTime = time;
    return time;
  }

  /** The scheduled time of the last exchange so far, 0 before any. */
  get end(): number {
    return this.lastTime;
  }

  /** The rate the schedule asks for, as `requestedRps` computes it over every time so far. */
  requestedRps(): number | null {
    switch (this.mode) {
      case 'fixed-rate':
        return this.rps;
      case 'as-recorded':
        if (this.count < 2) return null;
        return this.lastTime > 0 ? round3(((this.count - 1) * 1000) / this.lastTime) : null;
      case 'max':
        return null;
    }
  }
}

export function buildSchedule(
  offsets: readonly number[],
  mode: PacingMode,
  rps: number | null,
  maxGapMs: number | null = null,
): Schedule {
  if (offsets.length === 0) return { times: [], gapsCapped: 0 };
  const builder = new ScheduleBuilder(mode, rps, maxGapMs);
  const times = offsets.map((o) => builder.next(o));
  return { times, gapsCapped: builder.gapsCapped };
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
