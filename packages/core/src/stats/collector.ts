import type { Verdict } from '../differ/schema.js';
import { HISTOGRAM_EDGES_MS, LatencyAccumulator } from './histogram.js';
import type { RunStats, TagStats } from './schema.js';

export interface StatsSample {
  tags: readonly string[];
  /** `null` when the exchange errored and was not diffed. */
  verdict: Verdict | null;
  /** `null` when the exchange errored. */
  candidateLatencyMs: number | null;
  referenceLatencyMs: number;
}

class Bucket {
  count = 0;
  errors = 0;
  matches = 0;
  tolerated = 0;
  mismatches = 0;
  readonly candidate = new LatencyAccumulator();
  readonly reference = new LatencyAccumulator();

  record(sample: StatsSample): void {
    this.count += 1;
    this.reference.record(sample.referenceLatencyMs);
    if (sample.candidateLatencyMs === null || sample.verdict === null) {
      this.errors += 1;
      return;
    }
    this.candidate.record(sample.candidateLatencyMs);
    if (sample.verdict === 'match') this.matches += 1;
    else if (sample.verdict === 'tolerated') this.tolerated += 1;
    else this.mismatches += 1;
  }

  stats(): TagStats {
    const compared = this.count - this.errors;
    return {
      count: this.count,
      errors: this.errors,
      error_rate: this.count === 0 ? 0 : round(this.errors / this.count),
      compared,
      matches: this.matches,
      tolerated: this.tolerated,
      mismatches: this.mismatches,
      mismatch_rate: compared === 0 ? 0 : round(this.mismatches / compared),
      candidate: this.candidate.summary(),
      reference: this.reference.summary(),
      histogram: {
        candidate: this.candidate.binCounts(),
        reference: this.reference.binCounts(),
      },
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Aggregates per exchange samples into overall and per tag statistics. An
 * exchange with several tags is counted once overall and once per tag.
 */
export class StatsCollector {
  private readonly overall = new Bucket();
  private readonly byTag = new Map<string, Bucket>();

  record(sample: StatsSample): void {
    this.overall.record(sample);
    for (const tag of new Set(sample.tags)) {
      let bucket = this.byTag.get(tag);
      if (!bucket) {
        bucket = new Bucket();
        this.byTag.set(tag, bucket);
      }
      bucket.record(sample);
    }
  }

  finish(): RunStats {
    const by_tag: Record<string, TagStats> = {};
    for (const tag of [...this.byTag.keys()].sort()) {
      by_tag[tag] = (this.byTag.get(tag) as Bucket).stats();
    }
    return {
      histogram_edges_ms: [...HISTOGRAM_EDGES_MS],
      overall: this.overall.stats(),
      by_tag,
    };
  }
}
