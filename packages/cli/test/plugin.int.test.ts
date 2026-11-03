import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  parseRun,
  readRecording,
} from '@replay-parity/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const ECHO = join(ROOT, 'examples/adapters/echo-adapter.mjs');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(args: string[]): Promise<{ code: number; err: string }> {
  const stderr = new Sink();
  const code = await runCli(args, { stdout: new Sink(), stderr });
  return { code, err: stderr.text };
}

let dir: string;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-plugin-'));
});

afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

/** The response map the echo adapter reads, built from the reference responses in a recording. */
async function mapFrom(recording: string): Promise<Record<string, unknown[]>> {
  const map: Record<string, unknown[]> = {};
  for (const e of await readRecording(recording)) {
    const key = `${e.request.method} ${e.request.path}`;
    (map[key] ??= []).push({
      status: e.response.status,
      headers: e.response.headers,
      ...(e.response.body === undefined ? {} : { body: e.response.body }),
    });
  }
  return map;
}

async function writeModule(name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source);
  return path;
}

const ONE = (): string => {
  const exchange = makeExchange({
    request: makeRequest({ path: '/v1/items' }),
    response: jsonResponse({ ok: true }),
  });
  return `${JSON.stringify(exchange)}\n`;
};

describe('rp replay --adapter-module', () => {
  it('replays the demo recording through the example echo adapter', async () => {
    const mapPath = join(dir, 'echo-map.json');
    await writeFile(mapPath, JSON.stringify(await mapFrom(RECORDING)));
    const out = join(dir, 'echo-run.json');
    const result = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'echo://map',
      '--out',
      out,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--quiet',
      '--no-preflight',
      '--adapter-module',
      ECHO,
      '--adapter-setting',
      `map=${mapPath}`,
    ]);
    expect(result.err).not.toContain('unexpected error');
    const run = parseRun(await readFile(out, 'utf8'));
    expect(run.adapter).toBe('plugin:echo');
    const recorded = await readRecording(RECORDING);
    expect(run.exchanges).toHaveLength(recorded.length);
    expect(run.exchanges.every((e) => e.error === null)).toBe(true);
    expect(run.exchanges.map((e) => e.candidate?.status)).toEqual(
      recorded.map((e) => e.response.status),
    );
  });

  it('fails when the module does not export createAdapter', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const module = await writeModule('no-export.mjs', 'export const other = 1;\n');
    const result = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter-module',
      module,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('does not export a createAdapter function');
  });

  it('fails when the module path does not exist', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const result = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter-module',
      join(dir, 'missing.mjs'),
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('missing.mjs does not exist');
  });

  it('fails when createAdapter returns an object without name and send', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const module = await writeModule(
      'bad-shape.mjs',
      'export function createAdapter() { return { name: "bad" }; }\n',
    );
    const result = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter-module',
      module,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('must return an object with a name and a send function');
  });

  it('passes the target, timeout, connections, and settings to the module', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const module = await writeModule(
      'settings.mjs',
      `export async function createAdapter(options) {
  return {
    name: 'settings',
    async send() {
      return { status: 200, headers: {}, latency_ms: 1, body: options };
    },
  };
}
`,
    );
    const out = join(dir, 'settings-run.json');
    const candidateRecording = join(dir, 'settings-candidate.jsonl');
    await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'queue://orders',
      '--out',
      out,
      '--pace',
      'max',
      '--concurrency',
      '3',
      '--timeout-ms',
      '1234',
      '--quiet',
      '--no-preflight',
      '--candidate-recording',
      candidateRecording,
      '--adapter-module',
      module,
      '--adapter-setting',
      'region=eu',
      '--adapter-setting',
      'filter=a=b',
    ]);
    expect(parseRun(await readFile(out, 'utf8')).adapter).toBe('plugin:settings');
    const [sent] = await readRecording(candidateRecording);
    expect(sent?.response.body).toEqual({
      target: 'queue://orders',
      timeoutMs: 1234,
      connections: 3,
      settings: { region: 'eu', filter: 'a=b' },
    });
  });

  it('rejects a setting without an equals sign and settings without a module', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const bare = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter-module',
      ECHO,
      '--adapter-setting',
      'novalue',
    ]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('--adapter-setting novalue is not key=value');
    const orphan = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter-setting',
      'a=b',
    ]);
    expect(orphan.code).toBe(1);
    expect(orphan.err).toContain('--adapter-setting needs --adapter-module');
  });

  it('refuses a module together with the bus adapter', async () => {
    const recording = join(dir, 'one.jsonl');
    await writeFile(recording, ONE());
    const result = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--no-preflight',
      '--adapter',
      'bus',
      '--adapter-module',
      ECHO,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('separate transports');
  });
});

describe('rp shrink --adapter-module', () => {
  it('reproduces and reduces through the module', async () => {
    const exchanges = ['/a', '/b', '/c'].map((path, index) =>
      makeExchange({
        index,
        request: makeRequest({ path }),
        response: jsonResponse({ path }),
        tags: [`t${index}`],
      }),
    );
    const recording = join(dir, 'three.jsonl');
    await writeFile(recording, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // The module answers /b with a body that differs from the recorded one.
    const module = await writeModule(
      'diverge.mjs',
      `export function createAdapter() {
  return {
    name: 'diverge',
    async send(req) {
      const body = req.path === '/b' ? { path: 'changed' } : { path: req.path };
      return { status: 200, headers: { 'content-type': 'application/json' }, latency_ms: 1, body };
    },
  };
}
`,
    );
    const runPath = join(dir, 'diverge-run.json');
    const thresholds = join(dir, 'strict.yaml');
    await writeFile(thresholds, 'correctness:\n  mismatch_rate_max: 0\n');
    const replayed = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'x://y',
      '--out',
      runPath,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--quiet',
      '--no-preflight',
      '--thresholds',
      thresholds,
      '--adapter-module',
      module,
    ]);
    expect(replayed.code).toBe(2);
    const reset = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => reset.listen(0, '127.0.0.1', r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          reset.close(() => r());
        }),
    );
    const resetUrl = `http://127.0.0.1:${(reset.address() as AddressInfo).port}/reset`;
    const reduced = join(dir, 'diverge-reduced.jsonl');
    const shrunk = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      recording,
      '--target',
      'x://y',
      '--reset',
      resetUrl,
      '--out',
      reduced,
      '--adapter-module',
      module,
    ]);
    expect(shrunk.code).toBe(0);
    const run = parseRun(await readFile(runPath, 'utf8'));
    expect(run.reproduction).toMatchObject({ successful: true, reduced_steps: 1 });
    const kept = await readRecording(reduced);
    expect(kept.map((e) => e.request.path)).toEqual(['/b']);
  });
});
