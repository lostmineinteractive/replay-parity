import * as hdr from 'hdr-histogram-js';
import type { LatencySummary } from './schema.js';

/**
 * Latency accumulation. Values are recorded in microseconds in an HDR
 * histogram with three significant digits, and in fixed log spaced bins that
 * the report renders without the histogram library.
 */

export const HISTOGRAM_BIN_COUNT = 48;
export const HISTOGRAM_MIN_MS = 0.1;
export const HISTOGRAM_MAX_MS = 10_000;

const DECADES = Math.log10(HISTOGRAM_MAX_MS / HISTOGRAM_MIN_MS);

function computeEdges(): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= HISTOGRAM_BIN_COUNT; i += 1) {
    edges.push(round(HISTOGRAM_MIN_MS * 10 ** ((DECADES * i) / HISTOGRAM_BIN_COUNT), 4));
  }
  return edges;
}

/** Bin edges in milliseconds. There are `HISTOGRAM_BIN_COUNT + 1` edges. */
export const HISTOGRAM_EDGES_MS: readonly number[] = computeEdges();

export function binIndex(ms: number): number {
  if (!(ms > HISTOGRAM_MIN_MS)) return 0;
  const idx = Math.floor((Math.log10(ms / HISTOGRAM_MIN_MS) * HISTOGRAM_BIN_COUNT) / DECADES);
  return Math.min(HISTOGRAM_BIN_COUNT - 1, Math.max(0, idx));
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function emptySummary(): LatencySummary {
  return { count: 0, p50_ms: 0, p90_ms: 0, p99_ms: 0, p999_ms: 0, max_ms: 0, mean_ms: 0 };
}

/**
 * The summary of a small sample by exact nearest rank percentiles, for places
 * that hold every value and need no histogram. The p-th percentile is the
 * value at rank `ceil(p / 100 * n)`, so one sample is its own every percentile.
 */
export function exactSummary(values: readonly number[]): LatencySummary {
  if (values.length === 0) return emptySummary();
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (pct: number): number =>
    round(sorted[Math.min(n - 1, Math.max(0, Math.ceil((pct / 100) * n) - 1))] as number, 3);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: n,
    p50_ms: at(50),
    p90_ms: at(90),
    p99_ms: at(99),
    p999_ms: at(99.9),
    max_ms: round(sorted[n - 1] as number, 3),
    mean_ms: round(sum / n, 3),
  };
}

export class LatencyAccumulator {
  private readonly histogram = hdr.build({
    numberOfSignificantValueDigits: 3,
    lowestDiscernibleValue: 1,
    highestTrackableValue: 60_000_000,
    autoResize: true,
  });
  private readonly bins: number[] = new Array<number>(HISTOGRAM_BIN_COUNT).fill(0);
  private total = 0;
  private sum = 0;
  private maxSeen = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`latency must be a finite non negative number, got ${String(ms)}`);
    }
    const micros = Math.max(1, Math.round(ms * 1000));
    this.histogram.recordValue(micros);
    this.bins[binIndex(ms)] = (this.bins[binIndex(ms)] ?? 0) + 1;
    this.total += 1;
    this.sum += ms;
    if (ms > this.maxSeen) this.maxSeen = ms;
  }

  get count(): number {
    return this.total;
  }

  summary(): LatencySummary {
    if (this.total === 0) return emptySummary();
    const p = (pct: number): number => round(this.histogram.getValueAtPercentile(pct) / 1000, 3);
    return {
      count: this.total,
      p50_ms: p(50),
      p90_ms: p(90),
      p99_ms: p(99),
      p999_ms: p(99.9),
      max_ms: round(this.maxSeen, 3),
      mean_ms: round(this.sum / this.total, 3),
    };
  }

  binCounts(): number[] {
    return [...this.bins];
  }
}
