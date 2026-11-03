import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { compileRunValidator, readRun, type RunValidator } from '@replay-parity/core';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
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

async function rp(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr });
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
});
