import type { Run } from '@replay-parity/core';

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

/** Untolerated finding paths across mismatched exchanges, most frequent first. */
export function topMismatchPaths(run: Run, limit = 10): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of run.exchanges) {
    if (e.control || e.diff?.verdict !== 'mismatch') continue;
    for (const f of e.diff.findings) {
      if (f.tolerated) continue;
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
    .slice(0, limit);
}

export function mismatchedExchanges(run: Run): Run['exchanges'] {
  return run.exchanges.filter((e) => !e.control && e.diff?.verdict === 'mismatch');
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
