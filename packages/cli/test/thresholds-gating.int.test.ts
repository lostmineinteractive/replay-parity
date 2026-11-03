import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseRun, type Run } from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** `rp replay` gating on the completed threshold matrix against the clean demo candidate. */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

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

let dir: string;
let target: string;
let app: ReturnType<typeof buildCandidate>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-thresholds-gating-'));
  app = buildCandidate({ divergences: 'off' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  target = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

async function thresholdsFile(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

function replayArgs(out: string, extra: string[]): string[] {
  return [
    'replay',
    '--recording',
    RECORDING,
    '--target',
    target,
    '--rules',
    join(ROOT, 'demo/diff-rules.yaml'),
    '--barrier-tag',
    'list-ledger',
    '--pace',
    'max',
    '--quiet',
    '--out',
    out,
    ...extra,
  ];
}

async function replayWith(name: string, thresholds: string, extra: string[] = []) {
  const path = await thresholdsFile(`${name}.yaml`, thresholds);
  const out = join(dir, `${name}.json`);
  const res = await rp(replayArgs(out, ['--thresholds', path, ...extra]));
  const run: Run = parseRun(await readFile(out, 'utf8'));
  return { res, run, out };
}

describe('rp replay with the completed threshold matrix', () => {
  it('records candidate statuses and gates status shares, throughput, and per tag errors', async () => {
    const { res, run } = await replayWith(
      'matrix',
      [
        'throughput: { achieved_rps_min: 0.001 }',
        'status:',
        '  by_tag:',
        "    get-order: { '404': { rate_max: 0.1 }, '500': { rate_max: 0 } }",
        'errors:',
        '  by_tag:',
        '    get-order: { rate_max: 0 }',
        'latency:',
        '  relative_to_reference:',
        '    by_tag:',
        '      get-order: { p50_ratio_max: 1000 }',
        '',
      ].join('\n'),
    );
    expect(res.code, res.err).toBe(0);
    const getOrder = run.stats.by_tag['get-order'];
    expect(getOrder?.candidate_status?.['404']).toBe(8);
    const rows = Object.fromEntries(run.threshold_results.map((r) => [r.id, r]));
    expect(rows['throughput.achieved_rps_min']).toMatchObject({
      section: 'throughput',
      outcome: 'pass',
      measured: run.pacing.achieved_rps,
    });
    expect(rows['status.by_tag.get-order.404.rate_max']).toMatchObject({
      section: 'status',
      scope: 'get-order',
      outcome: 'pass',
      measured: Math.round((8 / (getOrder?.compared ?? 1)) * 10_000) / 10_000,
    });
    expect(rows['status.by_tag.get-order.500.rate_max']?.outcome).toBe('pass');
    expect(rows['errors.by_tag.get-order.rate_max']?.outcome).toBe('pass');
    expect(rows['latency.relative_to_reference.by_tag.get-order.p50_ratio_max']?.outcome).toBe(
      'pass',
    );
  });

  it('fails a status share above its limit', async () => {
    const { res, run } = await replayWith(
      'status-fail',
      "status:\n  by_tag:\n    get-order: { '404': { rate_max: 0.01 } }\n",
    );
    expect(res.code).toBe(2);
    expect(run.verdict).toBe('fail');
  });

  it('names the excluded noise in the correctness rows and gates its rate', async () => {
    // A second clean candidate stands in for the reference, so the re-replay has noise to find.
    const reference = buildCandidate({ divergences: 'off' });
    await reference.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = reference.server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const { run } = await replayWith(
        'noise',
        'correctness:\n  mismatch_rate_max: 1\n  noise_rate_max: 1000\n',
        ['--reference-target', `http://127.0.0.1:${address.port}`],
      );
      const noise = run.stats.noise_findings;
      expect(noise).toBeDefined();
      const rows = Object.fromEntries(run.threshold_results.map((r) => [r.id, r]));
      expect(rows['correctness.mismatch_rate_max']?.detail).toBe(
        `${noise?.overall} noise finding${noise?.overall === 1 ? '' : 's'} excluded`,
      );
      expect(rows['correctness.noise_rate_max']).toMatchObject({
        outcome: 'pass',
        measured:
          Math.round(((noise?.overall ?? 0) / run.stats.overall.compared) * 10_000) / 10_000,
      });
    } finally {
      await reference.close();
    }
  });
});
