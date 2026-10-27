import type { Run, TagStats } from '@replay-parity/core';
import {
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPercent,
  invariantSummary,
  pacingLine,
  topMismatchPaths,
  verdictLabel,
} from './format.js';

/**
 * The Markdown summary, for a pull request comment or a GitHub job summary.
 * GitHub flavored tables, no HTML, and short enough to read in a comment:
 * the demo run renders in well under 150 lines.
 */

const REPRODUCTION_STEPS_SHOWN = 12;
const AGENT_CASES_SHOWN = 10;

/**
 * Plain text in a cell or a list item. Markdown punctuation is escaped so a
 * recorded string cannot open a link, emphasis, a code span, or an HTML tag,
 * a pipe cannot end a cell, and a line break becomes a space.
 */
function cell(value: unknown): string {
  return String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
}

/**
 * Inline code. Only a pipe needs escaping inside a code span, and a value
 * that contains a backtick is fenced with double backticks.
 */
function code(value: unknown): string {
  const text = String(value).replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
  if (text.length === 0) return '';
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function table(header: string[], align: ('left' | 'right')[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(header),
    line(align.map((a) => (a === 'right' ? '---:' : '---'))),
    ...rows.map((r) => line(r)),
  ];
}

function latencyRow(tag: string, s: TagStats): string[] {
  const pair = (a: number, b: number): string => `${fmtMs(a)} / ${fmtMs(b)}`;
  return [
    cell(tag),
    String(s.count),
    String(s.errors),
    pair(s.reference.p50_ms, s.candidate.p50_ms),
    pair(s.reference.p99_ms, s.candidate.p99_ms),
    pair(s.reference.max_ms, s.candidate.max_ms),
  ];
}

function header(run: Run): string[] {
  const lines = [
    `# replay-parity: ${verdictLabel(run)} (run ${run.run_id})`,
    '',
    `- Recording: ${code(run.recording.path)} (${run.recording.exchanges} exchanges, ${run.recording.selected} selected)`,
    `- Target: ${code(run.target)} via ${cell(run.adapter)}`,
    `- Pacing: ${cell(pacingLine(run))}`,
    `- Duration: ${fmtDuration(run.duration_ms)}, warmup ${run.warmup}, filter ${cell(run.filter.tag ?? 'none')}, limit ${run.limit ?? 'none'}`,
  ];
  if (run.inconclusive.length > 0) {
    lines.push('', '**Inconclusive because**', '');
    for (const c of run.inconclusive) lines.push(`- ${code(c.kind)}: ${cell(c.detail)}`);
  }
  return lines;
}

function thresholds(run: Run): string[] {
  const lines = ['', '## Thresholds', ''];
  if (run.threshold_results.length === 0) return [...lines, 'No thresholds configured.'];
  return [
    ...lines,
    ...table(
      ['Outcome', 'Row', 'Limit', 'Measured', 'Detail'],
      ['left', 'left', 'right', 'right', 'left'],
      run.threshold_results.map((r) => [
        r.outcome,
        code(r.id),
        fmtNumber(r.limit),
        r.measured === null ? 'n/a' : fmtNumber(r.measured),
        cell(r.detail ?? ''),
      ]),
    ),
  ];
}

function latency(run: Run): string[] {
  const tags = Object.keys(run.stats.by_tag).sort();
  return [
    '',
    '## Latency',
    '',
    'Reference / candidate in milliseconds. Reference values come from the recording.',
    '',
    ...table(
      ['Tag', 'Count', 'Errors', 'p50', 'p99', 'max'],
      ['left', 'right', 'right', 'right', 'right', 'right'],
      [
        latencyRow('overall', run.stats.overall),
        ...tags.map((t) => latencyRow(t, run.stats.by_tag[t] as TagStats)),
      ],
    ),
  ];
}

function correctness(run: Run): string[] {
  const o = run.stats.overall;
  const lines = [
    '',
    '## Correctness',
    '',
    `${o.compared} compared, ${o.matches} match, ${o.tolerated} tolerated, ${o.mismatches} mismatch (${fmtPercent(o.mismatch_rate)}), ${o.errors} errors (${fmtPercent(o.error_rate)}).`,
  ];
  const top = topMismatchPaths(run);
  if (top.length === 0) return [...lines, '', 'No untolerated differences.'];
  return [
    ...lines,
    '',
    'Top mismatching paths. Array positions are folded into `[*]`, so rows that moved count as one path.',
    '',
    ...table(
      ['Path', 'Findings', 'Exchanges'],
      ['left', 'right', 'right'],
      top.map((t) => [code(t.path), String(t.count), String(t.exchanges)]),
    ),
  ];
}

function invariants(run: Run): string[] {
  const { reference, candidate } = run.invariants;
  if (reference === null && candidate === null) return [];
  const lines = [
    '',
    '## Invariants',
    '',
    'Each system is checked against its own recording. Agreement between the two systems is not evidence of correctness.',
    '',
  ];
  for (const report of [reference, candidate]) {
    if (report === null) continue;
    lines.push(`- ${cell(report.system)}: ${invariantSummary(report)}`);
    for (const r of report.results) {
      if (r.status !== 'violated' && r.status !== 'inconclusive') continue;
      const evidence = r.evidence
        .slice(0, 3)
        .map(
          (e) =>
            `${e.subject}: expected ${JSON.stringify(e.expected)}, observed ${JSON.stringify(e.observed)}. ${e.detail}`,
        );
      const tail = [r.detail, ...evidence].filter((t): t is string => t !== undefined);
      lines.push(
        `  - ${r.id}. ${code(r.name)} ${r.status} (${r.checks} check${r.checks === 1 ? '' : 's'})${
          tail.length === 0 ? '' : `: ${cell(tail.join('; '))}`
        }`,
      );
    }
    for (const c of report.inconclusive) lines.push(`  - ${code(c.kind)}: ${cell(c.detail)}`);
  }
  return lines;
}

function reproduction(run: Run): string[] {
  const r = run.reproduction;
  if (r === null) return [];
  const lines = [
    '',
    '## Reproduction',
    '',
    `**${r.label}** for rule ${code(r.rule)}: ${r.original_steps} recorded steps reduced to ${r.reduced_steps} in ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} (${fmtDuration(r.duration_ms)})${
      r.recording === null ? '' : `, written to ${code(r.recording)}`
    }.`,
  ];
  if (r.steps.length === 0) return lines;
  lines.push(
    '',
    ...table(
      ['#', 'Request', 'Tags', 'Body'],
      ['right', 'left', 'left', 'left'],
      r.steps
        .slice(0, REPRODUCTION_STEPS_SHOWN)
        .map((s, i) => [
          String(i + 1),
          cell(`${s.method} ${s.path}`),
          cell(s.tags.join(', ')),
          `${s.body === undefined ? '' : code(JSON.stringify(s.body))}${s.quantity_reduced ? ' (quantity reduced)' : ''}`,
        ]),
    ),
  );
  if (r.steps.length > REPRODUCTION_STEPS_SHOWN) {
    lines.push('', `And ${r.steps.length - REPRODUCTION_STEPS_SHOWN} more steps in the run file.`);
  }
  return lines;
}

function agent(run: Run): string[] {
  const a = run.agent;
  if (a === undefined) return [];
  const lines = [
    '',
    '## Agent',
    '',
    `${cell(a.model)}: ${a.rounds} of ${a.max_rounds} rounds, ${a.proposed} cases proposed, ${a.valid} valid, ${a.executed} executed, ${a.kept} kept. Stopped on ${code(a.stop_reason)}. Cost $${a.cost_usd.toFixed(2)} of a $${a.budget_usd.toFixed(2)} budget (${a.input_tokens} input tokens, ${a.output_tokens} output tokens, ${a.cache_read_tokens} read from cache).`,
  ];
  if (a.cases.length === 0) return [...lines, '', 'No case was kept.'];
  lines.push(
    '',
    ...table(
      ['Case', 'Round', 'Hypothesis', 'Tags', 'Status ref / cand', 'Revealed'],
      ['left', 'right', 'left', 'left', 'left', 'left'],
      a.cases
        .slice(0, AGENT_CASES_SHOWN)
        .map((c) => [
          code(c.id),
          String(c.round),
          cell(c.hypothesis),
          cell(c.tags.join(', ')),
          `${c.reference?.status ?? 'error'} / ${c.candidate?.status ?? 'error'}`,
          cell(c.revealed),
        ]),
    ),
  );
  if (a.cases.length > AGENT_CASES_SHOWN) {
    lines.push('', `And ${a.cases.length - AGENT_CASES_SHOWN} more kept cases in the run file.`);
  }
  return lines;
}

export function renderMarkdown(run: Run): string {
  const lines = [
    ...header(run),
    ...thresholds(run),
    ...latency(run),
    ...correctness(run),
    ...invariants(run),
    ...reproduction(run),
    ...agent(run),
  ];
  return `${lines.join('\n')}\n`;
}
