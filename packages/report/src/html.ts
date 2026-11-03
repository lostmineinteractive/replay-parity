import type { ExchangeResult, JsonValue, Run, TagStats } from '@replay-parity/core';
import {
  baselineLine,
  controlExchanges,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPercent,
  invariantSummary,
  openConditions,
  outcomeLabel,
  pacingLine,
  planDrillDown,
  toleratedConditions,
  toleratedHeading,
  toleratedRowIds,
  topMismatchPaths,
  verdictLabel,
} from './format.js';
import { SVG_CANDIDATE_COLOR, SVG_REFERENCE_COLOR, renderHistogram } from './svg.js';

/**
 * The HTML report. One file, inline CSS, inline SVG, no script, no external
 * resource, so it opens offline and survives being attached to a ticket.
 * Every recorded string goes through `esc`.
 */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function json(value: JsonValue | undefined): string {
  if (value === undefined) return '<span class="absent">absent</span>';
  const text = JSON.stringify(value, null, 1);
  return `<code>${esc(text.length > 400 ? `${text.slice(0, 397)}...` : text)}</code>`;
}

const CSS = `
:root { color-scheme: light; }
body { font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #222; margin: 0; background: #fafafa; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
header.run { display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-bottom: 8px; }
header.run h1 { font-size: 22px; margin: 0; }
.badge { font-weight: 700; padding: 4px 12px; border-radius: 4px; color: #fff; letter-spacing: .04em; }
.badge.pass { background: #2e7d32; } .badge.fail { background: #c62828; } .badge.inconclusive { background: #ef8f00; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0 24px; }
dl.meta dt { color: #666; } dl.meta dd { margin: 0; word-break: break-all; }
section { margin: 28px 0; } h2 { font-size: 18px; margin: 0 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
h3 { font-size: 15px; margin: 18px 0 6px; }
h4 { font-size: 14px; margin: 14px 0 4px; font-weight: 600; }
table { border-collapse: collapse; width: 100%; background: #fff; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
th { background: #f0f0f0; font-weight: 600; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.pass td.outcome { color: #2e7d32; font-weight: 600; } tr.fail td.outcome { color: #c62828; font-weight: 600; } tr.inconclusive td.outcome { color: #b26a00; font-weight: 600; }
.holds { color: #2e7d32; } .violated { color: #c62828; font-weight: 600; } .not_applicable { color: #888; } .inconclusive-text { color: #b26a00; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
.absent { color: #999; font-style: italic; }
.conditions { background: #fff4e0; border: 1px solid #f0c070; padding: 10px 14px; border-radius: 4px; }
.conditions li { margin: 2px 0; }
.conditions.tolerated { background: #f3f6f3; border-color: #b8cbb8; }
.legend span { display: inline-block; width: 12px; height: 12px; margin: 0 4px 0 12px; vertical-align: middle; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.charts figure { margin: 0; background: #fff; border: 1px solid #e6e6e6; padding: 6px; }
.charts svg { width: 100%; height: auto; }
details.exchange { background: #fff; border: 1px solid #e6e6e6; margin: 8px 0; padding: 6px 10px; }
details.exchange summary { cursor: pointer; font-weight: 600; }
.muted { color: #666; } .evidence { margin: 4px 0 8px 18px; }
footer { margin-top: 40px; color: #888; font-size: 12px; }
`;

function metaRows(run: Run): string {
  const rows: [string, string][] = [
    ['Run id', run.run_id],
    ['Created', run.created_at],
    [
      'Recording',
      `${run.recording.path} (${run.recording.exchanges} exchanges, ${run.recording.selected} selected${
        run.recording.first_ts === null
          ? ''
          : `, ${run.recording.first_ts} to ${run.recording.last_ts ?? ''}`
      })`,
    ],
    ['Target', `${run.target} via ${run.adapter}`],
    ['Pacing', pacingLine(run)],
    [
      'Selection',
      `warmup ${run.warmup}, filter ${run.filter.tag ?? 'none'}, limit ${run.limit ?? 'none'}, duration ${fmtDuration(run.duration_ms)}`,
    ],
  ];
  if (run.candidate_recording !== null) rows.push(['Candidate recording', run.candidate_recording]);
  const baseline = baselineLine(run);
  if (baseline !== null) rows.push(['Baseline', baseline]);
  return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function conditionList(list: Run['inconclusive']): string {
  return `<ul>${list.map((c) => `<li><code>${esc(c.kind)}</code> ${esc(c.detail)}</li>`).join('')}</ul>`;
}

function conditions(run: Run): string {
  const open = openConditions(run);
  const tolerated = toleratedConditions(run);
  const blocks: string[] = [];
  if (open.length > 0) {
    blocks.push(
      `<div class="conditions"><strong>Inconclusive because</strong>${conditionList(open)}</div>`,
    );
  }
  if (tolerated.length > 0) {
    blocks.push(
      `<div class="conditions tolerated"><strong>${esc(toleratedHeading(run))}</strong>${conditionList(tolerated)}</div>`,
    );
  }
  return blocks.join('');
}

function thresholds(run: Run): string {
  if (run.threshold_results.length === 0) {
    return '<section id="thresholds"><h2>Thresholds</h2><p class="muted">No thresholds configured.</p></section>';
  }
  const tolerated = toleratedRowIds(run);
  const rows = run.threshold_results
    .map(
      (r) =>
        `<tr class="${r.outcome}" data-id="${esc(r.id)}"><td class="outcome">${esc(outcomeLabel(r, tolerated))}</td><td><code>${esc(r.id)}</code></td><td>${esc(r.section)}</td><td>${esc(r.scope)}</td><td>${esc(r.metric)}</td><td class="num">${fmtNumber(r.limit)}</td><td class="num">${r.measured === null ? 'n/a' : fmtNumber(r.measured)}</td><td>${esc(r.detail ?? '')}</td></tr>`,
    )
    .join('');
  return `<section id="thresholds"><h2>Thresholds</h2><table><thead><tr><th>Outcome</th><th>Row</th><th>Section</th><th>Scope</th><th>Metric</th><th class="num">Limit</th><th class="num">Measured</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** The fragment id of an exchange's drill down entry. */
function exchangeAnchor(id: string): string {
  return `exchange-${id}`;
}

/** An evidence entry's exchange, linked to its drill down entry when the report shows one. */
function evidenceExchange(id: string, drilled: ReadonlySet<string>): string {
  const label = `exchange ${esc(id)}`;
  const target = drilled.has(id)
    ? `<a href="#${esc(encodeURIComponent(exchangeAnchor(id)))}">${label}</a>`
    : label;
  return ` <span class="muted">(${target})</span>`;
}

function invariants(run: Run): string {
  const { reference, candidate } = run.invariants;
  if (reference === null && candidate === null) return '';
  const drilled = new Set(planDrillDown(run).groups.flatMap((g) => g.shown.map((e) => e.id)));
  const blocks = [reference, candidate]
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((report) => {
      const rows = report.results
        .map((r) => {
          const evidence =
            r.evidence.length === 0
              ? ''
              : `<ul class="evidence">${r.evidence
                  .map(
                    (e) =>
                      `<li>${esc(e.subject)}: expected ${json(e.expected)}, observed ${json(e.observed)}. ${esc(e.detail)}${
                        e.exchange_id === null ? '' : evidenceExchange(e.exchange_id, drilled)
                      }</li>`,
                  )
                  .join('')}</ul>`;
          return `<tr class="inv-${esc(r.status)}"><td class="num">${r.id}</td><td><code>${esc(r.name)}</code><div class="muted">${esc(r.statement)}</div></td><td class="${r.status === 'inconclusive' ? 'inconclusive-text' : esc(r.status)}">${esc(r.status.replace('_', ' '))}</td><td class="num">${r.checks}</td><td>${esc(r.detail ?? '')}${evidence}</td></tr>`;
        })
        .join('');
      const conds = report.inconclusive
        .map((c) => `<li><code>${esc(c.kind)}</code> ${esc(c.detail)}</li>`)
        .join('');
      // Modules other than the built in one report zero snapshots, so the counts are left out then.
      const { ledger_reads, stock_reads, order_reads } = report.snapshots;
      const snapshots =
        ledger_reads === 0 && stock_reads === 0 && order_reads === 0
          ? ''
          : `, ${ledger_reads} ledger reads, ${stock_reads} stock reads, ${order_reads} order reads`;
      return `<h3>${esc(report.system)}: ${esc(invariantSummary(report))}</h3><p class="muted">${esc(report.recording)}: ${report.exchanges} exchanges, ${report.commands} commands${snapshots}.</p>${
        conds.length === 0 ? '' : `<ul class="conditions">${conds}</ul>`
      }<table><thead><tr><th class="num">#</th><th>Invariant</th><th>Status</th><th class="num">Checks</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  return `<section id="invariants"><h2>Invariants</h2><p class="muted">Each system is checked against its own recording. Agreement between the two systems is not evidence of correctness, so this section comes before the diff.</p>${blocks}</section>`;
}

function latencyRow(tag: string, s: TagStats): string {
  const pair = (a: number, b: number): string => `${fmtMs(a)} / ${fmtMs(b)}`;
  return `<tr><td>${esc(tag)}</td><td class="num">${s.count}</td><td class="num">${s.errors}</td><td class="num">${pair(s.reference.p50_ms, s.candidate.p50_ms)}</td><td class="num">${pair(s.reference.p90_ms, s.candidate.p90_ms)}</td><td class="num">${pair(s.reference.p99_ms, s.candidate.p99_ms)}</td><td class="num">${pair(s.reference.p999_ms, s.candidate.p999_ms)}</td><td class="num">${pair(s.reference.max_ms, s.candidate.max_ms)}</td><td class="num">${pair(s.reference.mean_ms, s.candidate.mean_ms)}</td></tr>`;
}

function latency(run: Run): string {
  const tags = Object.keys(run.stats.by_tag).sort();
  const rows = [
    latencyRow('overall', run.stats.overall),
    ...tags.map((t) => latencyRow(t, run.stats.by_tag[t] as TagStats)),
  ].join('');
  const chart = (name: string, s: TagStats): string =>
    `<figure data-tag="${esc(name)}">${renderHistogram({
      edges: run.stats.histogram_edges_ms,
      reference: s.histogram.reference,
      candidate: s.histogram.candidate,
      title: `${name} (${s.candidate.count} candidate, ${s.reference.count} reference)`,
    })}</figure>`;
  const charts = [
    chart('overall', run.stats.overall),
    ...tags.map((t) => chart(t, run.stats.by_tag[t] as TagStats)),
  ].join('');
  return `<section id="latency"><h2>Latency</h2><p class="muted">Reference values come from the recording, candidate values from this replay. Percentiles in milliseconds, reference / candidate.</p><table><thead><tr><th>Tag</th><th class="num">Count</th><th class="num">Errors</th><th class="num">p50</th><th class="num">p90</th><th class="num">p99</th><th class="num">p999</th><th class="num">max</th><th class="num">mean</th></tr></thead><tbody>${rows}</tbody></table><p id="pacing" class="muted">Pacing: ${esc(pacingLine(run))}.</p><p class="legend"><span style="background:${SVG_REFERENCE_COLOR}"></span>reference <span style="background:${SVG_CANDIDATE_COLOR}"></span>candidate. Log spaced bins from ${fmtNumber(run.stats.histogram_edges_ms[0] ?? 0)} ms to ${fmtNumber(run.stats.histogram_edges_ms[run.stats.histogram_edges_ms.length - 1] ?? 0)} ms.</p><div class="charts">${charts}</div></section>`;
}

/** The most errored exchanges the errors table lists. */
const ERRORS_CAP = 50;

/** One invariant evidence entry that names an exchange, with the system and rule it came from. */
interface NamedEvidence {
  system: string;
  rule: string;
  subject: string;
  expected: JsonValue | undefined;
  observed: JsonValue | undefined;
  detail: string;
}

/** The evidence entries of both invariant reports, by the exchange each one names. */
function evidenceByExchange(run: Run): Map<string, NamedEvidence[]> {
  const out = new Map<string, NamedEvidence[]>();
  for (const report of [run.invariants.reference, run.invariants.candidate]) {
    if (report === null) continue;
    for (const result of report.results) {
      for (const e of result.evidence) {
        if (e.exchange_id === null) continue;
        const list = out.get(e.exchange_id) ?? [];
        list.push({
          system: report.system,
          rule: result.name,
          subject: e.subject,
          expected: e.expected,
          observed: e.observed,
          detail: e.detail,
        });
        out.set(e.exchange_id, list);
      }
    }
  }
  return out;
}

function drillDown(e: ExchangeResult, evidence: ReadonlyMap<string, NamedEvidence[]>): string {
  const findings = (e.diff?.findings ?? [])
    .map(
      (f) =>
        `<tr class="${f.tolerated ? 'tolerated' : 'untolerated'}"><td><code>${esc(f.path)}</code></td><td>${esc(f.kind)}</td><td>${json(f.reference)}</td><td>${json(f.candidate)}</td><td>${f.tolerated ? `tolerated by <code>${esc(f.rule ?? '')}</code>` : esc(f.detail ?? '')}</td></tr>`,
    )
    .join('');
  const entries = evidence.get(e.id) ?? [];
  const named =
    entries.length === 0
      ? ''
      : `<p class="muted">Invariant evidence naming this exchange:</p><ul class="evidence">${entries
          .map(
            (n) =>
              `<li>${esc(n.system)} <code>${esc(n.rule)}</code>, ${esc(n.subject)}: expected ${json(n.expected)}, observed ${json(n.observed)}. ${esc(n.detail)}</li>`,
          )
          .join('')}</ul>`;
  return `<details class="exchange" data-id="${esc(e.id)}"><summary id="${esc(exchangeAnchor(e.id))}">${esc(e.method)} ${esc(e.path)} <span class="muted">[${esc(e.tags.join(', '))}] ${esc(e.id)}</span> status ${e.reference.status} / ${e.candidate?.status ?? 'error'}, latency ${fmtMs(e.reference.latency_ms)} / ${fmtMs(e.candidate?.latency_ms)} ms</summary><table><thead><tr><th>Path</th><th>Kind</th><th>Reference</th><th>Candidate</th><th>Rule or detail</th></tr></thead><tbody>${findings}</tbody></table>${named}</details>`;
}

function correctness(run: Run): string {
  const tags = Object.keys(run.stats.by_tag).sort();
  const row = (name: string, s: TagStats): string =>
    `<tr><td>${esc(name)}</td><td class="num">${s.compared}</td><td class="num">${s.matches}</td><td class="num">${s.tolerated}</td><td class="num">${s.mismatches}</td><td class="num">${fmtPercent(s.mismatch_rate)}</td><td class="num">${s.errors}</td></tr>`;
  const rows = [
    row('overall', run.stats.overall),
    ...tags.map((t) => row(t, run.stats.by_tag[t] as TagStats)),
  ].join('');
  const top = topMismatchPaths(run);
  const topHtml =
    top.length === 0
      ? '<p class="muted">No untolerated differences.</p>'
      : `<p class="muted">Array positions are folded into <code>[*]</code>, so rows that moved count as one path.</p><table><thead><tr><th>Path</th><th class="num">Findings</th><th class="num">Exchanges</th></tr></thead><tbody>${top
          .map(
            (t) =>
              `<tr><td><code>${esc(t.path)}</code></td><td class="num">${t.count}</td><td class="num">${t.exchanges}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  const plan = planDrillDown(run);
  const evidence = evidenceByExchange(run);
  const leftOut = plan.total - plan.shown;
  const capNote =
    leftOut === 0
      ? ''
      : `<p class="muted">Showing ${plan.shown} of ${plan.total}, taken round robin across the paths below so every path is represented. The ${leftOut} left out are in the run file.</p>`;
  const groups = plan.groups
    .map(
      (g) =>
        `<h4 data-path="${esc(g.path)}"><code>${esc(g.path)}</code> <span class="muted">showing ${g.shown.length} of ${g.exchanges.length}</span></h4>${g.shown.map((e) => drillDown(e, evidence)).join('')}`,
    )
    .join('');
  const errors = run.exchanges.filter((e) => e.error !== null);
  const errorNote =
    errors.length <= ERRORS_CAP
      ? ''
      : `<p class="muted">Showing ${ERRORS_CAP} of ${errors.length}. The rest are in the run file.</p>`;
  const errorHtml =
    errors.length === 0
      ? ''
      : `<h3>Errors (${errors.length})</h3>${errorNote}<table><thead><tr><th>Exchange</th><th>Request</th><th>Error</th></tr></thead><tbody>${errors
          .slice(0, ERRORS_CAP)
          .map(
            (e) =>
              `<tr><td><code>${esc(e.id)}</code></td><td>${esc(e.method)} ${esc(e.path)}</td><td>${esc(e.error ?? '')}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `<section id="correctness"><h2>Correctness</h2><h3>By tag</h3><table><thead><tr><th>Tag</th><th class="num">Compared</th><th class="num">Match</th><th class="num">Tolerated</th><th class="num">Mismatch</th><th class="num">Rate</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table><h3>Top mismatching paths</h3>${topHtml}<h3>Mismatched exchanges (${plan.total})</h3>${
    plan.total === 0 ? '<p class="muted">None.</p>' : `${capNote}${groups}`
  }${errorHtml}</section>`;
}

function controls(run: Run): string {
  const list = controlExchanges(run);
  if (list.length === 0) return '';
  const rows = list
    .map(
      (c) =>
        `<tr data-id="${esc(c.id)}"><td class="num">${run.exchanges.indexOf(c) + 1}</td><td>${esc(c.method)} ${esc(c.path)}</td><td>${esc(c.tags.join(', '))}</td><td class="num">${c.reference.status} / ${c.candidate?.status ?? 'error'}</td><td>${esc(c.diff?.verdict ?? c.error ?? '')}</td><td class="num">${fmtMs(c.sent_at_ms)}</td></tr>`,
    )
    .join('');
  return `<section id="controls"><h2>Harness controls</h2><p class="muted">Replayed in order as barriers, diffed on status only, and not scored. They are shown so the sequence is visible.</p><table><thead><tr><th class="num">Position</th><th>Request</th><th>Tags</th><th class="num">Status ref / cand</th><th>Result</th><th class="num">Sent at (ms)</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function reproduction(run: Run): string {
  const r = run.reproduction;
  if (r === null) return '';
  const rows = r.steps
    .map(
      (s, i) =>
        `<tr><td class="num">${i + 1}</td><td>${esc(s.method)} ${esc(s.path)}</td><td>${esc(s.tags.join(', '))}</td><td>${json(s.body)}</td><td>${s.quantity_reduced ? 'quantity reduced' : ''}</td></tr>`,
    )
    .join('');
  return `<section id="reproduction"><h2>Reproduction</h2><p><strong>${esc(r.label)}</strong> for rule <code>${esc(r.rule)}</code>: ${r.original_steps} recorded steps reduced to ${r.reduced_steps} in ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} (${esc(fmtDuration(r.duration_ms))})${
    r.recording === null ? '' : `, written to <code>${esc(r.recording)}</code>`
  }.</p><table><thead><tr><th class="num">#</th><th>Request</th><th>Tags</th><th>Body</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function agent(run: Run): string {
  const a = run.agent;
  if (a === undefined) return '';
  const rows = a.cases
    .map(
      (c) =>
        `<tr><td><code>${esc(c.id)}</code></td><td class="num">${c.round}</td><td>${esc(c.hypothesis)}</td><td>${esc(c.tags.join(', '))}</td><td>${c.steps.map((s) => `${esc(s.request.method)} ${esc(s.request.path)}`).join('<br>')}${c.repeat > 1 ? `<br><span class="muted">${c.repeat} runs on each system</span>` : ''}</td><td>${c.reference?.status ?? 'error'} / ${c.candidate?.status ?? 'error'}</td><td>${esc(c.revealed)}</td></tr>`,
    )
    .join('');
  return `<section id="agent"><h2>Agent</h2><p>${esc(a.model)}: ${a.rounds} of ${a.max_rounds} rounds, ${a.proposed} cases proposed, ${a.valid} valid, ${a.executed} executed, ${a.kept} kept. Stopped on <code>${esc(a.stop_reason)}</code>. Cost $${a.cost_usd.toFixed(2)} of a $${a.budget_usd.toFixed(2)} budget (${a.input_tokens} input tokens, ${a.output_tokens} output tokens, ${a.cache_read_tokens} read from cache).</p><p class="muted">Prompts: ${Object.entries(
    a.prompt_versions,
  )
    .map(([k, v]) => `${esc(k)} ${esc(v)}`)
    .join(', ')}. Transcript ${esc(a.transcript_path)}, cases ${esc(a.cases_path)}.</p>${
    a.cases.length === 0
      ? '<p class="muted">No case was kept.</p>'
      : `<table><thead><tr><th>Case</th><th class="num">Round</th><th>Hypothesis</th><th>Tags</th><th>Steps</th><th>Status ref / cand</th><th>Revealed</th></tr></thead><tbody>${rows}</tbody></table>`
  }</section>`;
}

export function renderHtml(run: Run): string {
  const verdict = verdictLabel(run);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>replay-parity ${esc(verdict)} ${esc(run.run_id)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="run"><h1>replay-parity</h1><span class="badge ${esc(run.verdict)}">${esc(verdict)}</span></header>
<dl class="meta">${metaRows(run)}</dl>
${conditions(run)}
${thresholds(run)}
${invariants(run)}
${latency(run)}
${correctness(run)}
${controls(run)}
${reproduction(run)}
${agent(run)}
<footer>Rendered from run.json, schema version ${run.schema_version}. No script, no external resource.</footer>
</main>
</body>
</html>
`;
}
