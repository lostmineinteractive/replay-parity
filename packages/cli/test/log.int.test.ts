import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger } from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCapture, runCli } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

class Sink extends Writable {
  text = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, env });
  return { code, out: stdout.text, err: stderr.text };
}

function records(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-log-'));
  await writeFile(join(dir, 'rules.yaml'), 'ignore: ["$.created_at"]\n');
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function candidate(): Promise<string> {
  const app = buildCandidate({ divergences: 'off', seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

function replayArgs(target: string, out: string, ...extra: string[]): string[] {
  return [
    'replay',
    '--recording',
    RECORDING,
    '--target',
    target,
    '--pace',
    'max',
    '--limit',
    '8',
    '--no-include-dependencies',
    '--rules',
    join(dir, 'rules.yaml'),
    '--no-preflight',
    '--quiet',
    '--out',
    out,
    ...extra,
  ];
}

describe('the logger in the CLI', () => {
  it('prints the plain line in the text format and one object per line in json', async () => {
    const url = await candidate();
    const text = await rp(replayArgs(url, join(dir, 'a.json')));
    expect(text.err).toMatch(/^wrote .*a\.json: (PASS|FAIL|INCONCLUSIVE)\n$/);

    const json = await rp(['--log-format', 'json', ...replayArgs(url, join(dir, 'b.json'))]);
    const lines = records(json.err);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(line).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
      expect(new Date(line.ts as string).toISOString()).toBe(line.ts);
      expect(line.command).toBe('replay');
    }
    const wrote = lines.find((l) => String(l.msg).startsWith('wrote '));
    expect(wrote).toMatchObject({ level: 'info', out: join(dir, 'b.json') });
  });

  it('takes the level and the format from the environment and lets a flag win', async () => {
    const url = await candidate();
    const quiet = await rp(replayArgs(url, join(dir, 'c.json')), { RP_LOG_LEVEL: 'warn' });
    expect(quiet.err).toBe('');

    const loud = await rp(['--log-level', 'info', ...replayArgs(url, join(dir, 'd.json'))], {
      RP_LOG_LEVEL: 'error',
      RP_LOG_FORMAT: 'json',
    });
    expect(records(loud.err).at(-1)).toMatchObject({ level: 'info', command: 'replay' });
  });

  it('rejects a bad level or format with exit 1 and a message', async () => {
    const level = await rp(['--log-level', 'loud', 'doctor']);
    expect(level.code).toBe(1);
    expect(level.err).toContain('--log-level: expected one of debug, info, warn, error');
    const format = await rp(['doctor'], { RP_LOG_FORMAT: 'xml' });
    expect(format.code).toBe(1);
    expect(format.err).toContain('RP_LOG_FORMAT: expected one of text, json');
  });

  it('writes an error as a record with the command when a flag is missing', async () => {
    const res = await rp(['--log-format', 'json', 'replay']);
    expect(res.code).toBe(1);
    expect(records(res.err).at(-1)).toMatchObject({ level: 'error' });
  });

  it('never writes a header value, only its name', async () => {
    const url = await candidate();
    const res = await rp(
      [
        '--log-format',
        'json',
        '--log-level',
        'debug',
        ...replayArgs(url, join(dir, 'e.json'), '--header', 'x-api-key: hunter2-secret'),
      ],
      {},
    );
    expect(res.err).not.toContain('hunter2-secret');
  });
});

describe('the capture server log', () => {
  it('logs an upstream failure at error with the context', async () => {
    const stderr = new Sink();
    const streams = {
      stdout: new Sink(),
      stderr,
      log: createLogger({ format: 'json', sink: (line) => stderr.write(line) }).child({
        command: 'capture',
      }),
    };
    // A closed port gives a refused connection upstream.
    const deadPort = await freePort();
    const listenPort = await freePort();
    const abort = new AbortController();
    const running = runCapture(
      {
        listen: { host: '127.0.0.1', port: listenPort },
        target: `http://127.0.0.1:${deadPort}`,
        out: join(dir, 'cap.jsonl'),
        tagRule: [],
        sample: 1,
        redactHeader: [],
        redactQuery: [],
        maxBodyBytes: 1_000_000,
        append: false,
        upstreamTimeoutMs: 2000,
      },
      streams,
      abort.signal,
    );
    const deadline = Date.now() + 10_000;
    while (!stderr.text.includes('capturing on') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await fetch(`http://127.0.0.1:${listenPort}/x`).catch(() => undefined);
    abort.abort();
    expect(await running).toBe(0);
    const lines = records(stderr.text);
    const failure = lines.find((l) => l.level === 'error');
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ command: 'capture' });
    expect(String(failure?.msg)).toMatch(/^capture: /);
    expect(typeof failure?.context).toBe('string');
  });
});
