import {
  compileRunValidator,
  evaluateThresholds,
  makeRun,
  parseThresholds,
  type Run,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { renderHtml, renderJunit, renderMarkdown, renderTerminal } from './index.js';

/** The threshold sections and conditions added for baselines, noise, and budgets. */

function gatedRun(): Run {
  const base = makeRun();
  const thresholds = parseThresholds(
    [
      'latency:',
      '  by_tag:',
      '    create-item: { p99_ms: 100, min_samples: 2 }',
      '  relative_to_reference:',
      '    by_tag:',
      '      get-items: { p50_ratio_max: 2 }',
      'correctness:',
      '  mismatch_rate_max: 1',
      '  noise_rate_max: 1',
      'errors:',
      '  by_tag:',
      '    get-items: { rate_max: 0.5 }',
      'throughput: { achieved_rps_min: 5 }',
      'status:',
      '  by_tag:',
      "    get-items: { '500': { rate_max: 0 } }",
      'baseline:',
      '  latency:',
      '    by_tag:',
      '      get-items: { p99_ratio_max: 2 }',
      '  correctness: { mismatch_rate_delta_max: 0 }',
      'inconclusive: { max_rows: 1 }',
      '',
    ].join('\n'),
  );
  const getItems = base.stats.by_tag['get-items'];
  if (getItems === undefined) throw new Error('the builder run has no get-items tag');
  const stats: Run['stats'] = {
    ...base.stats,
    by_tag: { ...base.stats.by_tag, 'get-items': { ...getItems, candidate_status: { '200': 1 } } },
    noise_findings: { overall: 1, by_tag: { 'create-item': 1 } },
  };
  const evaluation = evaluateThresholds(thresholds, stats, {
    slip_max_ms: 3,
    achieved_rps: 10,
    baseline: base.stats,
  });
  return makeRun({
    thresholds,
    stats,
    threshold_results: evaluation.results,
    inconclusive: evaluation.inconclusive,
    verdict: evaluation.verdict,
    baseline: { path: 'nightly/run.json', run_id: 'previous-night', recording_sha256: null },
  });
}

describe('reports of a run with baselines, noise, and a tolerated row', () => {
  const run = gatedRun();

  it('builds a valid run that passes on the budget', async () => {
    const validate = await compileRunValidator();
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(run.verdict).toBe('pass');
    expect(run.inconclusive).toEqual([
      {
        kind: 'insufficient_samples',
        detail: 'latency.by_tag.create-item.p99_ms: 1 successful sample, minimum 2',
        tolerated: true,
      },
    ]);
    expect(run.threshold_results.map((r) => [r.section, r.id])).toEqual([
      ['latency', 'latency.by_tag.create-item.p99_ms'],
      ['latency', 'latency.relative_to_reference.by_tag.get-items.p50_ratio_max'],
      ['correctness', 'correctness.mismatch_rate_max'],
      ['correctness', 'correctness.noise_rate_max'],
      ['errors', 'errors.by_tag.get-items.rate_max'],
      ['throughput', 'throughput.achieved_rps_min'],
      ['status', 'status.by_tag.get-items.500.rate_max'],
      ['baseline', 'baseline.latency.by_tag.get-items.p99_ratio_max'],
      ['baseline', 'baseline.correctness.mismatch_rate_delta_max'],
    ]);
  });

  it('puts every new row in the HTML threshold table and lists the tolerated row apart', () => {
    const html = renderHtml(run);
    for (const row of run.threshold_results) {
      expect(html).toContain(`data-id="${row.id}"`);
    }
    expect(html).toContain('<td>throughput</td>');
    expect(html).toContain('<td>status</td>');
    expect(html).toContain('<td>baseline</td>');
    expect(html).toContain(
      '<tr class="inconclusive" data-id="latency.by_tag.create-item.p99_ms"><td class="outcome">inconclusive (tolerated)</td>',
    );
    expect(html).toContain(
      '<div class="conditions tolerated"><strong>Tolerated by the inconclusive budget of 1 row</strong><ul><li><code>insufficient_samples</code> latency.by_tag.create-item.p99_ms: 1 successful sample, minimum 2</li></ul></div>',
    );
    expect(html).not.toContain('Inconclusive because');
    expect(html).toContain(
      '<dt>Baseline</dt><dd>run previous-night from nightly/run.json, no recording hash</dd>',
    );
    expect(html).toContain('1 noise finding excluded');
  });

  it('renders the Markdown summary', () => {
    const md = renderMarkdown(run);
    expect(md).toContain('- Baseline: run previous-night from nightly/run.json, no recording hash');
    expect(md).toContain('**Tolerated by the inconclusive budget of 1 row**');
    expect(md).toContain('| inconclusive (tolerated) | `latency.by_tag.create-item.p99_ms` |');
    expect(md).not.toContain('Inconclusive because');
    expect(md).toMatchSnapshot();
  });

  it('renders the terminal summary', () => {
    const text = renderTerminal(run);
    expect(text).toContain('baseline run previous-night from nightly/run.json, no recording hash');
    expect(text).toContain('tolerated by the inconclusive budget of 1 row:');
    expect(text).not.toContain('inconclusive because');
    expect(text).toMatchSnapshot();
  });

  it('gives the new sections their own JUnit suites', () => {
    const xml = renderJunit(run);
    for (const section of ['throughput', 'status', 'baseline']) {
      expect(xml).toContain(`<testsuite name="${section}" `);
    }
    expect(xml).toContain(
      '<skipped message="tolerated by the inconclusive budget: 1 successful sample, minimum 2"/>',
    );
    expect(xml).toContain(
      '<property name="baseline" value="run previous-night from nightly/run.json, no recording hash"/>',
    );
    // A passing run has no skipped verdict case.
    expect(xml).toContain('<testcase classname="run" name="verdict" time="0.3"/>');
    expect(xml).toMatchSnapshot();
  });

  it('keeps open conditions apart from tolerated ones', () => {
    const open = {
      ...run,
      verdict: 'inconclusive' as const,
      inconclusive: [
        ...run.inconclusive,
        { kind: 'barrier_timeout' as const, detail: 'barrier list-ledger waited 10 s' },
      ],
    };
    const html = renderHtml(open);
    expect(html).toContain(
      '<div class="conditions"><strong>Inconclusive because</strong><ul><li><code>barrier_timeout</code> barrier list-ledger waited 10 s</li></ul></div>',
    );
    expect(renderMarkdown(open)).toContain(
      '**Inconclusive because**\n\n- `barrier_timeout`: barrier list-ledger waited 10 s',
    );
    expect(renderTerminal(open)).toContain(
      'inconclusive because:\n  - barrier_timeout: barrier list-ledger waited 10 s\ntolerated by',
    );
  });
});
