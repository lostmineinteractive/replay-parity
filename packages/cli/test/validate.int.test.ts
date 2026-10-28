import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseRun } from '@replay-parity/core';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** rp validate and the preflight of rp replay and rp shrink, against the committed demo recording. */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const DEMO_RULES = join(ROOT, 'demo/diff-rules.yaml');
const DEMO_THRESHOLDS = join(ROOT, 'demo/thresholds.yaml');

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
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-validate-'));
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(divergences: DivergenceSetting = 'on'): Promise<string> {
  const app = buildCandidate({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** A server that answers every request with one status and counts them. */
async function answering(status: number): Promise<{ url: string; count: () => number }> {
  let n = 0;
  const server: Server = createServer((_req, res) => {
    n += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => n };
}

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function file(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

describe('rp validate', () => {
  it('prints one ok line per check and exits 0 when the demo files, the target, and the reset agree', async () => {
    const url = await candidate();
    const res = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--rules',
      DEMO_RULES,
      '--thresholds',
      DEMO_THRESHOLDS,
      '--barrier-tag',
      'list-ledger',
      '--target',
      url,
      '--reset',
      `${url}/admin/reset`,
      '--reference',
      `${url}/healthz`,
    ]);
    expect(res.code).toBe(0);
    expect(res.err).toBe('');
    const lines = res.out.trimEnd().split('\n');
    expect(lines).toContain('ok    config: no file selected and no ./rp.yaml');
    expect(lines).toContain(`ok    recording: ${RECORDING}: 283 exchanges, 9 tags`);
    expect(lines).toContain(`ok    thresholds: ${DEMO_THRESHOLDS} parses`);
    expect(lines).toContain('ok    thresholds: latency.by_tag.adjust-stock names 37 exchanges');
    expect(lines).toContain(
      'ok    thresholds: correctness.by_tag.list-inventory names 53 exchanges',
    );
    expect(lines).toContain(`ok    rules: ${DEMO_RULES} parses`);
    expect(lines).toContain(
      'ok    rules: substitution order_id captures $.order_id from 47 of 48 create-order exchanges',
    );
    expect(lines).toContain('ok    rules: control tag admin-restart names 1 exchange');
    expect(lines).toContain('warn  rules: control tag admin-reset names no exchange');
    expect(lines).toContain('ok    rules: ignore $.created_at matches 152 response bodies');
    expect(lines).toContain('ok    barrier: tag list-ledger names 16 exchanges');
    expect(res.out).toMatch(new RegExp(`ok {4}target: GET ${url}/healthz answered 200 in \\d+ ms`));
    expect(res.out).toMatch(
      new RegExp(`ok {4}reference: GET ${url}/healthz answered 200 in \\d+ ms`),
    );
    expect(res.out).toMatch(
      new RegExp(`ok {4}reset: POST ${url}/admin/reset answered 200 in \\d+ ms`),
    );
    expect(lines.every((l) => /^(ok {4}|warn {2}|error )\w+: /.test(l))).toBe(true);
  });

  it('reports every file problem as an error line and exits 1', async () => {
    const thresholds = await file(
      'bad-thresholds.yaml',
      'latency:\n  by_tag:\n    adjust-stok: { p99_ms: 1 }\ncorrectness:\n  by_tag:\n    list-inventory: { mismatch_rate_max: 0 }\n    nope: { mismatch_rate_max: 0 }\n',
    );
    const rules = await file(
      'bad-rules.yaml',
      [
        'ignore: ["$.created_at", "$.never_there"]',
        'tolerances:',
        '  - { path: "$.total", abs: 0.01 }',
        '  - { path: "$.items[*].weight", abs: 1 }',
        'unordered:',
        '  - { path: "$.items" }',
        'substitutions:',
        '  - name: order_id',
        '    capture: { tag: create-order, path: "$.order_id" }',
        '  - name: missing_path',
        '    capture: { tag: create-order, path: "$.nope" }',
        '  - name: missing_tag',
        '    capture: { tag: no-such-tag, path: "$.id" }',
        'controls:',
        '  tags: [admin-restart, admin-reset]',
        '',
      ].join('\n'),
    );
    const res = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--rules',
      rules,
      '--thresholds',
      thresholds,
      '--barrier-tag',
      'list-ledger',
      '--barrier-tag',
      'no-such-tag',
    ]);
    expect(res.code).toBe(1);
    const lines = res.out.trimEnd().split('\n');
    expect(lines).toContain(
      'error thresholds: latency.by_tag.adjust-stok names a tag the recording does not have',
    );
    expect(lines).toContain(
      'ok    thresholds: correctness.by_tag.list-inventory names 53 exchanges',
    );
    expect(lines).toContain(
      'error thresholds: correctness.by_tag.nope names a tag the recording does not have',
    );
    expect(lines).toContain(
      'error rules: substitution missing_path captures $.nope from tag create-order, but none of its 48 exchanges has a value there',
    );
    expect(lines).toContain(
      'error rules: substitution missing_tag captures from tag no-such-tag, which no exchange carries',
    );
    expect(lines).toContain('warn  rules: ignore $.never_there matches no response body');
    expect(lines).toContain('ok    rules: tolerance $.total matches 152 response bodies');
    expect(lines).toContain('warn  rules: tolerance $.items[*].weight matches no response body');
    expect(lines).toContain('ok    rules: unordered $.items matches 205 response bodies');
    expect(lines).toContain('error barrier: tag no-such-tag is not in the recording');

    const unparseable = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--rules',
      await file('broken-rules.yaml', 'ignore: ["$..deep"]\n'),
      '--thresholds',
      join(dir, 'missing-thresholds.yaml'),
    ]);
    expect(unparseable.code).toBe(1);
    expect(unparseable.out).toMatch(/^error rules: .*broken-rules\.yaml: unsupported JSONPath/m);
    expect(unparseable.out).toMatch(/^error thresholds: .*missing-thresholds\.yaml: ENOENT/m);
    expect(unparseable.out).toContain(`ok    recording: ${RECORDING}: 283 exchanges, 9 tags`);

    const noRecording = await rp(['validate', '--recording', join(dir, 'none.jsonl')]);
    expect(noRecording.code).toBe(1);
    expect(noRecording.out).toMatch(/^error recording: .*none\.jsonl/m);

    const badConfig = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--config',
      await file('bad-config.yaml', 'replay:\n  targt: x\n'),
    ]);
    expect(badConfig.code).toBe(1);
    expect(badConfig.out).toMatch(
      /^error config: .*bad-config\.yaml: unknown key "targt" at replay/m,
    );
    expect(badConfig.out).toContain(`ok    recording: ${RECORDING}: 283 exchanges, 9 tags`);

    const goodConfig = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--config',
      await file('good-config.yaml', 'replay:\n  concurrency: 2\n  quiet: true\n'),
    ]);
    expect(goodConfig.code).toBe(0);
    expect(goodConfig.out).toMatch(/^ok {4}config: .*good-config\.yaml, 2 values in effect/m);
  });

  it('probes the URLs within the limit and reports an unreachable target, a 5xx, and a reset that is not 2xx', async () => {
    const port = await closedPort();
    const down = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--target',
      `http://127.0.0.1:${port}`,
      '--reset',
      `http://127.0.0.1:${port}/admin/reset`,
    ]);
    expect(down.code).toBe(1);
    expect(down.out).toMatch(
      new RegExp(
        `^error target: GET http://127\\.0\\.0\\.1:${port}/healthz failed: .*\\(5000 ms limit\\)$`,
        'm',
      ),
    );
    expect(down.out).toMatch(
      new RegExp(`^error reset: POST http://127\\.0\\.0\\.1:${port}/admin/reset failed: `, 'm'),
    );

    const failing = await answering(503);
    const notFound = await answering(404);
    const res = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--target',
      failing.url,
      '--reference',
      `${notFound.url}/status`,
      '--reset',
      `${notFound.url}/admin/reset`,
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toContain(`error target: GET ${failing.url}/healthz answered 503`);
    // Any status under 500 counts as reachable, and the given path is used when there is one.
    expect(res.out).toMatch(
      new RegExp(`ok {4}reference: GET ${notFound.url}/status answered 404 in \\d+ ms`),
    );
    expect(res.out).toContain(
      `error reset: POST ${notFound.url}/admin/reset answered 404, expected 2xx`,
    );
    expect(failing.count()).toBe(1);
    expect(notFound.count()).toBe(2);

    const invalid = await rp(['validate', '--recording', RECORDING, '--target', 'not a url']);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain('error target: not a url is not a valid URL');
  });
});

describe('the preflight of rp replay and rp shrink', () => {
  it('fails rp replay with exit 1 before anything is sent, unless --no-preflight', async () => {
    const target = await answering(200);
    const thresholds = await file(
      'preflight-thresholds.yaml',
      'latency:\n  by_tag:\n    no-such-tag: { p99_ms: 10 }\n',
    );
    const out = join(dir, 'preflight.json');
    const res = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      target.url,
      '--pace',
      'max',
      '--thresholds',
      thresholds,
      '--rules',
      DEMO_RULES,
      '--out',
      out,
      '--quiet',
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toBe('');
    expect(res.err).toBe(
      [
        'preflight: error thresholds: latency.by_tag.no-such-tag names a tag the recording does not have',
        'preflight: warn  rules: control tag admin-reset names no exchange',
        'preflight failed, nothing was sent. rp validate prints every check, --no-preflight skips them.',
        '',
      ].join('\n'),
    );
    expect(target.count()).toBe(0);
    await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);

    const skipped = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      target.url,
      '--pace',
      'max',
      '--thresholds',
      thresholds,
      '--rules',
      DEMO_RULES,
      '--out',
      out,
      '--quiet',
      '--no-preflight',
    ]);
    expect(skipped.code).toBe(3);
    expect(skipped.err).not.toContain('preflight:');
    expect(target.count()).toBe(283);
    const run = parseRun(await readFile(out, 'utf8'));
    expect(run.threshold_results.find((r) => r.scope === 'no-such-tag')?.outcome).toBe(
      'inconclusive',
    );
  }, 60_000);

  it('probes the target of rp replay only with --preflight-probe', async () => {
    const port = await closedPort();
    const out = join(dir, 'probe.json');
    const base = [
      'replay',
      '--recording',
      RECORDING,
      '--target',
      `http://127.0.0.1:${port}`,
      '--pace',
      'max',
      '--limit',
      '3',
      '--out',
      out,
      '--quiet',
    ];
    const probed = await rp([...base, '--preflight-probe']);
    expect(probed.code).toBe(1);
    expect(probed.err).toMatch(
      /^preflight: error target: GET http:\/\/127\.0\.0\.1:\d+\/healthz failed: /m,
    );
    expect(probed.err).toContain('nothing was sent');
    // Without the probe the replay runs and the unreachable target shows up as errors in the run.
    const unprobed = await rp(base);
    expect(unprobed.code).toBe(0);
    expect(parseRun(await readFile(out, 'utf8')).stats.overall.errors).toBe(3);
  });

  it('runs the same checks at the start of rp shrink', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = join(dir, 'shrink-run.json');
    const replayed = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      url,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      DEMO_RULES,
      '--out',
      runPath,
      '--quiet',
      '--invariants',
    ]);
    expect(replayed.code).toBe(2);
    const base = ['shrink', '--run', runPath, '--recording', RECORDING, '--target', url];
    const badTag = await rp([...base, '--reset', `${url}/admin/reset`, '--barrier-tag', 'nope']);
    expect(badTag.code).toBe(1);
    expect(badTag.err).toContain('preflight: error barrier: tag nope is not in the recording');
    expect(badTag.err).not.toContain('attempt 1');
    const badReset = await rp([...base, '--reset', `${url}/admin/nope`, '--preflight-probe']);
    expect(badReset.code).toBe(1);
    expect(badReset.err).toContain(
      `preflight: error reset: POST ${url}/admin/nope answered 404, expected 2xx`,
    );
    expect(badReset.err).not.toContain('attempt 1');
    const skipped = await rp([
      ...base,
      '--reset',
      `${url}/admin/reset`,
      '--barrier-tag',
      'nope',
      '--no-preflight',
      '--max-attempts',
      '1',
      '--out',
      join(dir, 'shrink-reduced.jsonl'),
    ]);
    expect(skipped.code).toBe(0);
    expect(skipped.err).toMatch(/attempt 1 \(confirm, \d+ steps\): reproduced/);
  }, 60_000);
});
