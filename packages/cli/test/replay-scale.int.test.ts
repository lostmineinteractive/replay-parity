import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { compileRunValidator, readRun, type RunValidator } from '@replay-parity/core';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** The replay flags for scale: sessions, pacing controls, retries, re-replay, and streaming. */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

const RULES = `
ignore: ["$.created_at"]
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`;

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, signal });
  return { code, out: stdout.text, err: stderr.text };
}

let validate: RunValidator;
let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
  dir = await mkdtemp(join(tmpdir(), 'rp-cli-scale-'));
  await writeFile(join(dir, 'rules.yaml'), RULES);
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(divergences: DivergenceSetting): Promise<string> {
  const app = buildCandidate({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

function replayArgs(target: string, out: string, extra: string[]): string[] {
  return [
    'replay',
    '--recording',
    RECORDING,
    '--target',
    target,
    '--out',
    out,
    '--pace',
    'max',
    '--concurrency',
    '4',
    '--rules',
    join(dir, 'rules.yaml'),
    '--quiet',
    ...extra,
  ];
}

describe('rp replay at scale', () => {
  it('records the session key and the sessions it formed', async () => {
    const out = join(dir, 'sessions.json');
    // No demo request carries this header, so every exchange is in the no value session.
    const result = await rp(
      replayArgs(await candidate('off'), out, ['--session-key', 'header:x-client']),
    );
    expect(result.err).not.toMatch(/rp: /);
    expect(result.code).toBe(0);
    const run = await readRun(out);
    expect(run.pacing).toMatchObject({ session_key: 'header:x-client', sessions: 1 });
    expect(validate(run), validate.errors ?? '').toBe(true);
    const bad = await rp(replayArgs('http://127.0.0.1:9', out, ['--session-key', 'nope']));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--session-key nope');
  });

  it('passes --speed and --loop to the engine and records them', async () => {
    const out = join(dir, 'loop.json');
    const target = await candidate('off');
    const result = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      target,
      '--out',
      out,
      '--limit',
      '3',
      '--speed',
      '50',
      '--loop',
      '2',
      '--rules',
      join(dir, 'rules.yaml'),
      '--quiet',
    ]);
    expect(result.err).not.toMatch(/rp: /);
    expect(result.code).toBe(0);
    const run = await readRun(out);
    expect(run.pacing).toMatchObject({ mode: 'as-recorded', speed: 50, loop: 2 });
    expect(run.exchanges).toHaveLength(6);
    expect(run.exchanges[3]?.id).toMatch(/#2$/);
    expect(validate(run), validate.errors ?? '').toBe(true);
    const wrong = await rp(replayArgs(target, out, ['--speed', '2']));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('as-recorded pacing only');
  });

  it('passes the retry policy to the engine and rejects an unknown kind', async () => {
    const out = join(dir, 'retry.json');
    const result = await rp(
      replayArgs(await candidate('off'), out, [
        '--retry',
        '2',
        '--retry-on',
        'timeout',
        '--retry-base-ms',
        '5',
      ]),
    );
    expect(result.code).toBe(0);
    const run = await readRun(out);
    expect(run.pacing.retry).toEqual({ max: 2, on: ['timeout'], base_ms: 5, unsafe: false });
    expect(run.stats.retried).toEqual({ overall: 0, by_tag: {} });
    expect(validate(run), validate.errors ?? '').toBe(true);
    const bad = await rp(replayArgs('http://127.0.0.1:9', out, ['--retry-on', 'protocol']));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--retry-on protocol: expected timeout or connection');
  });

  it('marks $.created_at as noise on the demo through the reference re-replay without an ignore rule', async () => {
    const rules = join(dir, 'no-ignore.yaml');
    await writeFile(rules, RULES.replace('ignore: ["$.created_at"]\n', ''));
    const reference = buildReference();
    await reference.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => reference.close());
    const refUrl = `http://127.0.0.1:${(reference.server.address() as AddressInfo).port}`;
    const thresholds = join(dir, 'strict.yaml');
    await writeFile(thresholds, 'correctness:\n  mismatch_rate_max: 0\n');
    // Each run gets a fresh candidate, since a replay changes the candidate's state.
    const args = (target: string, out: string, extra: string[]): string[] => [
      'replay',
      '--recording',
      RECORDING,
      '--target',
      target,
      '--out',
      out,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      rules,
      '--thresholds',
      thresholds,
      '--quiet',
      ...extra,
    ];
    const plain = await rp(args(await candidate('off'), join(dir, 'plain.json'), []));
    expect(plain.code).toBe(2);
    const out = join(dir, 'noise.json');
    const result = await rp(args(await candidate('off'), out, ['--reference-target', refUrl]));
    expect(result.err).not.toMatch(/rp: /);
    expect(result.code).toBe(0);
    const run = await readRun(out);
    expect(run.reference_target).toBe(refUrl);
    const noise = run.exchanges.flatMap((e) => (e.diff?.findings ?? []).filter((f) => f.noise));
    expect(noise.length).toBeGreaterThan(0);
    expect(new Set(noise.map((f) => f.path))).toEqual(new Set(['$.created_at']));
    expect(run.stats.noise_findings?.overall).toBe(noise.length);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('streams results to the sidecar next to the run and rp report reads it back', async () => {
    const side = join(dir, 'side');
    await mkdir(side);
    const out = join(side, 'run.json');
    const result = await rp(
      replayArgs(await candidate('on'), out, ['--exchanges-sidecar', '--window', '50']),
    );
    expect(result.err).not.toMatch(/rp: /);
    expect(result.code).toBe(0);
    expect(result.err).toContain('wrote every exchange result to');
    const run = await readRun(out);
    expect(run.exchanges_path).toBe('run.exchanges.jsonl');
    const lines = (await readFile(join(side, 'run.exchanges.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(run.stats.overall.count + 1);
    const mismatches = run.stats.overall.mismatches;
    expect(mismatches).toBeGreaterThan(run.exchanges.length);
    expect(validate(run), validate.errors ?? '').toBe(true);

    const html = await rp(['report', '--run', out, '--format', 'html']);
    expect(html.code).toBe(0);
    expect(html.out).toContain(`<h3>Mismatched exchanges (${mismatches})</h3>`);
    const json = await rp(['report', '--run', out, '--format', 'json']);
    expect(JSON.parse(json.out)).toMatchObject({ exchanges_path: 'run.exchanges.jsonl' });

    await rename(join(side, 'run.exchanges.jsonl'), join(side, 'moved.jsonl'));
    const missing = await rp(['report', '--run', out, '--format', 'html']);
    expect(missing.code).toBe(0);
    expect(missing.err).toContain('run.exchanges.jsonl not found');
    expect(missing.out).toContain(`<h3>Mismatched exchanges (${run.exchanges.length})</h3>`);

    const inline = join(side, 'inline.json');
    const kept = await rp(replayArgs(await candidate('on'), inline, ['--no-exchanges-sidecar']));
    expect(kept.code).toBe(0);
    const whole = await readRun(inline);
    expect(whole.exchanges_path).toBeNull();
    expect(whole.exchanges).toHaveLength(whole.stats.overall.count + 1);
  });

  it('writes a checkpoint when stopped and continues the run with --resume', async () => {
    const resumable = join(dir, 'resumable');
    await mkdir(resumable);
    const out = join(resumable, 'run.json');
    const target = await candidate('off');
    const controller = new AbortController();
    controller.abort();
    const stopped = await rp(replayArgs(target, out, ['--exchanges-sidecar']), controller.signal);
    expect(stopped.code).toBe(3);
    expect(stopped.err).toContain('--resume continues it from');
    await access(join(resumable, 'run.checkpoint.json'));
    const resumed = await rp(replayArgs(target, out, ['--exchanges-sidecar', '--resume']));
    expect(resumed.err).not.toMatch(/rp: /);
    expect(resumed.code).toBe(0);
    const run = await readRun(out);
    expect(run.inconclusive).toEqual([]);
    const lines = (await readFile(join(resumable, 'run.exchanges.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(run.stats.overall.count + 1);
    await expect(access(join(resumable, 'run.checkpoint.json'))).rejects.toThrow();
    const again = await rp(replayArgs(target, out, ['--exchanges-sidecar', '--resume']));
    expect(again.code).toBe(1);
    expect(again.err).toContain('--resume: no checkpoint at');
  });
});
