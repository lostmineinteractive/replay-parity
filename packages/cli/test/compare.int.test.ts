import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  fixedUlid,
  makeExchangeResult,
  makeRun,
  parseThresholds,
  writeRun,
  type Run,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunComparison } from '../src/commands/compare.js';
import { runCli } from '../src/index.js';

/** `rp compare` over two run files written with the test builders. */

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, env: {}, cwd: dir });
  return { code, out: stdout.text, err: stderr.text };
}

const HASH = 'a'.repeat(64);
let dir: string;
let pathA: string;
let pathB: string;
let runA: Run;
let runB: Run;

function withHash(run: Run, hash: string | null): Run {
  return { ...run, recording: { ...run.recording, recording_sha256: hash } };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-compare-'));
  // a: the builder's run, one mismatch at $.total and one error, gated on correctness and errors.
  runA = withHash(
    makeRun({
      thresholds: parseThresholds(
        'correctness:\n  mismatch_rate_max: 0.5\nerrors:\n  rate_max: 0\n',
      ),
    }),
    HASH,
  );
  // b: a slower candidate whose mismatch moved to the item rows, with a noise finding and an
  // extra latency row.
  const exchanges = [
    makeExchangeResult({ id: fixedUlid(0), candidate: { status: 200, latency_ms: 30 } }),
    makeExchangeResult({
      id: fixedUlid(1),
      tags: ['create-item'],
      candidate: { status: 201, latency_ms: 40 },
      reference: { status: 201, latency_ms: 20 },
      diff: {
        verdict: 'mismatch',
        findings: [
          {
            path: '$.items[0].sku',
            kind: 'value',
            tolerated: false,
            reference: 'a',
            candidate: 'b',
          },
          {
            path: '$.items[1].sku',
            kind: 'value',
            tolerated: false,
            reference: 'c',
            candidate: 'd',
          },
          {
            path: '$.updated_at',
            kind: 'value',
            tolerated: true,
            rule: 'noise:reference',
            noise: true,
            reference: '1',
            candidate: '2',
          },
        ],
      },
    }),
  ];
  const built = makeRun({
    exchanges,
    thresholds: parseThresholds(
      'latency:\n  overall: { p99_ms: 100 }\ncorrectness:\n  mismatch_rate_max: 0.6\nerrors:\n  rate_max: 0\n',
    ),
  });
  runB = withHash(
    {
      ...built,
      run_id: fixedUlid(98),
      stats: { ...built.stats, noise_findings: { overall: 1, by_tag: { 'create-item': 1 } } },
    },
    HASH,
  );
  pathA = join(dir, 'a.json');
  pathB = join(dir, 'b.json');
  await writeRun(pathA, runA);
  await writeRun(pathB, runB);
});

describe('rp compare', () => {
  it('prints the comparison as JSON and exits 0 whatever the verdicts', async () => {
    expect(runA.verdict).toBe('fail');
    const res = await rp(['compare', pathA, pathB, '--format', 'json']);
    expect(res.code, res.err).toBe(0);
    const c = JSON.parse(res.out) as RunComparison;
    expect(c.a).toEqual({
      path: pathA,
      run_id: runA.run_id,
      created_at: runA.created_at,
      verdict: 'fail',
      recording_sha256: HASH,
    });
    expect(c.b.run_id).toBe(runB.run_id);
    expect(c.same_recording).toBe(true);
    expect(c.thresholds).toEqual([
      {
        id: 'correctness.mismatch_rate_max',
        section: 'correctness',
        scope: 'overall',
        metric: 'mismatch_rate_max',
        a: { limit: 0.5, measured: 0.5, outcome: 'pass' },
        b: { limit: 0.6, measured: 0.5, outcome: 'pass' },
      },
      {
        id: 'errors.rate_max',
        section: 'errors',
        scope: 'overall',
        metric: 'rate_max',
        a: { limit: 0, measured: 0.333333, outcome: 'fail' },
        b: { limit: 0, measured: 0, outcome: 'pass' },
      },
      {
        id: 'latency.overall.p99_ms',
        section: 'latency',
        scope: 'overall',
        metric: 'p99_ms',
        a: null,
        b: { limit: 100, measured: runB.stats.overall.candidate.p99_ms, outcome: 'pass' },
      },
    ]);
    expect(c.paths).toEqual({
      appeared: [{ path: '$.items[*].sku', count: 2, exchanges: 1 }],
      disappeared: [{ path: '$.total', count: 1, exchanges: 1 }],
    });
    const overall = c.latency[0];
    expect(overall?.scope).toBe('overall');
    expect(overall?.p50_delta_ms).toBeCloseTo(
      runB.stats.overall.candidate.p50_ms - runA.stats.overall.candidate.p50_ms,
      3,
    );
    expect(overall?.p99_delta_ms).toBeCloseTo(
      runB.stats.overall.candidate.p99_ms - runA.stats.overall.candidate.p99_ms,
      3,
    );
    expect(c.latency.map((l) => l.scope)).toEqual(['overall', 'create-item', 'get-items']);
    expect(c.counts).toEqual({
      a: {
        compared: 2,
        mismatches: 1,
        mismatch_rate: 0.5,
        errors: 1,
        error_rate: 0.333333,
        noise_findings: null,
      },
      b: {
        compared: 2,
        mismatches: 1,
        mismatch_rate: 0.5,
        errors: 0,
        error_rate: 0,
        noise_findings: 1,
      },
    });
  });

  it('prints terminal text by default', async () => {
    const res = await rp(['compare', pathA, pathB]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain(`compare a ${runA.run_id} (FAIL) with b ${runB.run_id} (PASS)`);
    expect(res.out).toContain('same recording: yes');
    expect(res.out).toMatch(/errors\.rate_max\s+0\s+fail 0\.3333\s+pass 0/);
    expect(res.out).toMatch(/latency\.overall\.p99_ms\s+100\s+-\s+pass/);
    expect(res.out).toMatch(
      /correctness\.mismatch_rate_max\s+0\.5 \/ 0\.6\s+pass 0\.5\s+pass 0\.5/,
    );
    expect(res.out).toContain('appeared in b: $.items[*].sku x2 in 1 exchange');
    expect(res.out).toContain('gone from b: $.total x1 in 1 exchange');
    expect(res.out).toMatch(/\n {2}a +2 +1 \(50\.00%\) +1 \(33\.33%\) +n\/a\n/);
    expect(res.out).toMatch(/\n {2}b +2 +1 \(50\.00%\) +0 \(0\.00%\) +1\n/);
  });

  it('prints Markdown tables', async () => {
    const res = await rp(['compare', pathA, pathB, '--format', 'markdown']);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain('# Run comparison');
    expect(res.out).toContain(
      '| `errors.rate_max` | errors | overall | 0 | fail 0.3333 | pass 0 |',
    );
    expect(res.out).toContain('| appeared in b | `$.items[*].sku` | 2 | 1 |');
    expect(res.out).toContain('| gone from b | `$.total` | 1 | 1 |');
    expect(res.out).toContain('| b | 2 | 1 (50.00%) | 0 (0.00%) | 1 |');
    expect(res.out).toContain('## Candidate latency');
  });

  it('says when the runs replayed different recordings or a hash is missing', async () => {
    const other = join(dir, 'other.json');
    await writeRun(other, withHash(runB, 'b'.repeat(64)));
    const differs = await rp(['compare', pathA, other, '--format', 'json']);
    expect((JSON.parse(differs.out) as RunComparison).same_recording).toBe(false);
    const unhashed = join(dir, 'unhashed.json');
    await writeRun(unhashed, withHash(runB, null));
    const res = await rp(['compare', pathA, unhashed]);
    expect(res.out).toContain('same recording: unknown, a recording hash is missing');
  });

  it('reports no change between a run and itself', async () => {
    const res = await rp(['compare', pathA, pathA, '--format', 'json']);
    const c = JSON.parse(res.out) as RunComparison;
    expect(c.paths).toEqual({ appeared: [], disappeared: [] });
    expect(c.latency.every((l) => l.p50_delta_ms === 0 && l.p99_delta_ms === 0)).toBe(true);
    const text = await rp(['compare', pathA, pathA]);
    expect(text.out).toContain('top mismatching paths:\n  no change');
  });

  it('is a tool error for a missing or invalid run file', async () => {
    const missing = await rp(['compare', pathA, join(dir, 'nope.json')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('nope.json');
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{oops');
    expect((await rp(['compare', bad, pathA])).code).toBe(1);
    expect((await rp(['compare', pathA])).code).toBe(1);
  });
});
