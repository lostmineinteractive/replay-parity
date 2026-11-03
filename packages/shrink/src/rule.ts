import {
  ConfigError,
  exactSummary,
  RUN_LEVEL_INCONCLUSIVE_KINDS,
  type Run,
  type Finding,
} from '@replay-parity/core';

/** The failing rule a reproduction is judged by. */
export type ShrinkRule =
  | {
      kind: 'invariant';
      system: 'reference' | 'candidate';
      name: string;
      /** The exchange that witnessed the violation, when known. Steps after it are dropped first. */
      witness?: string | undefined;
    }
  | { kind: 'mismatch'; exchangeId: string; path?: string | undefined }
  | {
      kind: 'latency';
      tag: string;
      metric: ShrinkLatencyMetric;
      /** The run's threshold limit for the tag and metric, in milliseconds. Filled by `shrink`. */
      limitMs?: number | undefined;
      /** Successful samples a verdict needs. Filled by `shrink`. */
      minSamples?: number | undefined;
    };

/** The percentiles a latency rule can name. */
export const SHRINK_LATENCY_METRICS = ['p50', 'p90', 'p99', 'max'] as const;
export type ShrinkLatencyMetric = (typeof SHRINK_LATENCY_METRICS)[number];

export function formatRule(rule: ShrinkRule): string {
  if (rule.kind === 'latency') return `latency:${rule.tag}:${rule.metric}`;
  if (rule.kind === 'invariant') return `invariant:${rule.system}:${rule.name}`;
  return rule.path === undefined
    ? `mismatch:${rule.exchangeId}`
    : `mismatch:${rule.exchangeId}:${rule.path}`;
}

/** Parses `invariant:<system>:<name>`, `mismatch:<exchange id>[:<path>]`, or `latency:<tag>:<metric>`. */
export function parseRule(text: string): ShrinkRule {
  const parts = text.split(':');
  if (parts[0] === 'latency') {
    // The metric is the last part, so a tag may hold a colon.
    const metric = parts[parts.length - 1] as string;
    const tag = parts.slice(1, -1).join(':');
    if (
      parts.length < 3 ||
      tag.length === 0 ||
      !(SHRINK_LATENCY_METRICS as readonly string[]).includes(metric)
    ) {
      throw new ConfigError(
        `rule ${JSON.stringify(text)}: expected latency:<tag>:<${SHRINK_LATENCY_METRICS.join('|')}>`,
      );
    }
    return { kind: 'latency', tag, metric: metric as ShrinkLatencyMetric };
  }
  if (parts[0] === 'invariant' && parts.length === 3) {
    const system = parts[1];
    const name = parts[2] as string;
    if ((system !== 'reference' && system !== 'candidate') || name.length === 0) {
      throw new ConfigError(
        `rule ${JSON.stringify(text)}: expected invariant:<reference|candidate>:<name>`,
      );
    }
    return { kind: 'invariant', system, name };
  }
  if (parts[0] === 'mismatch' && parts.length >= 2 && (parts[1] as string).length > 0) {
    const exchangeId = parts[1] as string;
    const path = parts.length > 2 ? parts.slice(2).join(':') : undefined;
    return path === undefined
      ? { kind: 'mismatch', exchangeId }
      : { kind: 'mismatch', exchangeId, path };
  }
  throw new ConfigError(
    `rule ${JSON.stringify(text)}: expected invariant:<system>:<name>, mismatch:<exchange id>[:<path>], or latency:<tag>:<metric>`,
  );
}

/** The first violated invariant, candidate first, else the first mismatching exchange. */
export function defaultRule(run: Run): ShrinkRule | null {
  for (const system of ['candidate', 'reference'] as const) {
    const violated = run.invariants[system]?.results.find((r) => r.status === 'violated');
    if (violated) {
      const witness = violated.evidence[0]?.exchange_id ?? undefined;
      return witness === undefined
        ? { kind: 'invariant', system, name: violated.name }
        : { kind: 'invariant', system, name: violated.name, witness };
    }
  }
  const mismatch = run.exchanges.find((e) => !e.control && e.diff?.verdict === 'mismatch');
  if (mismatch) {
    const first = mismatch.diff?.findings.find((f: Finding) => !f.tolerated);
    return first === undefined
      ? { kind: 'mismatch', exchangeId: mismatch.id }
      : { kind: 'mismatch', exchangeId: mismatch.id, path: first.path };
  }
  return null;
}

/** The exchange that must stay in every reduction, when the rule names one. */
export function witnessOf(rule: ShrinkRule): string | undefined {
  if (rule.kind === 'latency') return undefined;
  return rule.kind === 'invariant' ? rule.witness : rule.exchangeId;
}

/**
 * The candidate latencies of the successful exchanges that carry `tag`, in
 * milliseconds. Warmup, control, and dependency exchanges and exchanges that
 * errored are left out, as in the run's statistics.
 */
export function latencySamples(run: Run, tag: string): number[] {
  const out: number[] = [];
  for (const e of run.exchanges) {
    if (e.warmup || e.control || e.dependency || !e.tags.includes(tag)) continue;
    if (e.candidate === null || e.diff === null || e.error !== null) continue;
    out.push(e.candidate.latency_ms);
  }
  return out;
}

/**
 * Whether the percentile of `samples` named by the rule exceeds the rule's
 * limit. Fewer samples than the rule's minimum, or no limit, never breach.
 */
export function latencyBreached(
  samples: readonly number[],
  rule: Extract<ShrinkRule, { kind: 'latency' }>,
): boolean {
  if (rule.limitMs === undefined || samples.length === 0) return false;
  if (samples.length < (rule.minSamples ?? 1)) return false;
  const summary = exactSummary(samples);
  return summary[`${rule.metric}_ms`] > rule.limitMs;
}

/** Whether a replayed attempt still trips the rule. An inconclusive attempt never counts. */
export function reproduces(run: Run, rule: ShrinkRule): boolean {
  if (run.inconclusive.some((c) => RUN_LEVEL_INCONCLUSIVE_KINDS.has(c.kind))) return false;
  if (rule.kind === 'latency') return latencyBreached(latencySamples(run, rule.tag), rule);
  if (rule.kind === 'invariant') {
    const result = run.invariants[rule.system]?.results.find((r) => r.name === rule.name);
    return result?.status === 'violated';
  }
  const exchange = run.exchanges.find((e) => e.id === rule.exchangeId);
  if (exchange?.diff?.verdict !== 'mismatch') return false;
  if (rule.path === undefined) return true;
  const path = rule.path;
  return exchange.diff.findings.some((f) => !f.tolerated && f.path === path);
}
