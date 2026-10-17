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
  fmtNumber,
  renderHistogram,
  renderHtml,
  renderJson,
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
      dedupe_key: 'mismatch:$.total',
      reference: { status: 201, latency_ms: 2 },
      candidate: { status: 201, latency_ms: 3 },
      error: null,
      diff: { verdict: 'mismatch', findings: [] },
      latency_breach: null,
      revealed: '$.total differs by half a cent',
    },
  ],
};

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
    expect(topMismatchPaths(run)).toEqual([{ path: '$.total', count: 1 }]);
  });
});
