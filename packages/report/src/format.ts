import type { ExchangeResult, Run } from '@replay-parity/core';

/** Number formatting shared by the renderers. Deterministic, locale free. */

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function fmtRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return value.toFixed(1);
}

export function fmtPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${fmtMs(ms)} ms`;
}

export function verdictLabel(run: Run): string {
  return run.verdict.toUpperCase();
}

export function pacingLine(run: Run): string {
  const p = run.pacing;
  const parts = [
    `${p.mode}${p.rps === null ? '' : ` at ${fmtRate(p.rps)} rps`}`,
    `concurrency ${p.concurrency}`,
    `requested ${p.requested_rps === null ? 'n/a' : `${fmtRate(p.requested_rps)} rps`}`,
    `achieved ${fmtRate(p.achieved_rps)} rps`,
    `schedule slip p50 ${fmtMs(p.slip_p50_ms)} ms, max ${fmtMs(p.slip_max_ms)} ms`,
  ];
  if (p.barrier_tags.length > 0) {
    parts.push(
      `barriers on ${p.barrier_tags.join(', ')} (${p.barrier_waits} wait${p.barrier_waits === 1 ? '' : 's'}, timeout ${p.barrier_timeout_ms} ms)`,
    );
  }
  return parts.join(', ');
}

/** Folds array positions into `[*]`, so rows that moved count as one path. */
export function generalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[*]');
}

export interface TopPath {
  /** The finding path with array positions folded into `[*]`. */
  path: string;
  /** Untolerated findings on the path. */
  count: number;
  /** Mismatched exchanges those findings came from. */
  exchanges: number;
}

/**
 * Untolerated finding paths across mismatched exchanges, most frequent first.
 * Array positions are folded, so an ordering divergence over forty rows shows
 * as one line with forty findings instead of forty lines with one each.
 */
export function topMismatchPaths(run: Run, limit = 10): TopPath[] {
  const counts = new Map<string, { count: number; exchanges: Set<string> }>();
  for (const e of run.exchanges) {
    if (e.control || e.diff?.verdict !== 'mismatch') continue;
    for (const f of e.diff.findings) {
      if (f.tolerated) continue;
      const key = generalizePath(f.path);
      let entry = counts.get(key);
      if (entry === undefined) {
        entry = { count: 0, exchanges: new Set() };
        counts.set(key, entry);
      }
      entry.count += 1;
      entry.exchanges.add(e.id);
    }
  }
  return [...counts.entries()]
    .map(([path, v]) => ({ path, count: v.count, exchanges: v.exchanges.size }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
    .slice(0, limit);
}

export function describeTopPath(t: TopPath): string {
  return `${t.path} x${t.count} in ${t.exchanges} exchange${t.exchanges === 1 ? '' : 's'}`;
}

export function mismatchedExchanges(run: Run): Run['exchanges'] {
  return run.exchanges.filter((e) => !e.control && e.diff?.verdict === 'mismatch');
}

/** The most mismatched exchanges the HTML drill down renders inline. */
export const DRILL_DOWN_CAP = 200;

/** The group key for a mismatched exchange with no untolerated finding. */
export const DRILL_DOWN_NO_PATH = '(no untolerated finding)';

export interface DrillDownGroup {
  /** The generalized path of the first untolerated finding of every exchange in the group. */
  path: string;
  /** Every mismatched exchange in the group, in run order. */
  exchanges: ExchangeResult[];
  /** The exchanges chosen for the drill down, a prefix of `exchanges`. */
  shown: ExchangeResult[];
}

export interface DrillDownPlan {
  /** Groups in the order of `topMismatchPaths`, so the most frequent path comes first. */
  groups: DrillDownGroup[];
  /** Mismatched exchanges in the run. */
  total: number;
  /** Exchanges chosen across every group. */
  shown: number;
}

/**
 * Chooses which mismatched exchanges the drill down renders. Exchanges are
 * grouped by the generalized path of their first untolerated finding and
 * taken round robin across the groups, in run order within a group, until
 * the cap is reached. Every path is therefore represented even when one
 * path accounts for nearly every mismatch.
 */
export function planDrillDown(run: Run, cap = DRILL_DOWN_CAP): DrillDownPlan {
  const byPath = new Map<string, ExchangeResult[]>();
  for (const e of mismatchedExchanges(run)) {
    const first = e.diff?.findings.find((f) => !f.tolerated);
    const key = first === undefined ? DRILL_DOWN_NO_PATH : generalizePath(first.path);
    const list = byPath.get(key);
    if (list === undefined) byPath.set(key, [e]);
    else list.push(e);
  }
  const order = topMismatchPaths(run, Number.POSITIVE_INFINITY).map((t) => t.path);
  const rank = (path: string): number => {
    const i = order.indexOf(path);
    return i === -1 ? order.length : i;
  };
  const groups: DrillDownGroup[] = [...byPath.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1))
    .map(([path, exchanges]) => ({ path, exchanges, shown: [] }));
  const total = groups.reduce((n, g) => n + g.exchanges.length, 0);
  const shown = Math.min(Math.max(0, cap), total);
  let remaining = shown;
  while (remaining > 0) {
    for (const g of groups) {
      if (remaining === 0) break;
      const next = g.exchanges[g.shown.length];
      if (next === undefined) continue;
      g.shown.push(next);
      remaining -= 1;
    }
  }
  return { groups, total, shown };
}

export function controlExchanges(run: Run): Run['exchanges'] {
  return run.exchanges.filter((e) => e.control);
}

export function invariantSummary(report: NonNullable<Run['invariants']['reference']>): string {
  const by = { holds: 0, violated: 0, not_applicable: 0, inconclusive: 0 };
  for (const r of report.results) by[r.status] += 1;
  const parts = [`${by.holds} hold`];
  if (by.violated > 0) parts.push(`${by.violated} violated`);
  if (by.inconclusive > 0) parts.push(`${by.inconclusive} inconclusive`);
  if (by.not_applicable > 0) parts.push(`${by.not_applicable} not applicable`);
  return parts.join(', ');
}
