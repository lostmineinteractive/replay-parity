import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseRun } from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** `rp replay` with an invariant module or a declarative rules file in place of the built in rules. */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const RULES = join(ROOT, 'examples/invariants/order-lifecycle.yaml');
const MODULE = join(ROOT, 'examples/invariants/key-value-store.mjs');

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
  dir = await mkdtemp(join(tmpdir(), 'rp-replay-invariants-'));
  app = buildCandidate({ divergences: 'off' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  target = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

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

describe('rp replay with an invariant module', () => {
  it('evaluates a declarative rules file on both systems and implies --invariants', async () => {
    const out = join(dir, 'declarative.json');
    const res = await rp(replayArgs(out, ['--invariants-rules', RULES]));
    expect(res.code, res.err).toBe(0);
    const run = parseRun(await readFile(out, 'utf8'));
    for (const report of [run.invariants.reference, run.invariants.candidate]) {
      expect(report?.module?.name).toBe('declarative');
      expect(report?.results.length).toBeGreaterThan(0);
      expect(report?.violations).toBe(0);
    }
  });

  it('records the module of --invariants-module with its hash', async () => {
    const out = join(dir, 'module.json');
    const res = await rp(replayArgs(out, ['--invariants-module', MODULE]));
    // The key value store rules find nothing to check in the order lifecycle recording.
    expect([0, 3]).toContain(res.code);
    const run = parseRun(await readFile(out, 'utf8'));
    expect(run.invariants.candidate?.module?.name).toBe('key-value-store');
    expect(run.invariants.candidate?.module?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses both flags together before anything is sent', async () => {
    const res = await rp(
      replayArgs(join(dir, 'both.json'), [
        '--invariants-module',
        MODULE,
        '--invariants-rules',
        RULES,
      ]),
    );
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/cannot be used together/);
  });
});
