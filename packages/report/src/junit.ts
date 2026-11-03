import type { InvariantReport, Run, ThresholdResult } from '@replay-parity/core';
import { baselineLine, fmtNumber, toleratedRowIds } from './format.js';

/**
 * JUnit XML for CI systems. One suite per threshold section that has rows,
 * one suite per system for the invariant results, and a `run` suite whose
 * single case carries the verdict. Every value from the run is escaped and
 * nothing depends on the clock, so the same run renders the same bytes.
 */

const SECTIONS: readonly ThresholdResult['section'][] = [
  'latency',
  'correctness',
  'errors',
  'throughput',
  'status',
  'baseline',
  'pacing',
  'invariants',
];

interface JunitCase {
  name: string;
  classname: string;
  /** Seconds, as JUnit expects. */
  time: number;
  failure?: { message: string; body: string } | undefined;
  skipped?: { message: string } | undefined;
}

interface JunitSuite {
  name: string;
  cases: JunitCase[];
  properties?: [string, string][] | undefined;
}

/**
 * Escapes a value for an XML attribute or text node and drops the control
 * characters that XML 1.0 does not allow at all, so a recorded string can
 * never break the document.
 */
export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function measure(r: ThresholdResult): string {
  return `measured ${r.measured === null ? 'n/a' : fmtNumber(r.measured)}, limit ${fmtNumber(r.limit)}`;
}

function thresholdCase(r: ThresholdResult, tolerated: ReadonlySet<string>): JunitCase {
  const reason = r.detail ?? 'inconclusive';
  const body = `${r.id}: ${r.metric} on ${r.scope} ${measure(r)}${r.detail === undefined ? '' : `. ${r.detail}`}`;
  return {
    name: r.id,
    classname: r.section,
    time: 0,
    failure: r.outcome === 'fail' ? { message: measure(r), body } : undefined,
    skipped:
      r.outcome === 'inconclusive'
        ? {
            message: tolerated.has(r.id)
              ? `tolerated by the inconclusive budget: ${reason}`
              : reason,
          }
        : undefined,
  };
}

function invariantSuite(report: InvariantReport): JunitSuite {
  const classname = `invariants.${report.system}`;
  const cases = report.results.map((r): JunitCase => {
    const evidence = r.evidence.map(
      (e) =>
        `${e.subject}: expected ${JSON.stringify(e.expected)}, observed ${JSON.stringify(e.observed)}. ${e.detail}${
          e.exchange_id === null ? '' : ` (exchange ${e.exchange_id})`
        }`,
    );
    const head = `${r.id}. ${r.name} ${r.status.replace('_', ' ')} after ${r.checks} check${r.checks === 1 ? '' : 's'}${
      r.detail === undefined ? '' : `. ${r.detail}`
    }`;
    return {
      name: r.name,
      classname,
      time: 0,
      failure:
        r.status === 'violated'
          ? { message: evidence[0] ?? head, body: [head, r.statement, ...evidence].join('\n') }
          : undefined,
      skipped:
        r.status === 'inconclusive' || r.status === 'not_applicable'
          ? { message: r.detail ?? r.status.replace('_', ' ') }
          : undefined,
    };
  });
  return { name: classname, cases };
}

function verdictSuite(run: Run): JunitSuite {
  const failedRows = run.threshold_results.filter((r) => r.outcome === 'fail');
  const violations =
    (run.invariants.reference?.violations ?? 0) + (run.invariants.candidate?.violations ?? 0);
  const conditions = run.inconclusive.map((c) => `${c.kind}: ${c.detail}`);
  const verdict: JunitCase = {
    name: 'verdict',
    classname: 'run',
    time: run.duration_ms / 1000,
    failure:
      run.verdict === 'fail'
        ? {
            message: `verdict fail: ${failedRows.length} threshold row${failedRows.length === 1 ? '' : 's'} failed, ${violations} invariant violation${violations === 1 ? '' : 's'}`,
            body: failedRows.map((r) => `${r.id} ${measure(r)}`).join('\n'),
          }
        : undefined,
    skipped:
      run.verdict === 'inconclusive'
        ? { message: conditions.length === 0 ? 'inconclusive' : conditions.join('; ') }
        : undefined,
  };
  return {
    name: 'run',
    cases: [verdict],
    properties: [
      ['run_id', run.run_id],
      ['verdict', run.verdict],
      ['recording', run.recording.path],
      ['target', run.target],
      ['created_at', run.created_at],
      ...(baselineLine(run) === null
        ? []
        : ([['baseline', baselineLine(run) as string]] as [string, string][])),
    ],
  };
}

function seconds(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

function renderCase(c: JunitCase): string {
  const open = `    <testcase classname="${escapeXml(c.classname)}" name="${escapeXml(c.name)}" time="${seconds(c.time)}"`;
  if (c.failure !== undefined) {
    return `${open}>\n      <failure message="${escapeXml(c.failure.message)}" type="${escapeXml(c.classname)}">${escapeXml(c.failure.body)}</failure>\n    </testcase>\n`;
  }
  if (c.skipped !== undefined) {
    return `${open}>\n      <skipped message="${escapeXml(c.skipped.message)}"/>\n    </testcase>\n`;
  }
  return `${open}/>\n`;
}

function renderSuite(s: JunitSuite, run: Run): string {
  const failures = s.cases.filter((c) => c.failure !== undefined).length;
  const skipped = s.cases.filter((c) => c.skipped !== undefined).length;
  const time = s.cases.reduce((n, c) => n + c.time, 0);
  const properties =
    s.properties === undefined
      ? ''
      : `    <properties>\n${s.properties
          .map(([k, v]) => `      <property name="${escapeXml(k)}" value="${escapeXml(v)}"/>\n`)
          .join('')}    </properties>\n`;
  return `  <testsuite name="${escapeXml(s.name)}" tests="${s.cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(time)}" timestamp="${escapeXml(run.created_at)}">\n${properties}${s.cases
    .map(renderCase)
    .join('')}  </testsuite>\n`;
}

export function renderJunit(run: Run): string {
  const suites: JunitSuite[] = [];
  const tolerated = toleratedRowIds(run);
  for (const section of SECTIONS) {
    const rows = run.threshold_results.filter((r) => r.section === section);
    if (rows.length === 0) continue;
    suites.push({ name: section, cases: rows.map((r) => thresholdCase(r, tolerated)) });
  }
  for (const report of [run.invariants.reference, run.invariants.candidate]) {
    if (report !== null) suites.push(invariantSuite(report));
  }
  suites.push(verdictSuite(run));
  const cases = suites.flatMap((s) => s.cases);
  const failures = cases.filter((c) => c.failure !== undefined).length;
  const skipped = cases.filter((c) => c.skipped !== undefined).length;
  const time = cases.reduce((n, c) => n + c.time, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="replay-parity ${escapeXml(run.run_id)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(time)}">\n${suites
    .map((s) => renderSuite(s, run))
    .join('')}</testsuites>\n`;
}
