import {
  HISTOGRAM_EDGES_MS,
  compileRunValidator,
  makeExchangeResult,
  makeRun,
  parseRun,
  parseThresholds,
  type AgentReport,
  type InvariantReport,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DRILL_DOWN_CAP,
  DRILL_DOWN_NO_PATH,
  escapeXml,
  fmtNumber,
  planDrillDown,
  renderHistogram,
  renderHtml,
  renderJson,
  renderJunit,
  renderMarkdown,
  renderTerminal,
  topMismatchPaths,
} from './index.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

const thresholds = parseThresholds(
  'latency:\n  overall: { p99_ms: 100 }\n  by_tag:\n    get-items: { p50_ms: 5 }\ncorrectness:\n  mismatch_rate_max: 0\nerrors:\n  rate_max: 0.5\npacing:\n  slip_max_ms: 250\n',
);

const candidateReport: InvariantReport = {
  system: 'candidate',
  recording: 'candidate.jsonl',
  exchanges: 3,
  commands: 2,
  snapshots: { ledger_reads: 1, stock_reads: 1, order_reads: 1 },
  results: [
    {
      id: 1,
      name: 'shipment-applied-once',
      statement: 'An accepted shipment event changes stock on hand exactly once.',
      status: 'violated',
      checks: 2,
      evidence: [
        {
          subject: 'order o-7',
          expected: 2,
          observed: 4,
          detail: 'shp-3 delivered 2 times',
          exchange_id: 'x-1',
        },
      ],
    },
    {
      id: 2,
      name: 'shipped-within-quantity',
      statement: 'Shipped quantity never exceeds the effective total quantity.',
      status: 'holds',
      checks: 3,
      evidence: [],
    },
    {
      id: 10,
      name: 'allocation-deterministic',
      statement: 'Allocation decisions are deterministic.',
      status: 'inconclusive',
      checks: 1,
      evidence: [],
      detail: 'no stock read fixes a baseline',
    },
  ],
  violations: 1,
  inconclusive: [],
};

const agent: AgentReport = {
  model: 'claude-sonnet-5-5',
  rounds: 1,
  max_rounds: 2,
  budget_usd: 2,
  cost_usd: 0.3,
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  proposed: 4,
  valid: 4,
  executed: 4,
  kept: 1,
  stop_reason: 'max_rounds',
  prompt_versions: { 'system.md': 'v1' },
  transcript_path: 'agent-transcript.json',
  cases_path: 'generated-cases.jsonl',
  cases: [
    {
      id: 'case-1',
      round: 1,
      hypothesis: 'odd quantities round differently',
      tags: ['create-item'],
      steps: [{ request: { method: 'POST', path: '/v1/items', query: {}, headers: {} } }],
      repeat: 1,
      dedupe_key: 'mismatch:$.total',
      reference: { status: 201, latency_ms: 2 },
      candidate: { status: 201, latency_ms: 3 },
      latency: {
        reference: { count: 1, p50_ms: 2, p90_ms: 2, p99_ms: 2, p999_ms: 2, max_ms: 2, mean_ms: 2 },
        candidate: { count: 1, p50_ms: 3, p90_ms: 3, p99_ms: 3, p999_ms: 3, max_ms: 3, mean_ms: 3 },
      },
      error: null,
      diff: { verdict: 'mismatch', findings: [] },
      latency_breach: null,
      revealed: '$.total differs by half a cent',
    },
  ],
};

/** A run whose mismatched exchanges spread over three paths, one of them an array position. */
function manyMismatches(count: number): Run {
  const paths = ['$.a', '$.items[%].name', '$.c'];
  return makeRun({
    exchanges: Array.from({ length: count }, (_, i) =>
      makeExchangeResult({
        id: `x-${i}`,
        diff: {
          verdict: 'mismatch',
          findings: [
            {
              path: (paths[i % 3] as string).replace('%', String(i)),
              kind: 'value',
              tolerated: false,
              reference: 1,
              candidate: 2,
            },
          ],
        },
      }),
    ),
  });
}

function passingRun(): Run {
  const run = makeRun({
    thresholds: parseThresholds('latency:\n  overall: { p99_ms: 100 }\nerrors:\n  rate_max: 0.5\n'),
  });
  expect(run.verdict).toBe('pass');
  return run;
}

function inconclusiveRun(): Run {
  const base = fullRun();
  return {
    ...base,
    verdict: 'inconclusive',
    inconclusive: [
      { kind: 'barrier_timeout', detail: 'list-ledger waited 10000 ms' },
      { kind: 'insufficient_samples', detail: 'get-items: 2 successful samples, minimum 20' },
    ],
    threshold_results: base.threshold_results.map((r) =>
      r.id === 'latency.by_tag.get-items.p50_ms'
        ? {
            ...r,
            measured: null,
            outcome: 'inconclusive' as const,
            detail: '2 successful samples, minimum 20',
          }
        : r,
    ),
  };
}

function fullRun(): Run {
  const base = makeRun({ thresholds });
  return makeRun({
    thresholds,
    exchanges: [
      ...base.exchanges,
      makeExchangeResult({
        id: 'ctrl-1',
        tags: ['admin-restart'],
        method: 'POST',
        path: '/admin/restart',
        control: true,
        scheduled_at_ms: 250,
        sent_at_ms: 251,
        acked_at_ms: 253,
      }),
    ],
    candidate_recording: 'candidate.jsonl',
    invariants: {
      reference: {
        ...candidateReport,
        system: 'reference',
        violations: 0,
        results: candidateReport.results.map((r) => ({ ...r, status: 'holds', evidence: [] })),
      },
      candidate: candidateReport,
    },
    reproduction: {
      rule: 'invariant:candidate:shipment-applied-once',
      original_steps: 283,
      reduced_steps: 4,
      attempts: 13,
      successful: true,
      label: 'reduced reproduction',
      duration_ms: 34,
      recording: 'reduced-reproduction.jsonl',
      steps: [
        {
          id: 'a',
          method: 'POST',
          path: '/v1/orders',
          tags: ['create-order'],
          body: { sku: 'H-800', qty: 2 },
          quantity_reduced: true,
        },
        {
          id: 'b',
          method: 'GET',
          path: '/v1/orders/o-12',
          tags: ['get-order'],
          quantity_reduced: false,
        },
      ],
    },
    agent,
  });
}

describe('renderTerminal', () => {
  it('names the verdict, every threshold row, the per tag table, and the pacing line', () => {
    const run = makeRun({ thresholds });
    const text = renderTerminal(run);
    expect(text).toContain(`replay-parity run ${run.run_id}: FAIL`);
    for (const row of run.threshold_results) {
      expect(text).toContain(row.id);
      expect(text).toContain(`measured ${row.measured === null ? 'n/a' : fmtNumber(row.measured)}`);
    }
    expect(text).toMatch(/^\s+get-items\s+2\s+1\s+/m);
    expect(text).toMatch(/^\s+create-item\s+1\s+0\s+/m);
    expect(text).toContain('schedule slip p50 1.00 ms, max 3.00 ms');
    expect(text).toContain('top mismatching paths: $.total x1');
    expect(text).toMatchSnapshot();
  });

  it('renders the inconclusive conditions, invariants, controls, reproduction, and agent', () => {
    const run = {
      ...fullRun(),
      verdict: 'inconclusive' as const,
      inconclusive: [{ kind: 'barrier_timeout' as const, detail: 'list-ledger waited 10000 ms' }],
    };
    const text = renderTerminal(run);
    expect(text).toContain(': INCONCLUSIVE');
    expect(text).toContain('- barrier_timeout: list-ledger waited 10000 ms');
    expect(text).toContain('candidate: 1 hold, 1 violated, 1 inconclusive');
    expect(text).toContain('1. shipment-applied-once VIOLATED (2 checks)');
    expect(text).toContain('order o-7: expected 2, observed 4. shp-3 delivered 2 times');
    expect(text).toContain('controls (replayed in order, not scored): 1');
    expect(text).toContain(
      'reproduction: reduced reproduction, rule invariant:candidate:shipment-applied-once, 283 -> 4 steps in 13 attempts',
    );
    expect(text).toContain('(quantity reduced)');
    expect(text).toContain('agent: claude-sonnet-5-5, 1/2 rounds, 4 proposed');
    expect(text).toContain('case-1 [create-item] $.total differs by half a cent');
    expect(text).not.toContain('minimal');
  });
});

describe('renderHtml', () => {
  it('is one offline file with the header fields, one chart per tag, every threshold row, and the drill down', () => {
    const run = makeRun({ thresholds });
    const html = renderHtml(run);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/\s(src|href)=["']https?:/);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).toContain(`<span class="badge fail">FAIL</span>`);
    expect(html).toContain(run.run_id);
    expect(html).toContain(run.recording.path);
    expect(html).toContain(run.target);
    expect(html).toContain('schedule slip p50 1.00 ms, max 3.00 ms');
    const tags = Object.keys(run.stats.by_tag);
    expect(html.match(/<svg /g)).toHaveLength(tags.length + 1);
    for (const tag of tags) expect(html).toContain(`<figure data-tag="${tag}">`);
    for (const row of run.threshold_results) expect(html).toContain(`data-id="${row.id}"`);
    const mismatched = run.exchanges.filter((e) => e.diff?.verdict === 'mismatch');
    expect(mismatched.length).toBeGreaterThan(0);
    for (const e of mismatched)
      expect(html).toContain(`<details class="exchange" data-id="${e.id}">`);
    expect(html).toContain(
      '<td><code>$.total</code></td><td>value</td><td><code>12.38</code></td><td><code>12.37</code></td>',
    );
    expect(html).not.toContain('id="agent"');
    expect(html).not.toContain('id="invariants"');
    expect(html).not.toContain('id="reproduction"');
    expect(html).not.toContain('id="controls"');
    expect(html).toContain('Errors (1)');
    expect(html).toContain('connect ECONNREFUSED');
  });

  it('renders the invariants above the diff, the controls, the reproduction, and the agent when present', () => {
    const html = renderHtml(fullRun());
    expect(html.indexOf('id="invariants"')).toBeLessThan(html.indexOf('id="correctness"'));
    expect(html).toContain('candidate: 1 hold, 1 violated, 1 inconclusive');
    expect(html).toContain('<code>shipment-applied-once</code>');
    expect(html).toContain(
      'order o-7: expected <code>2</code>, observed <code>4</code>. shp-3 delivered 2 times',
    );
    expect(html).toContain('id="controls"');
    expect(html).toContain('<tr data-id="ctrl-1">');
    expect(html).toContain('not scored');
    expect(html).toContain('id="reproduction"');
    expect(html).toContain('<strong>reduced reproduction</strong>');
    expect(html).toContain('283 recorded steps reduced to 4 in 13 attempts');
    expect(html).toContain('quantity reduced');
    expect(html).toContain('id="agent"');
    expect(html).toContain('odd quantities round differently');
    expect(html).toContain('Candidate recording');
    expect(html).not.toContain('minimal');
  });

  it('names the inconclusive conditions in the header', () => {
    const run = {
      ...makeRun(),
      verdict: 'inconclusive' as const,
      inconclusive: [
        { kind: 'schedule_not_held' as const, detail: 'slip of 312 ms exceeds 250 ms' },
      ],
    };
    const html = renderHtml(run);
    expect(html).toContain('<span class="badge inconclusive">INCONCLUSIVE</span>');
    expect(html).toContain('<strong>Inconclusive because</strong>');
    expect(html).toContain('<code>schedule_not_held</code> slip of 312 ms exceeds 250 ms');
  });

  it('escapes recorded strings', () => {
    const hostile = '<script>alert(1)</script>';
    const run = makeRun({
      target: `http://cand/${hostile}`,
      exchanges: [
        makeExchangeResult({
          path: `/v1/items/${hostile}`,
          tags: ['a"b'],
          diff: {
            verdict: 'mismatch',
            findings: [
              {
                path: '$.name',
                kind: 'value',
                tolerated: false,
                reference: hostile,
                candidate: "it's & <b>",
              },
            ],
          },
        }),
      ],
    });
    const html = renderHtml(run);
    expect(html).not.toContain(hostile);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a&quot;b');
    expect(html).toContain('it&#39;s &amp; &lt;b&gt;');
    expect(renderTerminal(run)).toContain(hostile);
  });
});

describe('planDrillDown', () => {
  it('groups by the first untolerated path and takes exchanges round robin up to the cap', () => {
    const plan = planDrillDown(manyMismatches(500));
    expect(plan.total).toBe(500);
    expect(plan.shown).toBe(DRILL_DOWN_CAP);
    expect(plan.groups.map((g) => [g.path, g.exchanges.length, g.shown.length])).toEqual([
      ['$.a', 167, 67],
      ['$.items[*].name', 167, 67],
      ['$.c', 166, 66],
    ]);
    for (const g of plan.groups) {
      expect(g.shown).toEqual(g.exchanges.slice(0, g.shown.length));
    }
    expect(plan.groups[0]?.shown.slice(0, 3).map((e) => e.id)).toEqual(['x-0', 'x-3', 'x-6']);
    expect(plan.groups[1]?.shown.slice(0, 2).map((e) => e.id)).toEqual(['x-1', 'x-4']);
    const all = planDrillDown(manyMismatches(500), 1000);
    expect(all.shown).toBe(500);
    expect(all.groups.every((g) => g.shown.length === g.exchanges.length)).toBe(true);
    const none = planDrillDown(manyMismatches(5), 0);
    expect(none.shown).toBe(0);
    expect(none.groups.every((g) => g.shown.length === 0)).toBe(true);
  });

  it('orders the groups like the top paths, puts exchanges without an untolerated finding last, and skips controls', () => {
    const finding = (path: string, tolerated = false) => ({
      path,
      kind: 'value' as const,
      tolerated,
      reference: 'a',
      candidate: 'b',
    });
    const run = makeRun({
      exchanges: [
        makeExchangeResult({
          id: 'only-tolerated',
          diff: { verdict: 'mismatch', findings: [finding('$.x', true)] },
        }),
        makeExchangeResult({
          id: 'rare',
          diff: { verdict: 'mismatch', findings: [finding('$.rare')] },
        }),
        makeExchangeResult({
          id: 'common-1',
          diff: { verdict: 'mismatch', findings: [finding('$.common'), finding('$.rare')] },
        }),
        makeExchangeResult({
          id: 'common-2',
          diff: { verdict: 'mismatch', findings: [finding('$.common')] },
        }),
        makeExchangeResult({
          id: 'ctrl',
          control: true,
          diff: { verdict: 'mismatch', findings: [finding('$.common')] },
        }),
        makeExchangeResult({ id: 'ok', diff: { verdict: 'match', findings: [] } }),
      ],
    });
    const plan = planDrillDown(run);
    expect(plan.groups.map((g) => [g.path, g.exchanges.map((e) => e.id)])).toEqual([
      ['$.common', ['common-1', 'common-2']],
      ['$.rare', ['rare']],
      [DRILL_DOWN_NO_PATH, ['only-tolerated']],
    ]);
    expect(plan.total).toBe(4);
    expect(planDrillDown(makeRun({ exchanges: [] }))).toEqual({ groups: [], total: 0, shown: 0 });
  });
});

describe('renderHtml drill down cap', () => {
  it('shows at most 200 mismatched exchanges, represents every path, and says what was left out', () => {
    const html = renderHtml(manyMismatches(500));
    expect(html.match(/<details class="exchange"/g)).toHaveLength(200);
    expect(html).toContain('<h3>Mismatched exchanges (500)</h3>');
    expect(html).toContain(
      '<h4 data-path="$.a"><code>$.a</code> <span class="muted">showing 67 of 167</span></h4>',
    );
    expect(html).toContain(
      '<h4 data-path="$.items[*].name"><code>$.items[*].name</code> <span class="muted">showing 67 of 167</span></h4>',
    );
    expect(html).toContain(
      '<h4 data-path="$.c"><code>$.c</code> <span class="muted">showing 66 of 166</span></h4>',
    );
    expect(html).toContain('Showing 200 of 500, taken round robin across the paths below');
    expect(html).toContain('The 300 left out are in the run file.');
    expect(html).toContain('<details class="exchange" data-id="x-0">');
    expect(html).toContain('<details class="exchange" data-id="x-1">');
    expect(html).toContain('<details class="exchange" data-id="x-2">');
    expect(html).not.toContain('<details class="exchange" data-id="x-499">');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\s(src|href)=["']https?:/);
  });

  it('groups a small run under its path with nothing left out', () => {
    const html = renderHtml(makeRun());
    expect(html).toContain(
      '<h4 data-path="$.total"><code>$.total</code> <span class="muted">showing 1 of 1</span></h4>',
    );
    expect(html).not.toContain('left out are in the run file');
    expect(html).toContain('<h3>Mismatched exchanges (1)</h3>');
    expect(renderHtml(makeRun({ exchanges: [] }))).toContain(
      '<h3>Mismatched exchanges (0)</h3><p class="muted">None.</p>',
    );
  });

  it('lists at most 50 errors and says so', () => {
    const run = makeRun({
      exchanges: Array.from({ length: 60 }, (_, i) =>
        makeExchangeResult({
          id: `err-${i}`,
          acked_at_ms: null,
          candidate: null,
          error: `timeout: request ${i} timed out`,
          diff: null,
        }),
      ),
    });
    const html = renderHtml(run);
    expect(html).toContain('<h3>Errors (60)</h3>');
    expect(html).toContain('<p class="muted">Showing 50 of 60. The rest are in the run file.</p>');
    expect(html.match(/<td><code>err-\d+<\/code><\/td>/g)).toHaveLength(50);
    expect(html).toContain('err-49');
    expect(html).not.toContain('err-50');
    expect(renderHtml(makeRun())).not.toContain('The rest are in the run file');
  });
});

describe('renderJunit', () => {
  it('fails the failed rows, the violated rules, and the verdict on a failing run', () => {
    const run = fullRun();
    const xml = renderJunit(run);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(xml.endsWith('</testsuites>\n')).toBe(true);
    expect(xml).toContain(
      '<testsuite name="latency" tests="2" failures="1" errors="0" skipped="0" time="0" timestamp="2026-10-16T18:22:03.123Z">',
    );
    expect(xml).toContain('<testcase classname="latency" name="latency.overall.p99_ms" time="0"/>');
    expect(xml).toContain(
      '<testcase classname="latency" name="latency.by_tag.get-items.p50_ms" time="0">\n      <failure message="measured 12.007, limit 5" type="latency">latency.by_tag.get-items.p50_ms: p50_ms on get-items measured 12.007, limit 5</failure>',
    );
    expect(xml).toContain('<testsuite name="correctness" tests="1" failures="1"');
    expect(xml).toContain('<testsuite name="errors" tests="1" failures="0"');
    expect(xml).toContain('<testsuite name="pacing" tests="1" failures="0"');
    expect(xml).toContain(
      '<testsuite name="invariants.reference" tests="3" failures="0" errors="0" skipped="0"',
    );
    expect(xml).toContain(
      '<testsuite name="invariants.candidate" tests="3" failures="1" errors="0" skipped="1"',
    );
    expect(xml).toContain(
      '<testcase classname="invariants.candidate" name="shipment-applied-once" time="0">\n      <failure message="order o-7: expected 2, observed 4. shp-3 delivered 2 times (exchange x-1)" type="invariants.candidate">1. shipment-applied-once violated after 2 checks\nAn accepted shipment event changes stock on hand exactly once.\norder o-7: expected 2, observed 4. shp-3 delivered 2 times (exchange x-1)</failure>',
    );
    expect(xml).toContain(
      '<testcase classname="invariants.candidate" name="shipped-within-quantity" time="0"/>',
    );
    expect(xml).toContain(
      '<testcase classname="invariants.candidate" name="allocation-deterministic" time="0">\n      <skipped message="no stock read fixes a baseline"/>',
    );
    expect(xml).toContain(`<property name="run_id" value="${run.run_id}"/>`);
    expect(xml).toContain('<property name="verdict" value="fail"/>');
    expect(xml).toContain(
      '<testcase classname="run" name="verdict" time="0.3">\n      <failure message="verdict fail: 2 threshold rows failed, 1 invariant violation" type="run">latency.by_tag.get-items.p50_ms measured 12.007, limit 5\ncorrectness.mismatch_rate_max measured 0.5, limit 0</failure>',
    );
    const cases = xml.match(/<testcase /g)?.length ?? 0;
    expect(cases).toBe(run.threshold_results.length + 3 + 3 + 1);
    expect(xml).toContain(
      `<testsuites name="replay-parity ${run.run_id}" tests="${cases}" failures="4" errors="0" skipped="1" time="0.3">`,
    );
    expect(xml).not.toContain('<testsuite name="invariants" ');
    expect(renderJunit(run)).toBe(xml);
    expect(xml).toMatchSnapshot();
  });

  it('passes every case on a passing run and omits sections without rows', () => {
    const xml = renderJunit(passingRun());
    expect(xml).not.toContain('<failure');
    expect(xml).not.toContain('<skipped');
    expect(xml).toContain('<testsuite name="latency" tests="1" failures="0"');
    expect(xml).toContain('<testsuite name="errors" tests="1" failures="0"');
    expect(xml).not.toContain('<testsuite name="correctness"');
    expect(xml).not.toContain('<testsuite name="pacing"');
    expect(xml).not.toContain('<testsuite name="invariants');
    expect(xml).toContain('<testcase classname="run" name="verdict" time="0.3"/>');
    expect(xml).toContain('<property name="verdict" value="pass"/>');
    expect(xml).toContain('tests="3" failures="0" errors="0" skipped="0"');
  });

  it('skips the rows that could not decide and the verdict with the conditions on an inconclusive run', () => {
    const xml = renderJunit(inconclusiveRun());
    expect(xml).toContain(
      '<testcase classname="latency" name="latency.by_tag.get-items.p50_ms" time="0">\n      <skipped message="2 successful samples, minimum 20"/>',
    );
    expect(xml).toContain(
      '<testcase classname="run" name="verdict" time="0.3">\n      <skipped message="barrier_timeout: list-ledger waited 10000 ms; insufficient_samples: get-items: 2 successful samples, minimum 20"/>',
    );
    expect(xml).toContain('<property name="verdict" value="inconclusive"/>');
    expect(xml).toContain('<testsuite name="run" tests="1" failures="0" errors="0" skipped="1"');
    const thin = makeRun({
      thresholds: parseThresholds('latency:\n  min_samples: 20\n  overall: { p99_ms: 100 }\n'),
    });
    expect(thin.verdict).toBe('inconclusive');
    expect(renderJunit(thin)).toContain('<skipped message="insufficient_samples: ');
  });

  it('escapes every recorded string and drops characters XML cannot carry', () => {
    const hostile = '<script>alert("1")</script> & \'x\' ]]>';
    const violated = candidateReport.results[0] as InvariantReport['results'][number];
    const run = makeRun({
      target: `http://cand/${hostile}`,
      inconclusive: [{ kind: 'control_failed', detail: `restart ${hostile}\u0000\u0007` }],
      verdict: 'inconclusive',
      invariants: {
        reference: null,
        candidate: {
          ...candidateReport,
          results: [
            {
              ...violated,
              name: `rule-${hostile}`,
              evidence: violated.evidence.map((e) => ({ ...e, subject: hostile })),
            },
          ],
        },
      },
    });
    const xml = renderJunit(run);
    expect(xml).not.toContain(hostile);
    expect(xml).not.toContain('<script');
    expect(xml).not.toContain(']]>');
    expect(xml).not.toContain('\u0000');
    expect(xml).not.toContain('\u0007');
    expect(xml).toContain(
      '&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt; &amp; &apos;x&apos; ]]&gt;',
    );
    expect(xml).toContain('name="rule-&lt;script&gt;');
    expect(xml).toContain('<skipped message="control_failed: restart &lt;script&gt;');
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
    expect(escapeXml('\u{1F600}')).toBe('\u{1F600}');
    expect(escapeXml('\u0001x\u001fy')).toBe('xy');
  });
});

describe('renderMarkdown', () => {
  it('summarizes a failing run in GitHub flavored Markdown without HTML', () => {
    const run = fullRun();
    const md = renderMarkdown(run);
    expect(md.startsWith(`# replay-parity: FAIL (run ${run.run_id})\n`)).toBe(true);
    expect(md).toContain('- Recording: `recording.jsonl` (4 exchanges, 4 selected)');
    expect(md).toContain('- Target: `http://localhost:3001` via http');
    expect(md).toContain('schedule slip p50 1.00 ms, max 3.00 ms');
    expect(md).not.toContain('Inconclusive because');
    expect(md).toContain('| Outcome | Row | Limit | Measured | Detail |');
    expect(md).toContain('| --- | --- | ---: | ---: | --- |');
    expect(md).toContain('| fail | `latency.by_tag.get-items.p50_ms` | 5 | 12.007 |  |');
    expect(md).toContain('| pass | `errors.rate_max` | 0.5 | 0.3333 |  |');
    expect(md).toContain('| Tag | Count | Errors | p50 | p99 | max |');
    expect(md).toContain('| overall | 3 | 1 | 10.0 / 12.0 | 20.0 / 25.0 | 20.0 / 25.0 |');
    expect(md).toContain('| get-items | 2 | 1 | 10.0 / 12.0 | 10.0 / 12.0 | 10.0 / 12.0 |');
    expect(md).toContain(
      '2 compared, 1 match, 0 tolerated, 1 mismatch (50.00%), 1 errors (33.33%).',
    );
    expect(md).toContain('| `$.total` | 1 | 1 |');
    expect(md).toContain('- reference: 3 hold');
    expect(md).toContain('- candidate: 1 hold, 1 violated, 1 inconclusive');
    expect(md).toContain(
      '  - 1. `shipment-applied-once` violated (2 checks): order o-7: expected 2, observed 4. shp-3 delivered 2 times',
    );
    expect(md).toContain(
      '  - 10. `allocation-deterministic` inconclusive (1 check): no stock read fixes a baseline',
    );
    expect(md).toContain(
      '**reduced reproduction** for rule `invariant:candidate:shipment-applied-once`: 283 recorded steps reduced to 4 in 13 attempts (34.0 ms), written to `reduced-reproduction.jsonl`.',
    );
    expect(md).toContain(
      '| 1 | POST /v1/orders | create-order | `{"sku":"H-800","qty":2}` (quantity reduced) |',
    );
    expect(md).toContain('| 2 | GET /v1/orders/o-12 | get-order |  |');
    expect(md).toContain(
      'claude-sonnet-5-5: 1 of 2 rounds, 4 cases proposed, 4 valid, 4 executed, 1 kept. Stopped on `max_rounds`. Cost $0.30 of a $2.00 budget',
    );
    expect(md).toContain(
      '| `case-1` | 1 | odd quantities round differently | create-item | 201 / 201 | $.total differs by half a cent |',
    );
    expect(md).not.toMatch(/<[a-z!/][^>]*>/i);
    expect(md).not.toContain('—');
    expect(md).not.toContain('minimal');
    expect(md.split('\n').length).toBeLessThan(150);
    expect(md.endsWith('\n')).toBe(true);
    expect(renderMarkdown(run)).toBe(md);
    expect(md).toMatchSnapshot();
  });

  it('keeps a passing run short and leaves out the sections that have nothing', () => {
    const run = makeRun({
      thresholds: parseThresholds('latency:\n  overall: { p99_ms: 100 }\n'),
      exchanges: [makeExchangeResult({ id: 'ok-1' }), makeExchangeResult({ id: 'ok-2' })],
    });
    expect(run.verdict).toBe('pass');
    const md = renderMarkdown(run);
    expect(md.startsWith(`# replay-parity: PASS (run ${run.run_id})\n`)).toBe(true);
    expect(md).toContain('| pass | `latency.overall.p99_ms` | 100 | 12.007 |  |');
    expect(md).toContain('No untolerated differences.');
    expect(md).not.toContain('## Invariants');
    expect(md).not.toContain('## Reproduction');
    expect(md).not.toContain('## Agent');
    expect(md).not.toContain('Inconclusive because');
    expect(md.split('\n').length).toBeLessThan(30);
    expect(renderMarkdown(makeRun({ exchanges: [] }))).toContain('No thresholds configured.');
  });

  it('names the inconclusive conditions under the heading', () => {
    const md = renderMarkdown(inconclusiveRun());
    expect(md).toContain('# replay-parity: INCONCLUSIVE (run ');
    expect(md).toContain(
      '**Inconclusive because**\n\n- `barrier_timeout`: list-ledger waited 10000 ms\n- `insufficient_samples`: get-items: 2 successful samples, minimum 20\n',
    );
    expect(md).toContain(
      '| inconclusive | `latency.by_tag.get-items.p50_ms` | 5 | n/a | 2 successful samples, minimum 20 |',
    );
  });

  it('escapes Markdown punctuation in recorded strings so a cell or a line cannot be broken', () => {
    const hostile = 'a|b <x> *y* _z_ [l](u) `q` ~s~ \\ end';
    const kept = agent.cases[0] as AgentReport['cases'][number];
    const run = makeRun({
      target: `http://cand/${hostile}`,
      exchanges: [
        makeExchangeResult({
          id: 'h',
          path: `/v1/${hostile}`,
          tags: ['t|u'],
          diff: {
            verdict: 'mismatch',
            findings: [
              {
                path: '$.items[0].na|me',
                kind: 'value',
                tolerated: false,
                reference: hostile,
                candidate: 'b',
              },
            ],
          },
        }),
      ],
      agent: {
        ...agent,
        cases: [{ ...kept, hypothesis: hostile, revealed: hostile, tags: ['t|u'] }],
      },
    });
    const md = renderMarkdown(run);
    expect(md).not.toContain(hostile);
    expect(md).toContain(
      '| a\\|b \\<x\\> \\*y\\* \\_z\\_ \\[l\\](u) \\`q\\` \\~s\\~ \\\\ end | t\\|u |',
    );
    expect(md).toContain('| `$.items[*].na\\|me` | 1 | 1 |');
    expect(md).toContain('- Target: `` http://cand/a\\|b <x> *y* _z_ [l](u) `q` ~s~ \\ end ``');
    for (const line of md.split('\n').filter((l) => l.startsWith('| '))) {
      expect(line.endsWith(' |'), line).toBe(true);
    }
  });
});

describe('renderJson', () => {
  it('validates against the schema and round trips', () => {
    const run = fullRun();
    const text = renderJson(run);
    const parsed = JSON.parse(text) as unknown;
    expect(validate(parsed), validate.errors ?? '').toBe(true);
    expect(parseRun(text)).toEqual(run);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('renderHistogram', () => {
  it('is deterministic and draws one bar per bin for each series', () => {
    const reference = HISTOGRAM_EDGES_MS.slice(0, -1).map((_, i) => (i % 7 === 0 ? i : 0));
    const candidate = HISTOGRAM_EDGES_MS.slice(0, -1).map((_, i) => (i % 5 === 0 ? 3 : 0));
    const a = renderHistogram({ edges: HISTOGRAM_EDGES_MS, reference, candidate, title: 'x' });
    const b = renderHistogram({ edges: HISTOGRAM_EDGES_MS, reference, candidate, title: 'x' });
    expect(a).toBe(b);
    expect(a.match(/<rect class="reference"/g)).toHaveLength(48);
    expect(a.match(/<rect class="candidate"/g)).toHaveLength(48);
    expect(a).toContain('>0.1 ms<');
    expect(a).toContain('>10000 ms<');
    expect(a).toContain('max 42');
    expect(a).not.toContain('<script');
  });

  it('renders an empty chart without dividing by zero', () => {
    const zeros = new Array<number>(48).fill(0);
    const svg = renderHistogram({ edges: HISTOGRAM_EDGES_MS, reference: zeros, candidate: zeros });
    expect(svg).toContain('max 1');
    expect(svg).not.toContain('NaN');
  });
});

describe('topMismatchPaths', () => {
  it('counts untolerated findings across mismatched exchanges, most frequent first', () => {
    const run = makeRun();
    expect(topMismatchPaths(run)).toEqual([{ path: '$.total', count: 1, exchanges: 1 }]);
  });

  it('folds array positions so rows that moved count as one path', () => {
    const finding = (path: string, tolerated = false) => ({
      path,
      kind: 'value' as const,
      tolerated,
      reference: 'a',
      candidate: 'b',
    });
    const run = makeRun({
      exchanges: [
        makeExchangeResult({
          id: 'x1',
          diff: {
            verdict: 'mismatch',
            findings: [
              finding('$.items[0].name'),
              finding('$.items[1].name'),
              finding('$.items[1].on_hand'),
              finding('$.items[2].name', true),
            ],
          },
        }),
        makeExchangeResult({
          id: 'x2',
          diff: { verdict: 'mismatch', findings: [finding('$.items[7].name'), finding('$.total')] },
        }),
        makeExchangeResult({ id: 'x3', diff: { verdict: 'match', findings: [] } }),
      ],
    });
    expect(topMismatchPaths(run)).toEqual([
      { path: '$.items[*].name', count: 3, exchanges: 2 },
      { path: '$.items[*].on_hand', count: 1, exchanges: 1 },
      { path: '$.total', count: 1, exchanges: 1 },
    ]);
    expect(topMismatchPaths(run, 1)).toHaveLength(1);
    const text = renderTerminal(run);
    expect(text).toContain(
      'top mismatching paths: $.items[*].name x3 in 2 exchanges, $.items[*].on_hand x1 in 1 exchange, $.total x1 in 1 exchange',
    );
    const html = renderHtml(run);
    expect(html).toContain(
      '<code>$.items[*].name</code></td><td class="num">3</td><td class="num">2</td>',
    );
    expect(html).toContain('Array positions are folded');
  });
});
