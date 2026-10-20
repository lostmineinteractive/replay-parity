import type { Run, TagStats } from '@replay-parity/core';
import {
  controlExchanges,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPercent,
  invariantSummary,
  mismatchedExchanges,
  pacingLine,
  describeTopPath,
  topMismatchPaths,
  verdictLabel,
} from './format.js';

/**
 * The terminal summary. Plain text, fixed width columns, no color codes so
 * it reads the same in a log file.
 */
function table(rows: string[][], indent = '  '): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
  );
}

function latencyRow(tag: string, s: TagStats): string[] {
  return [
    tag,
    String(s.count),
    String(s.errors),
    `${fmtMs(s.reference.p50_ms)}/${fmtMs(s.candidate.p50_ms)}`,
    `${fmtMs(s.reference.p99_ms)}/${fmtMs(s.candidate.p99_ms)}`,
    `${fmtMs(s.reference.max_ms)}/${fmtMs(s.candidate.max_ms)}`,
    String(s.mismatches),
  ];
}

export function renderTerminal(run: Run): string {
  const lines: string[] = [];
  lines.push(`replay-parity run ${run.run_id}: ${verdictLabel(run)}`);
  lines.push(
    `recording ${run.recording.path} (${run.recording.exchanges} exchanges, ${run.recording.selected} selected) -> ${run.target} via ${run.adapter}`,
  );
  lines.push(`pacing ${pacingLine(run)}`);
  lines.push(
    `duration ${fmtDuration(run.duration_ms)}, warmup ${run.warmup}, filter ${run.filter.tag ?? 'none'}, limit ${run.limit ?? 'none'}`,
  );
  if (run.inconclusive.length > 0) {
    lines.push('inconclusive because:');
    for (const c of run.inconclusive) lines.push(`  - ${c.kind}: ${c.detail}`);
  }

  lines.push('thresholds:');
  if (run.threshold_results.length === 0) {
    lines.push('  none configured');
  } else {
    lines.push(
      ...table(
        run.threshold_results.map((r) => [
          r.outcome,
          r.id,
          `limit ${fmtNumber(r.limit)}`,
          `measured ${r.measured === null ? 'n/a' : fmtNumber(r.measured)}`,
          r.detail ?? '',
        ]),
      ),
    );
  }

  const { reference, candidate } = run.invariants;
  if (reference !== null || candidate !== null) {
    lines.push('invariants:');
    for (const report of [reference, candidate]) {
      if (report === null) continue;
      lines.push(`  ${report.system}: ${invariantSummary(report)}`);
      for (const r of report.results) {
        if (r.status !== 'violated' && r.status !== 'inconclusive') continue;
        lines.push(`    ${r.id}. ${r.name} ${r.status.toUpperCase()} (${r.checks} checks)`);
        if (r.detail !== undefined) lines.push(`       ${r.detail}`);
        for (const e of r.evidence.slice(0, 3)) {
          lines.push(
            `       ${e.subject}: expected ${JSON.stringify(e.expected)}, observed ${JSON.stringify(e.observed)}. ${e.detail}`,
          );
        }
      }
      for (const c of report.inconclusive) lines.push(`    ${c.kind}: ${c.detail}`);
    }
  }

  lines.push('latency by tag (reference/candidate, ms):');
  const header = ['tag', 'count', 'errors', 'p50', 'p99', 'max', 'mismatches'];
  const rows = [header, latencyRow('overall', run.stats.overall)];
  for (const tag of Object.keys(run.stats.by_tag).sort()) {
    rows.push(latencyRow(tag, run.stats.by_tag[tag] as TagStats));
  }
  lines.push(...table(rows));

  const o = run.stats.overall;
  lines.push(
    `correctness: ${o.compared} compared, ${o.matches} match, ${o.tolerated} tolerated, ${o.mismatches} mismatch (${fmtPercent(o.mismatch_rate)}), ${o.errors} errors (${fmtPercent(o.error_rate)})`,
  );
  const top = topMismatchPaths(run, 5);
  if (top.length > 0) {
    lines.push(`  top mismatching paths: ${top.map(describeTopPath).join(', ')}`);
  }
  const mismatched = mismatchedExchanges(run);
  for (const e of mismatched.slice(0, 5)) {
    const untolerated = e.diff?.findings.filter((f) => !f.tolerated) ?? [];
    lines.push(
      `  ${e.id} ${e.method} ${e.path} [${e.tags.join(', ')}] ${e.reference.status}/${e.candidate?.status ?? 'error'}: ${untolerated
        .slice(0, 3)
        .map((f) => f.path)
        .join(', ')}`,
    );
  }
  if (mismatched.length > 5) lines.push(`  and ${mismatched.length - 5} more`);

  const controls = controlExchanges(run);
  if (controls.length > 0) {
    lines.push(`controls (replayed in order, not scored): ${controls.length}`);
    for (const c of controls) {
      lines.push(
        `  ${c.method} ${c.path} ${c.reference.status}/${c.candidate?.status ?? 'error'} ${c.diff?.verdict ?? c.error ?? ''}`,
      );
    }
  }

  if (run.reproduction !== null) {
    const r = run.reproduction;
    lines.push(
      `reproduction: ${r.label}, rule ${r.rule}, ${r.original_steps} -> ${r.reduced_steps} steps in ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} (${fmtDuration(r.duration_ms)})${r.recording === null ? '' : `, written to ${r.recording}`}`,
    );
    for (const s of r.steps.slice(0, 12)) {
      lines.push(
        `  ${s.method} ${s.path}${s.body === undefined ? '' : ` ${JSON.stringify(s.body)}`}${s.quantity_reduced ? ' (quantity reduced)' : ''}`,
      );
    }
    if (r.steps.length > 12) lines.push(`  and ${r.steps.length - 12} more steps`);
  }

  if (run.agent !== undefined) {
    const a = run.agent;
    lines.push(
      `agent: ${a.model}, ${a.rounds}/${a.max_rounds} rounds, ${a.proposed} proposed, ${a.valid} valid, ${a.executed} executed, ${a.kept} kept, stopped on ${a.stop_reason}, cost $${a.cost_usd.toFixed(2)} of $${a.budget_usd.toFixed(2)}`,
    );
    for (const c of a.cases.slice(0, 10))
      lines.push(`  ${c.id} [${c.tags.join(', ')}] ${c.revealed}`);
    if (a.cases.length > 10) lines.push(`  and ${a.cases.length - 10} more kept cases`);
  }
  return `${lines.join('\n')}\n`;
}
