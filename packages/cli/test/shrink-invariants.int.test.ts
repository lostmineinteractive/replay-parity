import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  makeExchange,
  makeRequest,
  parseRun,
  type Exchange,
  type RecordedRequest,
  type RecordedResponse,
} from '@replay-parity/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/**
 * rp shrink with an invariant module. The stand-in is a key value service that
 * forgets to delete, so the module's delete-then-404 rule is violated, and the
 * rule name refers to that module and not to the built in rules.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const MODULE = join(ROOT, 'examples/invariants/key-value-store.mjs');
const RULE = 'delete-then-404';

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
  const code = await runCli(args, { stdout, stderr, env: {} });
  return { code, out: stdout.text, err: stderr.text };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

/** A key value store whose DELETE answers 204 and keeps the key. */
async function forgetfulStore(): Promise<string> {
  const store = new Map<string, { value: unknown; version: number }>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/admin/reset') {
        store.clear();
        return send(204);
      }
      const key = /^\/kv\/([^/?]+)$/.exec(url)?.[1];
      if (key === undefined) return send(404, { error: 'not found' });
      if (req.method === 'PUT') {
        const { value } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value: unknown };
        const existing = store.get(key);
        const version = (existing?.version ?? 0) + 1;
        store.set(key, { value, version });
        return send(existing === undefined ? 201 : 200, { key, value, version });
      }
      if (req.method === 'GET') {
        const found = store.get(key);
        return found === undefined
          ? send(404, { error: 'not found' })
          : send(200, { key, ...found });
      }
      if (req.method === 'DELETE') return send(204);
      return send(405);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function step(
  index: number,
  method: string,
  path: string,
  status: number,
  body: RecordedResponse['body'],
  sent?: RecordedRequest['body'],
): Exchange {
  return makeExchange({
    index,
    tags: [`step-${index}`],
    request: makeRequest({
      method,
      path,
      headers: { 'content-type': 'application/json' },
      ...(sent === undefined ? {} : { body: sent }),
    }),
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      latency_ms: 1,
      ...(body === undefined ? {} : { body }),
    },
  });
}

/** What a correct store answers to this sequence. Seven steps, three of which reproduce the defect. */
const RECORDED: Exchange[] = [
  step(0, 'PUT', '/kv/b', 201, { key: 'b', value: 2, version: 1 }, { value: 2 }),
  step(1, 'PUT', '/kv/a', 201, { key: 'a', value: 1, version: 1 }, { value: 1 }),
  step(2, 'GET', '/kv/b', 200, { key: 'b', value: 2, version: 1 }),
  step(3, 'DELETE', '/kv/a', 204, undefined),
  step(4, 'GET', '/kv/a', 404, { error: 'not found' }),
  step(5, 'PUT', '/kv/c', 201, { key: 'c', value: 3, version: 1 }, { value: 3 }),
  step(6, 'GET', '/kv/c', 200, { key: 'c', value: 3, version: 1 }),
];

let dir: string;
let recording: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-shrink-invariants-'));
  recording = join(dir, 'kv.jsonl');
  await writeFile(recording, RECORDED.map((e) => JSON.stringify(e)).join('\n') + '\n');
});

async function failingRun(url: string, name: string): Promise<string> {
  const runPath = join(dir, `${name}.json`);
  await fetch(`${url}/admin/reset`, { method: 'POST' });
  const replayed = await rp([
    'replay',
    '--recording',
    recording,
    '--target',
    url,
    '--pace',
    'max',
    '--concurrency',
    '1',
    '--invariants-module',
    MODULE,
    '--out',
    runPath,
    '--quiet',
    '--no-preflight',
  ]);
  expect(replayed.code).toBe(2);
  const run = parseRun(await readFile(runPath, 'utf8'));
  const result = run.invariants.candidate?.results.find((r) => r.name === RULE);
  expect(result?.status).toBe('violated');
  return runPath;
}

function shrinkArgs(run: string, url: string, out: string, extra: string[]): string[] {
  return [
    'shrink',
    '--run',
    run,
    '--recording',
    recording,
    '--target',
    url,
    '--reset-url',
    `${url}/admin/reset`,
    '--rule',
    `invariant:candidate:${RULE}`,
    '--out',
    out,
    '--no-preflight',
    ...extra,
  ];
}

describe('rp shrink --invariants-module', () => {
  it('judges the rule against the module and reduces to the put, delete, and get', async () => {
    const url = await forgetfulStore();
    const runPath = await failingRun(url, 'module');
    const out = join(dir, 'module-reduced.jsonl');
    const result = await rp(shrinkArgs(runPath, url, out, ['--invariants-module', MODULE]));
    expect(result.code).toBe(0);
    const run = parseRun(await readFile(runPath, 'utf8'));
    expect(run.reproduction).toMatchObject({
      rule: `invariant:candidate:${RULE}`,
      successful: true,
      original_steps: 7,
      reduced_steps: 3,
    });
    const reduced = (await readFile(out, 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Exchange);
    expect(reduced.map((e) => `${e.request.method} ${e.request.path}`)).toEqual([
      'PUT /kv/a',
      'DELETE /kv/a',
      'GET /kv/a',
    ]);
  });

  it('does not reproduce a module rule against the built in rules', async () => {
    const url = await forgetfulStore();
    const runPath = await failingRun(url, 'builtin');
    const out = join(dir, 'builtin-reduced.jsonl');
    await rp(shrinkArgs(runPath, url, out, []));
    const run = parseRun(await readFile(runPath, 'utf8'));
    expect(run.reproduction?.successful).toBe(false);
    expect(run.reproduction?.label).toBe('reduction unsuccessful');
  });

  it('refuses both --invariants-module and --invariants-rules', async () => {
    const url = await forgetfulStore();
    const runPath = await failingRun(url, 'both');
    const result = await rp(
      shrinkArgs(runPath, url, join(dir, 'both.jsonl'), [
        '--invariants-module',
        MODULE,
        '--invariants-rules',
        join(ROOT, 'examples/invariants/order-lifecycle.yaml'),
      ]),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      '--invariants-module and --invariants-rules cannot be used together',
    );
  });
});
