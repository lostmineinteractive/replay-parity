import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  formatCaptureProgress,
  formatReplayProgress,
  formatShrinkProgress,
  replayEtaMs,
  runCapture,
  runCli,
} from '../src/index.js';

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
  tty = false,
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  stderr.isTTY = tty;
  const code = await runCli(args, { stdout, stderr, env });
  return { code, out: stdout.text, err: stderr.text };
}

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-progress-'));
  await writeFile(join(dir, 'rules.yaml'), 'ignore: ["$.created_at"]\n');
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(divergences: DivergenceSetting = 'off'): Promise<string> {
  const app = buildCandidate({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** A target that answers 200 after `delayMs` and keeps the headers of every request. */
async function stubTarget(
  delayMs = 0,
): Promise<{ url: string; seen: IncomingMessage['headers'][] }> {
  const seen: IncomingMessage['headers'][] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function replayArgs(target: string, out: string, limit: number, ...extra: string[]): string[] {
  return [
    'replay',
    '--recording',
    RECORDING,
    '--target',
    target,
    '--pace',
    'max',
    '--concurrency',
    '1',
    '--limit',
    String(limit),
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

describe('progress lines', () => {
  it('prints a new line per step off a TTY and ends with the final counts', async () => {
    const stub = await stubTarget();
    const res = await rp(
      replayArgs(stub.url, join(dir, 'a.json'), 10, '--progress', '--progress-every', '4'),
    );
    const lines = res.err.split('\n').filter((l) => l.startsWith('replay '));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toMatch(
      /^replay 10\/10 errors \d+ mismatches \d+ inflight 0 [\d.]+ rps elapsed \S+ eta 0s$/,
    );
    expect(lines.some((l) => l.startsWith('replay 4/10 '))).toBe(true);
    expect(res.err).not.toContain('\r');
  });

  it('prints nothing without --progress', async () => {
    const stub = await stubTarget();
    const res = await rp(replayArgs(stub.url, join(dir, 'b.json'), 5));
    expect(res.err).not.toContain('replay 5/5');
  });

  it('redraws one line with a carriage return on a TTY', async () => {
    const stub = await stubTarget();
    const res = await rp(
      replayArgs(stub.url, join(dir, 'c.json'), 6, '--progress', '--progress-every', '2'),
      {},
      true,
    );
    expect(res.err).toContain('\rreplay ');
    expect(res.err).toMatch(/wrote .*c\.json/);
  });

  it('writes progress as info records in the json format', async () => {
    const stub = await stubTarget();
    const res = await rp([
      '--log-format',
      'json',
      ...replayArgs(stub.url, join(dir, 'd.json'), 6, '--progress', '--progress-every', '3'),
    ]);
    const records = res.err
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const progress = records.filter((r) => r.progress === true);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.at(-1)).toMatchObject({
      level: 'info',
      completed: 6,
      total: 6,
      command: 'replay',
    });
  });

  it('prints a heartbeat while nothing completes', async () => {
    const stub = await stubTarget(600);
    const res = await rp(
      replayArgs(stub.url, join(dir, 'e.json'), 1, '--progress', '--heartbeat-ms', '100'),
    );
    const lines = res.err.split('\n').filter((l) => l.startsWith('replay 0/1 '));
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('reads --progress from rp.yaml', async () => {
    const stub = await stubTarget();
    const config = join(dir, 'rp.yaml');
    await writeFile(config, 'replay:\n  progress: true\n  progress-every: 2\n');
    const res = await rp([
      'replay',
      '--config',
      config,
      ...replayArgs(stub.url, join(dir, 'f.json'), 4).slice(1),
    ]);
    expect(res.err).toContain('replay 2/4 ');
  });

  it('shows the capture and shrink flags in help', async () => {
    for (const name of ['capture', 'replay', 'shrink']) {
      const help = await rp([name, '--help']);
      for (const flag of ['--progress ', '--progress-every', '--heartbeat-ms']) {
        expect(help.out, `${name} ${flag}`).toContain(flag);
      }
    }
    const replay = await rp(['replay', '--help']);
    expect(replay.out).toContain('--trace');
    expect(replay.out).toContain('--metrics-port');
    const top = await rp(['--help']);
    expect(top.out).toContain('--log-level');
    expect(top.out).toContain('--log-format');
  });

  it('prints seen, recorded, and failed for a capture', async () => {
    const stub = await stubTarget();
    const port = await freePort();
    const stderr = new Sink();
    const abort = new AbortController();
    const running = runCapture(
      {
        listen: { host: '127.0.0.1', port },
        target: stub.url,
        out: join(dir, 'cap.jsonl'),
        tagRule: [],
        sample: 1,
        redactHeader: [],
        redactQuery: [],
        maxBodyBytes: 1_000_000,
        append: false,
        upstreamTimeoutMs: 2000,
        progress: true,
        progressEvery: 1,
        heartbeatMs: 0,
      },
      { stdout: new Sink(), stderr },
      abort.signal,
    );
    const deadline = Date.now() + 10_000;
    while (!stderr.text.includes('capturing on') && Date.now() < deadline) await sleep(25);
    for (let i = 0; i < 3; i += 1) await fetch(`http://127.0.0.1:${port}/x`);
    await sleep(400);
    abort.abort();
    expect(await running).toBe(0);
    expect(stderr.text).toMatch(/^capture seen 3 recorded 3 failed 0 elapsed /m);
  });

  it('prints attempts for a shrink', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = join(dir, 'defect.json');
    const replayed = await rp(replayArgs(url, runPath, 283, '--invariants'));
    expect(replayed.code).toBe(2);
    const res = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset',
      `${url}/admin/reset`,
      '--out',
      join(dir, 'reduced.jsonl'),
      '--progress',
      '--progress-every',
      '1',
    ]);
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/^shrink \d+ attempts?, best \d+ steps, elapsed /m);
  }, 60_000);
});

describe('trace propagation', () => {
  it('sends one trace id with a span id per exchange and logs the id once', async () => {
    const stub = await stubTarget();
    const res = await rp(replayArgs(stub.url, join(dir, 'g.json'), 6, '--trace'));
    expect(stub.seen).toHaveLength(6);
    const parsed = stub.seen.map((h) =>
      /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(String(h.traceparent)),
    );
    expect(parsed.every((m) => m !== null)).toBe(true);
    const traceIds = new Set(parsed.map((m) => m?.[1]));
    const spanIds = new Set(parsed.map((m) => m?.[2]));
    expect(traceIds.size).toBe(1);
    expect(spanIds.size).toBe(6);
    const logged = res.err.split('\n').filter((l) => l.startsWith('trace id '));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain([...traceIds][0] as string);
  });

  it('turns on with RP_TRACE=1 and stays off otherwise', async () => {
    const on = await stubTarget();
    await rp(replayArgs(on.url, join(dir, 'h.json'), 3), { RP_TRACE: '1' });
    expect(on.seen.every((h) => typeof h.traceparent === 'string')).toBe(true);
    const off = await stubTarget();
    await rp(replayArgs(off.url, join(dir, 'i.json'), 3));
    expect(off.seen.every((h) => h.traceparent === undefined)).toBe(true);
  });

  it('adds the trace id to json records', async () => {
    const stub = await stubTarget();
    const res = await rp([
      '--log-format',
      'json',
      ...replayArgs(stub.url, join(dir, 'j.json'), 2, '--trace'),
    ]);
    const last = JSON.parse(res.err.trim().split('\n').at(-1) as string) as Record<string, unknown>;
    expect(last.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('metrics endpoint', () => {
  it('serves counters, the gauge, and the histogram during the run and closes after it', async () => {
    const stub = await stubTarget(80);
    const port = await freePort();
    const running = rp(
      replayArgs(stub.url, join(dir, 'k.json'), 12, '--metrics-port', String(port)),
    );
    let body = '';
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/metrics`);
        const text = await res.text();
        if (/^rp_exchanges_acked_total [1-9]/m.test(text)) {
          expect(res.headers.get('content-type')).toContain('text/plain');
          body = text;
          break;
        }
      } catch {
        // The server is not up yet.
      }
      await sleep(30);
    }
    const missing = await fetch(`http://127.0.0.1:${port}/other`).catch(() => null);
    if (missing !== null) expect(missing.status).toBe(404);
    const res = await running;
    expect(res.err).toContain(`serving metrics at http://localhost:${port}/metrics`);
    for (const name of [
      'rp_exchanges_sent_total',
      'rp_exchanges_acked_total',
      'rp_exchanges_errors_total',
      'rp_exchanges_mismatches_total',
      'rp_inflight',
      'rp_candidate_latency_ms_bucket',
    ]) {
      expect(body).toContain(name);
    }
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });

  it('exits 1 when the port is taken', async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, r));
    cleanups.push(() => new Promise<void>((r) => holder.close(() => r())));
    const taken = (holder.address() as AddressInfo).port;
    const stub = await stubTarget();
    const res = await rp(
      replayArgs(stub.url, join(dir, 'l.json'), 2, '--metrics-port', String(taken)),
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain(`--metrics-port ${taken}`);
  });
});

describe('progress text', () => {
  const state = {
    completed: 50,
    total: 200,
    errors: 2,
    mismatches: 3,
    inflight: 4,
    scheduleEndMs: 0,
  };

  it('estimates the remaining time from the achieved rate under max pacing', () => {
    expect(replayEtaMs(state, 5000)).toBe(15_000);
    expect(replayEtaMs({ ...state, completed: 200 }, 5000)).toBe(0);
    expect(replayEtaMs({ ...state, completed: 0 }, 1000)).toBeNull();
  });

  it('waits for the recorded schedule when it is longer than the rate predicts', () => {
    expect(replayEtaMs({ ...state, scheduleEndMs: 60_000 }, 5000)).toBe(55_000);
  });

  it('formats the three commands', () => {
    expect(formatReplayProgress(state, 5000)).toMatch(
      /^replay 50\/200 errors 2 mismatches 3 inflight 4 10\.0 rps elapsed \S+ eta \S+$/,
    );
    expect(formatCaptureProgress({ seen: 5, recorded: 4, failed: 1 }, 2000)).toMatch(
      /^capture seen 5 recorded 4 failed 1 elapsed /,
    );
    expect(formatShrinkProgress({ attempts: 1, bestSteps: null }, 1000)).toMatch(
      /^shrink 1 attempt, best \? steps/,
    );
  });
});
