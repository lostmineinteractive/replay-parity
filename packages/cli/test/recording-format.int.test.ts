import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
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

describe('rp capture sampling flags', () => {
  it('warns once that per request sampling may break substitution chains', async () => {
    const capture = await startCapture([
      '--out',
      join(dir, 'per-request.jsonl'),
      '--sample',
      '0.5',
    ]);
    const res = await capture.stop();
    expect(res.code, res.err).toBe(0);
    const warnings = res.err.split('\n').filter((l) => l.includes('substitution chains may break'));
    expect(warnings).toHaveLength(1);
  });

  it('samples by session without the warning and logs the seed', async () => {
    const out = join(dir, 'by-session.jsonl');
    const capture = await startCapture([
      '--out',
      out,
      '--sample',
      '0.5',
      '--sample-by',
      'header:x-session',
      '--sample-seed',
      '9',
    ]);
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (let i = 0; i < 2; i += 1) {
        await fetch(`${capture.url}/${s}/${i}`, { headers: { 'x-session': s } }).then((r) =>
          r.text(),
        );
      }
    }
    const res = await capture.stop();
    expect(res.code, res.err).toBe(0);
    expect(res.err).not.toContain('substitution chains may break');
    expect(res.err).toContain('sampling sessions by header:x-session at 0.5 with seed 9');
    const counts = new Map<string, number>();
    for (const e of await readRecording(out)) {
      const s = e.request.path.split('/')[1] as string;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    for (const n of counts.values()) expect(n).toBe(2);
    expect(await readRecordingManifest(out)).toMatchObject({
      sample: { fraction: 0.5, seed: 9 },
      session_key: 'header:x-session',
    });
  });
});

describe('every rp recording subcommand accepts gzip', () => {
  let gz: string;
  let count: number;
  beforeAll(async () => {
    gz = join(dir, 'demo.jsonl.gz');
    await writeFile(gz, gzipSync(await readFile(DEMO)));
    count = (await readRecording(DEMO)).length;
  });

  it('validate, stats, and scan read it', async () => {
    const validate = await rp(['recording', 'validate', gz]);
    expect(validate.code, validate.err).toBe(0);
    expect(validate.out).toContain(`valid, ${count} exchanges`);
    const stats = await rp(['recording', 'stats', gz, '--json']);
    expect(stats.code, stats.err).toBe(0);
    expect((JSON.parse(stats.out) as { exchanges: number }).exchanges).toBe(count);
    const scan = await rp(['recording', 'scan', gz]);
    expect(scan.code, scan.err).toBe(0);
    expect(scan.out).toContain(`scanned ${count} exchanges`);
  });

  it('filter, sample, split, merge, and migrate read it and write gzip for a .gz output', async () => {
    const filtered = join(dir, 'filtered.jsonl.gz');
    expect(
      (await rp(['recording', 'filter', gz, '--out', filtered, '--method', 'POST'])).code,
    ).toBe(0);
    const posts = (await readRecording(filtered)).length;
    expect(posts).toBeGreaterThan(0);
    expect(posts).toBe(
      (await readRecording(DEMO)).filter((e) => e.request.method === 'POST').length,
    );

    const sampled = join(dir, 'sampled.jsonl');
    const sample = await rp([
      'recording',
      'sample',
      gz,
      '--out',
      sampled,
      '--fraction',
      '0.5',
      '--seed',
      '1',
    ]);
    expect(sample.code, sample.err).toBe(0);

    const parts = join(dir, 'parts');
    const split = await rp(['recording', 'split', gz, '--out-dir', parts, '--every', '100']);
    expect(split.code, split.err).toBe(0);
    const names = (await readdir(parts)).sort();
    expect(names[0]).toBe('demo-0001.jsonl.gz');

    const merged = join(dir, 'merged.jsonl');
    const merge = await rp([
      'recording',
      'merge',
      ...names.map((n) => join(parts, n)),
      '--out',
      merged,
    ]);
    expect(merge.code, merge.err).toBe(0);
    expect(await readRecording(merged)).toHaveLength(count);

    const migrated = join(dir, 'migrated.jsonl.gz');
    expect((await rp(['recording', 'migrate', gz, '--out', migrated])).code).toBe(0);
    expect(await readRecording(migrated)).toEqual(await readRecording(DEMO));
    expect(await readRecordingManifest(migrated)).not.toBeNull();
  });
});

describe('rp capture limits, rotation, and gzip', () => {
  it('ends by itself after --max-exchanges with the same close as a signal', async () => {
    const out = join(dir, 'limited.jsonl');
    const capture = await startCapture(['--out', out, '--max-exchanges', '2']);
    for (let i = 0; i < 2; i += 1) await fetch(`${capture.url}/l/${i}`).then((r) => r.text());
    const res = await capture.done;
    expect(res.code, res.err).toBe(0);
    expect(res.err).toContain('capture reached --max-exchanges 2, closing');
    expect(res.err).toContain('capture closed: 2 requests seen, 2 recorded');
    expect(await readRecording(out)).toHaveLength(2);
  });

  it('ends by itself after --duration', async () => {
    const out = join(dir, 'timed.jsonl');
    const capture = await startCapture(['--out', out, '--duration', '100']);
    const res = await capture.done;
    expect(res.code, res.err).toBe(0);
    expect(res.err).toContain('capture reached --duration 100 ms, closing');
  });

  it('writes gzip parts with --gzip and --rotate-bytes and names them', async () => {
    const sub = await mkdtemp(join(dir, 'rotate-'));
    const out = join(sub, 'cap.jsonl');
    const capture = await startCapture([
      '--out',
      out,
      '--gzip',
      '--rotate-bytes',
      '600',
      '--max-exchanges',
      '4',
    ]);
    for (let i = 0; i < 4; i += 1) await fetch(`${capture.url}/r/${i}`).then((r) => r.text());
    const res = await capture.done;
    expect(res.code, res.err).toBe(0);
    const names = (await readdir(sub)).sort();
    expect(names.length).toBeGreaterThan(1);
    expect(names.every((n) => /^cap\.\d{4}\.jsonl\.gz$/.test(n))).toBe(true);
    expect(res.err).toContain(`wrote ${names.length} parts`);
    let total = 0;
    for (const n of names) {
      expect((await readRecordingManifest(join(sub, n)))?.part).toBe(Number(n.slice(4, 8)));
      total += (await readRecording(join(sub, n))).length;
    }
    expect(total).toBe(4);
    const validate = await rp(['recording', 'validate', join(sub, names[1] as string)]);
    expect(validate.out).toContain('part 2');
  });
});
