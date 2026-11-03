import { readRun, type Run, type TagStats, type ThresholdResult } from '@replay-parity/core';
import {
  fmtMs,
  fmtNumber,
  fmtPercent,
  topMismatchPaths,
  withSidecarExchanges,
} from '@replay-parity/report';
import { Command, Option } from 'commander';
import { err, type CliStreams } from '../io.js';

export type CompareFormat = 'terminal' | 'markdown' | 'json';

export interface CompareCommandOptions {
  format?: CompareFormat;
}

/** One side of a threshold row in a comparison. */
export interface CompareCell {
  limit: number;
  measured: number | null;
  outcome: ThresholdResult['outcome'];
}

export interface CompareRow {
  id: string;
  section: ThresholdResult['section'];
  scope: string;
  metric: string;
  /** Null when the row is not in that run. */
  a: CompareCell | null;
  b: CompareCell | null;
}

export interface ComparePath {
  path: string;
  /** Untolerated findings on the path in the run where it is among the top paths. */
  count: number;
  exchanges: number;
}

export interface CompareLatency {
  /** `overall` or a tag. */
  scope: string;
  /** Candidate percentiles in milliseconds, or null when the scope has no successful sample. */
  a: { count: number; p50_ms: number; p99_ms: number } | null;
  b: { count: number; p50_ms: number; p99_ms: number } | null;
  /** b minus a, or null when either side has no sample. */
  p50_delta_ms: number | null;
  p99_delta_ms: number | null;
}

export interface CompareCounts {
  compared: number;
  mismatches: number;
  mismatch_rate: number;
  errors: number;
  error_rate: number;
  /** Noise findings, or null when the run did not use the reference re-replay. */
  noise_findings: number | null;
}

export interface CompareRunInfo {
  path: string;
  run_id: string;
  created_at: string;
  verdict: Run['verdict'];
  recording_sha256: string | null;
}

/** Two runs side by side. `a` is the earlier run by convention, and every delta is b minus a. */
export interface RunComparison {
  a: CompareRunInfo;
  b: CompareRunInfo;
  /** Whether both runs replayed the same recording, or null when either has no hash. */
  same_recording: boolean | null;
  thresholds: CompareRow[];
  paths: { appeared: ComparePath[]; disappeared: ComparePath[] };
  latency: CompareLatency[];
  counts: { a: CompareCounts; b: CompareCounts };
}

/** How many top mismatching paths each run contributes to the comparison. */
export const COMPARE_TOP_PATHS = 10;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function info(run: Run, path: string): CompareRunInfo {
  return {
    path,
    run_id: run.run_id,
    created_at: run.created_at,
    verdict: run.verdict,
    recording_sha256: run.recording.recording_sha256 ?? null,
  };
}

function cell(row: ThresholdResult | undefined): CompareCell | null {
  if (row === undefined) return null;
  return { limit: row.limit, measured: row.measured, outcome: row.outcome };
}

function thresholdRows(a: Run, b: Run): CompareRow[] {
  const inA = new Map(a.threshold_results.map((r) => [r.id, r]));
  const inB = new Map(b.threshold_results.map((r) => [r.id, r]));
  // The rows of a in its order, then the rows only b has in b's order.
  const order = [...a.threshold_results, ...b.threshold_results.filter((r) => !inA.has(r.id))];
  return order.map((r) => ({
    id: r.id,
    section: r.section,
    scope: r.scope,
    metric: r.metric,
    a: cell(inA.get(r.id)),
    b: cell(inB.get(r.id)),
  }));
}

function latencyOf(stats: TagStats | undefined): CompareLatency['a'] {
  if (stats === undefined || stats.candidate.count === 0) return null;
  return {
    count: stats.candidate.count,
    p50_ms: stats.candidate.p50_ms,
    p99_ms: stats.candidate.p99_ms,
  };
}

function latencyRows(a: Run, b: Run): CompareLatency[] {
  const tags = [
    ...new Set([...Object.keys(a.stats.by_tag), ...Object.keys(b.stats.by_tag)]),
  ].sort();
  const scopes: [string, TagStats | undefined, TagStats | undefined][] = [
    ['overall', a.stats.overall, b.stats.overall],
    ...tags.map((t): [string, TagStats | undefined, TagStats | undefined] => [
      t,
      a.stats.by_tag[t],
      b.stats.by_tag[t],
    ]),
  ];
  return scopes.map(([scope, sa, sb]) => {
    const la = latencyOf(sa);
    const lb = latencyOf(sb);
    const both = la !== null && lb !== null;
    return {
      scope,
      a: la,
      b: lb,
      p50_delta_ms: both ? round3(lb.p50_ms - la.p50_ms) : null,
      p99_delta_ms: both ? round3(lb.p99_ms - la.p99_ms) : null,
    };
  });
}

function counts(run: Run): CompareCounts {
  const o = run.stats.overall;
  return {
    compared: o.compared,
    mismatches: o.mismatches,
    mismatch_rate: o.mismatch_rate,
    errors: o.errors,
    error_rate: o.error_rate,
    noise_findings: run.stats.noise_findings?.overall ?? null,
  };
}

/**
 * Compares two runs: the threshold rows side by side, the top mismatching paths that
 * appeared in b or disappeared from it, the candidate latency per tag with b minus a, and
 * the mismatch, error, and noise counts. The runs should hold every exchange, or have them
 * loaded from their sidecars, for the paths to be complete.
 */
export function compareRuns(a: Run, b: Run, paths = { a: '', b: '' }): RunComparison {
  const topA = topMismatchPaths(a, COMPARE_TOP_PATHS);
  const topB = topMismatchPaths(b, COMPARE_TOP_PATHS);
  const namesA = new Set(topA.map((t) => t.path));
  const namesB = new Set(topB.map((t) => t.path));
  const ha = a.recording.recording_sha256 ?? null;
  const hb = b.recording.recording_sha256 ?? null;
  return {
    a: info(a, paths.a),
    b: info(b, paths.b),
    same_recording: ha === null || hb === null ? null : ha === hb,
    thresholds: thresholdRows(a, b),
    paths: {
      appeared: topB.filter((t) => !namesA.has(t.path)),
      disappeared: topA.filter((t) => !namesB.has(t.path)),
    },
    latency: latencyRows(a, b),
    counts: { a: counts(a), b: counts(b) },
  };
}

function outcomeText(c: CompareCell | null): string {
  if (c === null) return '-';
  return `${c.outcome} ${fmtNumber(c.measured)}`;
}

function limitText(row: CompareRow): string {
  const la = row.a?.limit;
  const lb = row.b?.limit;
  if (la !== undefined && lb !== undefined && la !== lb) {
    return `${fmtNumber(la)} / ${fmtNumber(lb)}`;
  }
  return fmtNumber(la ?? lb);
}

function delta(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value > 0 ? '+' : ''}${fmtMs(value)}`;
}

function sameRecordingText(c: RunComparison): string {
  if (c.same_recording === null) return 'unknown, a recording hash is missing';
  return c.same_recording ? 'yes' : 'no, the runs replayed different recordings';
}

function countsText(x: CompareCounts): string[] {
  return [
    String(x.compared),
    `${x.mismatches} (${fmtPercent(x.mismatch_rate)})`,
    `${x.errors} (${fmtPercent(x.error_rate)})`,
    x.noise_findings === null ? 'n/a' : String(x.noise_findings),
  ];
}

function pathText(p: ComparePath): string {
  return `${p.path} x${p.count} in ${p.exchanges} exchange${p.exchanges === 1 ? '' : 's'}`;
}

function columns(rows: string[][], indent = '  '): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  }
  return rows.map(
    (row) =>
      `${indent}${row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')}`,
  );
}

export function renderComparisonTerminal(c: RunComparison): string {
  const lines: string[] = [
    `compare a ${c.a.run_id} (${c.a.verdict.toUpperCase()}) with b ${c.b.run_id} (${c.b.verdict.toUpperCase()})`,
    `  a: ${c.a.path}`,
    `  b: ${c.b.path}`,
    `  same recording: ${sameRecordingText(c)}`,
    '',
    'thresholds:',
  ];
  if (c.thresholds.length === 0) lines.push('  none in either run');
  else {
    lines.push(
      ...columns([
        ['row', 'limit', 'a', 'b'],
        ...c.thresholds.map((r) => [r.id, limitText(r), outcomeText(r.a), outcomeText(r.b)]),
      ]),
    );
  }
  lines.push('', 'top mismatching paths:');
  if (c.paths.appeared.length === 0 && c.paths.disappeared.length === 0) {
    lines.push('  no change');
  }
  for (const p of c.paths.appeared) lines.push(`  appeared in b: ${pathText(p)}`);
  for (const p of c.paths.disappeared) lines.push(`  gone from b: ${pathText(p)}`);
  lines.push(
    '',
    'candidate latency, ms (b minus a):',
    ...columns([
      ['scope', 'p50 a', 'p50 b', 'p50 delta', 'p99 a', 'p99 b', 'p99 delta'],
      ...c.latency.map((l) => [
        l.scope,
        fmtMs(l.a?.p50_ms),
        fmtMs(l.b?.p50_ms),
        delta(l.p50_delta_ms),
        fmtMs(l.a?.p99_ms),
        fmtMs(l.b?.p99_ms),
        delta(l.p99_delta_ms),
      ]),
    ]),
    '',
    'counts:',
    ...columns([
      ['run', 'compared', 'mismatches', 'errors', 'noise findings'],
      ['a', ...countsText(c.counts.a)],
      ['b', ...countsText(c.counts.b)],
    ]),
  );
  return `${lines.join('\n')}\n`;
}

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/[\\`*_[\]<>|~]/g, (ch) => `\\${ch}`);
}

function mdCode(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function mdTable(header: string[], align: ('left' | 'right')[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(header),
    line(align.map((x) => (x === 'right' ? '---:' : '---'))),
    ...rows.map((r) => line(r)),
  ];
}

export function renderComparisonMarkdown(c: RunComparison): string {
  const lines: string[] = [
    '# Run comparison',
    '',
    `- a: ${mdCode(c.a.run_id)} ${c.a.verdict.toUpperCase()}, ${mdCell(c.a.path)}`,
    `- b: ${mdCode(c.b.run_id)} ${c.b.verdict.toUpperCase()}, ${mdCell(c.b.path)}`,
    `- Same recording: ${mdCell(sameRecordingText(c))}`,
    '',
    '## Thresholds',
    '',
  ];
  if (c.thresholds.length === 0) lines.push('No thresholds in either run.');
  else {
    lines.push(
      ...mdTable(
        ['Row', 'Section', 'Scope', 'Limit', 'a', 'b'],
        ['left', 'left', 'left', 'right', 'left', 'left'],
        c.thresholds.map((r) => [
          mdCode(r.id),
          mdCell(r.section),
          mdCell(r.scope),
          limitText(r),
          outcomeText(r.a),
          outcomeText(r.b),
        ]),
      ),
    );
  }
  lines.push('', '## Top mismatching paths', '');
  if (c.paths.appeared.length === 0 && c.paths.disappeared.length === 0) {
    lines.push('No path appeared or disappeared.');
  } else {
    lines.push(
      ...mdTable(
        ['Change', 'Path', 'Findings', 'Exchanges'],
        ['left', 'left', 'right', 'right'],
        [
          ...c.paths.appeared.map((p) => [
            'appeared in b',
            mdCode(p.path),
            String(p.count),
            String(p.exchanges),
          ]),
          ...c.paths.disappeared.map((p) => [
            'gone from b',
            mdCode(p.path),
            String(p.count),
            String(p.exchanges),
          ]),
        ],
      ),
    );
  }
  lines.push(
    '',
    '## Candidate latency',
    '',
    'Milliseconds. Deltas are b minus a.',
    '',
    ...mdTable(
      ['Scope', 'p50 a', 'p50 b', 'p50 delta', 'p99 a', 'p99 b', 'p99 delta'],
      ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      c.latency.map((l) => [
        mdCell(l.scope),
        fmtMs(l.a?.p50_ms),
        fmtMs(l.b?.p50_ms),
        delta(l.p50_delta_ms),
        fmtMs(l.a?.p99_ms),
        fmtMs(l.b?.p99_ms),
        delta(l.p99_delta_ms),
      ]),
    ),
    '',
    '## Counts',
    '',
    ...mdTable(
      ['Run', 'Compared', 'Mismatches', 'Errors', 'Noise findings'],
      ['left', 'right', 'right', 'right', 'right'],
      [
        ['a', ...countsText(c.counts.a)],
        ['b', ...countsText(c.counts.b)],
      ],
    ),
  );
  return `${lines.join('\n')}\n`;
}

export function renderComparisonJson(c: RunComparison): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

const RENDERERS: Record<CompareFormat, (c: RunComparison) => string> = {
  terminal: renderComparisonTerminal,
  markdown: renderComparisonMarkdown,
  json: renderComparisonJson,
};

async function load(path: string, streams: CliStreams): Promise<Run> {
  const file = await readRun(path);
  const loaded = await withSidecarExchanges(file, path);
  if (loaded.sidecar === 'missing') {
    err(
      streams,
      `exchanges sidecar ${loaded.path} not found, comparing the ${file.exchanges.length} mismatched exchanges the run kept`,
    );
  }
  return loaded.run;
}

export async function runCompare(
  runA: string,
  runB: string,
  options: CompareCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const [a, b] = await Promise.all([load(runA, streams), load(runB, streams)]);
  const comparison = compareRuns(a, b, { a: runA, b: runB });
  streams.stdout.write(RENDERERS[options.format ?? 'terminal'](comparison));
  return 0;
}

export function compareCommand(streams: CliStreams, exit: (code: number) => void): Command {
  return new Command('compare')
    .description(
      'Compare two runs: threshold rows side by side, the mismatching paths that appeared or disappeared, the latency deltas per tag, and the noise and error counts. Exits 0 after a successful comparison whatever the verdicts.',
    )
    .argument('<run-a>', 'the earlier run file')
    .argument('<run-b>', 'the later run file; every delta is b minus a')
    .addOption(
      new Option('--format <name>', 'output format')
        .choices(['terminal', 'markdown', 'json'])
        .default('terminal'),
    )
    .action(async (runA: string, runB: string, opts: CompareCommandOptions) => {
      exit(await runCompare(runA, runB, opts, streams));
    });
}
