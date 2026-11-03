import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  hashRecordingFile,
  manifestLine,
  readRecording,
  readRecordingManifest,
} from '@replay-parity/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** The recording format through the CLI: manifest, migrate, and capture flags. */

const ROOT = resolve(import.meta.dirname, '../../..');
const DEMO = join(ROOT, 'demo/recording.jsonl');
const DEMO_SHA256 = '7cda06869f89dfd093a305fe21162d2f499bd809cf2ac852dc0189124d438503';

class Sink extends Writable {
  text = '';
  private waiters: { pattern: RegExp; resolve: (m: RegExpExecArray) => void }[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    for (const w of [...this.waiters]) {
      const m = w.pattern.exec(this.text);
      if (m !== null) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
    cb();
  }
  /** Resolves with the first match of `pattern` in what has been written, now or later. */
  waitFor(pattern: RegExp): Promise<RegExpExecArray> {
    const m = pattern.exec(this.text);
    if (m !== null) return Promise.resolve(m);
    return new Promise((resolve) => this.waiters.push({ pattern, resolve }));
  }
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function rp(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, env, cwd: dir });
  return { code, out: stdout.text, err: stderr.text };
}

interface RunningCapture {
  url: string;
  stop: () => Promise<Result>;
  done: Promise<Result>;
  stderr: Sink;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** Starts `rp capture` in process on a free port and returns its address once it listens. */
async function startCapture(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunningCapture> {
  const port = await freePort();
  const stdout = new Sink();
  const stderr = new Sink();
  const controller = new AbortController();
  const done = runCli(['capture', '--listen', `127.0.0.1:${port}`, '--target', target, ...args], {
    stdout,
    stderr,
    env,
    cwd: dir,
    signal: controller.signal,
  }).then((code) => ({ code, out: stdout.text, err: stderr.text }));
  const listening = stderr.waitFor(/capturing on [\d.]+:(\d+)/);
  const first = await Promise.race([listening, done]);
  if (!Array.isArray(first)) throw new Error(`capture exited early: ${first.err}`);
  return {
    url: `http://127.0.0.1:${first[1]}`,
    stderr,
    done,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
}

function echo(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, size: Buffer.concat(chunks).byteLength }));
  });
}

let dir: string;
let upstream: Server;
let target: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-recording-format-'));
  upstream = createServer(echo);
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => upstream.close(() => done()));
});

describe('rp recording migrate', () => {
  it('adds a manifest to the demo recording and copies every exchange byte for byte', async () => {
    const out = join(dir, 'demo-migrated.jsonl');
    const res = await rp([
      'recording',
      'migrate',
      DEMO,
      '--out',
      out,
      '--target',
      'http://reference:3000',
      '--tag-rule',
      'POST /v1/orders=create-order',
      '--created-at',
      '2026-10-16T20:50:45.469Z',
    ]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toMatch(/a manifest line and \d+ exchanges copied byte for byte/);
    const manifest = await readRecordingManifest(out);
    expect(manifest).toMatchObject({
      manifest: 1,
      target: 'http://reference:3000',
      tag_rules: ['POST /v1/orders=create-order'],
      created_at: '2026-10-16T20:50:45.469Z',
      redaction: { headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'] },
    });
    const input = await readFile(DEMO);
    const output = await readFile(out);
    const head = Buffer.from(manifestLine(manifest as NonNullable<typeof manifest>));
    expect(output.subarray(head.byteLength).equals(input)).toBe(true);
    expect(await readRecording(out)).toEqual(await readRecording(DEMO));
    expect((await hashRecordingFile(DEMO)).sha256).toBe(DEMO_SHA256);

    const validate = await rp(['recording', 'validate', out]);
    expect(validate.code).toBe(0);
    expect(validate.out).toContain('manifest 1: rp ');
    expect(validate.out).toContain('target http://reference:3000');
  });

  it('refuses a second migration and a bad tag rule', async () => {
    const once = join(dir, 'once.jsonl');
    expect((await rp(['recording', 'migrate', DEMO, '--out', once])).code).toBe(0);
    const twice = await rp(['recording', 'migrate', once, '--out', join(dir, 'twice.jsonl')]);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain('already has a manifest');
    const bad = await rp([
      'recording',
      'migrate',
      DEMO,
      '--out',
      join(dir, 'bad.jsonl'),
      '--tag-rule',
      'nonsense',
    ]);
    expect(bad.code).toBe(1);
  });
});

describe('rp capture writes a manifest', () => {
  it('on a new file, with the tool version and flags', async () => {
    const out = join(dir, 'capture-new.jsonl');
    const capture = await startCapture(['--out', out, '--tag-rule', 'GET /x=x', '--no-append']);
    await fetch(`${capture.url}/x`).then((r) => r.text());
    const res = await capture.stop();
    expect(res.code, res.err).toBe(0);
    const manifest = await readRecordingManifest(out);
    expect(manifest?.tag_rules).toEqual(['GET /x=x']);
    expect(manifest?.target).toBe(target);
    expect(manifest?.tool_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await readRecording(out)).toHaveLength(1);
  });
});
