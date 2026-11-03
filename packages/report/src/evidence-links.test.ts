import {
  makeExchangeResult,
  makeRun,
  type InvariantReport,
  type InvariantResult,
  type Run,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { renderHtml } from './html.js';

/** Invariant evidence in the HTML report links to the drill down entry of its exchange. */

function mismatched(id: string) {
  return makeExchangeResult({
    id,
    diff: {
      verdict: 'mismatch',
      findings: [{ path: '$.a', kind: 'value', tolerated: false, reference: 1, candidate: 2 }],
    },
  });
}

function report(evidenceIds: (string | null)[]): InvariantReport {
  const result: InvariantResult = {
    id: 1,
    name: 'shipped-monotonic',
    statement: 'Cumulative shipped quantity never decreases.',
    status: 'violated',
    checks: evidenceIds.length,
    evidence: evidenceIds.map((id) => ({
      subject: 'order o-1',
      expected: 2,
      observed: 1,
      detail: 'shipped went down',
      exchange_id: id,
    })),
  };
  return {
    system: 'candidate',
    recording: 'candidate.jsonl',
    exchanges: 3,
    commands: 2,
    snapshots: { ledger_reads: 0, stock_reads: 0, order_reads: 0 },
    results: [result],
    violations: 1,
    inconclusive: [],
  };
}

function runWith(evidenceIds: (string | null)[]): Run {
  return makeRun({
    exchanges: [mismatched('x-1'), mismatched('x/2 "q"'), makeExchangeResult({ id: 'x-3' })],
    invariants: { reference: null, candidate: report(evidenceIds) },
  });
}

describe('evidence links in the HTML report', () => {
  it('gives every drill down entry an anchor on its summary', () => {
    const html = renderHtml(runWith([]));
    expect(html).toContain('<details class="exchange" data-id="x-1"><summary id="exchange-x-1">');
    expect(html).toContain(
      '<details class="exchange" data-id="x/2 &quot;q&quot;"><summary id="exchange-x/2 &quot;q&quot;">',
    );
  });

  it('links evidence to a drilled exchange and leaves the rest as text', () => {
    const html = renderHtml(runWith(['x-1', 'x/2 "q"', 'x-3', 'not-in-run', null]));
    expect(html).toContain('(<a href="#exchange-x-1">exchange x-1</a>)');
    expect(html).toContain(
      `(<a href="#${encodeURIComponent('exchange-x/2 "q"')}">exchange x/2 &quot;q&quot;</a>)`,
    );
    expect(html).toContain('<span class="muted">(exchange x-3)</span>');
    expect(html).toContain('<span class="muted">(exchange not-in-run)</span>');
    expect(html).not.toContain('href="#exchange-x-3"');
    expect(html).not.toContain('<script');
  });

  it('does not link to an exchange the drill down cap left out', () => {
    const exchanges = Array.from({ length: 205 }, (_, i) => mismatched(`m-${i}`));
    const run = makeRun({
      exchanges,
      invariants: { reference: null, candidate: report(['m-0', 'm-204']) },
    });
    const html = renderHtml(run);
    expect(html).toContain('href="#exchange-m-0"');
    expect(html).not.toContain('href="#exchange-m-204"');
    expect(html).not.toContain('id="exchange-m-204"');
  });
});
