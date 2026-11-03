import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { jsonResponse, makeExchange, makeRequest, parseRun, type Run } from '@replay-parity/core';
import { buildApp, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

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

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-cli-shrink-'));
  await writeFile(join(dir, 'rules.yaml'), RULES);
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(divergences: DivergenceSetting): Promise<string> {
  const app = buildApp({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** Replays the demo recording against `url` and writes the failing run. */
async function failingRun(url: string, name: string): Promise<string> {
  const runPath = join(dir, `${name}.json`);
  await fetch(`${url}/admin/reset`, { method: 'POST' });
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
    join(dir, 'rules.yaml'),
    '--out',
    runPath,
    '--quiet',
    '--invariants',
  ]);
  expect(replayed.code).toBe(2);
  return runPath;
}

async function readReproduction(runPath: string): Promise<NonNullable<Run['reproduction']>> {
  const run = parseRun(await readFile(runPath, 'utf8'));
  expect(run.reproduction).not.toBeNull();
  return run.reproduction as NonNullable<Run['reproduction']>;
}

/** A script that appends a line to the marker file and POSTs the reset URL. */
async function resetScript(): Promise<string> {
  const script = join(dir, 'reset-script.mjs');
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
const [url, marker] = process.argv.slice(2);
const res = await fetch(url, { method: 'POST' });
if (!res.ok) { console.error('reset answered ' + res.status); process.exit(2); }
appendFileSync(marker, 'reset ' + url + '\\n');
`,
  );
  return script;
}

const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '');

describe('rp shrink reset strategies', () => {
  it('shrinks the demo defect to the same steps through --reset-command as through --reset-url', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const script = await resetScript();
    const marker = join(dir, 'command-marker.txt');
    const viaUrl = await failingRun(url, 'via-url');
    const urlOut = join(dir, 'via-url.jsonl');
    const urlRun = await rp([
      'shrink',
      '--run',
      viaUrl,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-url',
      `${url}/admin/reset`,
      '--out',
      urlOut,
    ]);
    expect(urlRun.code).toBe(0);
    const expected = await readReproduction(viaUrl);

    const viaCommand = await failingRun(url, 'via-command');
    const commandRun = await rp([
      'shrink',
      '--run',
      viaCommand,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-command',
      `"${process.execPath}" "${script}" "${url}/admin/reset" "${marker}"`,
      '--out',
      join(dir, 'via-command.jsonl'),
    ]);
    expect(commandRun.code).toBe(0);
    const actual = await readReproduction(viaCommand);
    expect(actual.steps.map((s) => s.id)).toEqual(expected.steps.map((s) => s.id));
    expect(actual.steps).toEqual(expected.steps);
    expect(actual.attempts).toBe(expected.attempts);
    // The command ran once before every attempt.
    expect(lines(await readFile(marker, 'utf8'))).toHaveLength(actual.attempts);
  }, 120_000);

  it('accepts --reset as an alias of --reset-url and refuses two different URLs', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'alias');
    const both = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset',
      `${url}/admin/reset`,
      '--reset-url',
      `${url}/other`,
    ]);
    expect(both.code).toBe(1);
    expect(both.err).toContain('--reset is an alias of --reset-url; give one of them');
    const same = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset',
      `${url}/admin/reset`,
      '--reset-url',
      `${url}/admin/reset`,
      '--out',
      join(dir, 'alias.jsonl'),
    ]);
    expect(same.code).toBe(0);
  }, 60_000);

  it('requires exactly one strategy', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'exclusive');
    const base = ['shrink', '--run', runPath, '--recording', RECORDING, '--target', url];
    const none = await rp(base);
    expect(none.code).toBe(1);
    expect(none.err).toContain('a reset strategy is required');
    const two = await rp([...base, '--reset-url', `${url}/admin/reset`, '--reset-command', 'true']);
    expect(two.code).toBe(1);
    expect(two.err).toContain(
      'reset strategies are exclusive, got --reset-url and --reset-command',
    );
  }, 60_000);

  it('reports a failing reset command with its text and stderr tail', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'failing');
    const res = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-command',
      'echo cannot restart >&2; exit 7',
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('reset command "echo cannot restart >&2; exit 7" exited with 7');
    expect(res.err).toContain('stderr: cannot restart');
  }, 60_000);

  it('times a reset command out at --reset-timeout-ms', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'timeout');
    const res = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-command',
      'sleep 5',
      '--reset-timeout-ms',
      '300',
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('reset command "sleep 5" timed out after 300 ms');
  }, 60_000);

  it('resets through a module and waits for the health URL after each reset', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'module');
    // The health stand-in answers 503 for 250 ms after every reset, then 200.
    const state = { readyAt: 0, polls: 0, resets: 0 };
    const health = createServer((_req, res) => {
      state.polls += 1;
      res.writeHead(Date.now() >= state.readyAt ? 200 : 503);
      res.end();
    });
    await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          health.close(() => r());
        }),
    );
    const healthUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}/ready`;
    const holder = globalThis as unknown as { __rpReset?: () => Promise<void> };
    holder.__rpReset = async () => {
      state.resets += 1;
      state.readyAt = Date.now() + 250;
      await fetch(`${url}/admin/reset`, { method: 'POST' });
    };
    cleanups.push(() => {
      delete holder.__rpReset;
      return Promise.resolve();
    });
    const module = join(dir, 'reset-module.mjs');
    await writeFile(module, 'export async function reset() { await globalThis.__rpReset(); }\n');
    const started = Date.now();
    const res = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-module',
      module,
      '--reset-health',
      healthUrl,
      '--out',
      join(dir, 'module.jsonl'),
    ]);
    expect(res.code).toBe(0);
    const reproduction = await readReproduction(runPath);
    expect(reproduction.successful).toBe(true);
    expect(state.resets).toBe(reproduction.attempts);
    expect(state.polls).toBeGreaterThan(state.resets);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250 * state.resets - 100);
  }, 60_000);
});

describe('rp shrink value lowering from the rules file', () => {
  it('lowers the listed paths, simplifies the others, and records the changes in the run', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'lowering');
    const rules = join(dir, 'shrink-rules.yaml');
    await writeFile(
      rules,
      `${RULES}shrink:\n  lower: ['$.qty', '$.quantity']\n  simplify: ['$.note', '$.reason']\n`,
    );
    const res = await rp([
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-url',
      `${url}/admin/reset`,
      '--rules',
      rules,
      '--out',
      join(dir, 'lowering.jsonl'),
    ]);
    expect(res.code).toBe(0);
    const reproduction = await readReproduction(runPath);
    expect(reproduction.successful).toBe(true);
    const lowered = reproduction.steps.filter((s) => s.changed !== undefined);
    expect(lowered.length).toBeGreaterThan(0);
    for (const step of lowered) {
      for (const change of step.changed ?? []) {
        expect(['$.qty', '$.quantity']).toContain(change.path);
        expect(change.to).toBeLessThan(change.from as number);
      }
    }
    expect(res.out).toMatch(/\(quantity reduced\)\s*\(changed \$\.qty \d+ -> \d+/);
  }, 60_000);
});

describe('rp shrink --targets', () => {
  it('shrinks against several targets to the same reproduction as one', async () => {
    const a = await candidate(['drop-late-precancel-shipment']);
    const b = await candidate(['drop-late-precancel-shipment']);
    const script = await resetScript();
    const base = (runPath: string): string[] => [
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--out',
      join(dir, 'targets.jsonl'),
    ];
    const singlePath = await failingRun(a, 'targets-single');
    const single = await rp([
      ...base(singlePath),
      '--target',
      a,
      '--reset-url',
      `${a}/admin/reset`,
    ]);
    expect(single.code).toBe(0);
    const expected = await readReproduction(singlePath);

    const byUrl = await failingRun(a, 'targets-url');
    const viaUrls = await rp([
      ...base(byUrl),
      '--targets',
      `${a},${b}`,
      '--reset-url',
      `${a}/admin/reset,${b}/admin/reset`,
    ]);
    expect(viaUrls.code).toBe(0);
    expect(viaUrls.err).toContain('shrinking against 2 targets');
    const urlRepro = await readReproduction(byUrl);
    expect(urlRepro.steps).toEqual(expected.steps);
    expect(urlRepro.attempts).toBe(expected.attempts);

    const byCommand = await failingRun(a, 'targets-command');
    const marker = join(dir, 'targets-marker.txt');
    const viaCommand = await rp([
      ...base(byCommand),
      '--targets',
      `${a},${b}`,
      '--reset-command',
      `"${process.execPath}" "${script}" "{target}/admin/reset" "${marker}"`,
    ]);
    expect(viaCommand.code).toBe(0);
    const commandRepro = await readReproduction(byCommand);
    expect(commandRepro.steps).toEqual(expected.steps);
    const marked = lines(await readFile(marker, 'utf8'));
    expect(marked.some((l) => l.includes(`${a}/admin/reset`))).toBe(true);
    expect(marked.some((l) => l.includes(`${b}/admin/reset`))).toBe(true);
  }, 120_000);

  it('refuses a target list that does not match the resets', async () => {
    const a = await candidate(['shipment-applied-twice']);
    const b = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(a, 'targets-errors');
    const base = ['shrink', '--run', runPath, '--recording', RECORDING];
    const fewResets = await rp([
      ...base,
      '--targets',
      `${a},${b}`,
      '--reset-url',
      `${a}/admin/reset`,
    ]);
    expect(fewResets.code).toBe(1);
    expect(fewResets.err).toContain('--reset-url lists 1 URL for 2 targets; give one per target');
    const noPlaceholder = await rp([...base, '--targets', `${a},${b}`, '--reset-command', 'true']);
    expect(noPlaceholder.code).toBe(1);
    expect(noPlaceholder.err).toContain('--reset-command must contain {target}');
    const both = await rp([
      ...base,
      '--target',
      a,
      '--targets',
      `${a},${b}`,
      '--reset-command',
      'true',
    ]);
    expect(both.code).toBe(1);
    expect(both.err).toContain('give --target or --targets, not both');
    const neither = await rp([...base, '--reset-command', 'true']);
    expect(neither.code).toBe(1);
    expect(neither.err).toContain('--target or --targets is required');
  }, 60_000);
});

describe('rp shrink --cache', () => {
  it('makes no new attempts when the same run is shrunk again', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = await failingRun(url, 'cached');
    const cache = join(dir, 'attempts.jsonl');
    const args = [
      'shrink',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset-url',
      `${url}/admin/reset`,
      '--cache',
      cache,
      '--out',
      join(dir, 'cached.jsonl'),
    ];
    const first = await rp(args);
    expect(first.code).toBe(0);
    const firstRepro = await readReproduction(runPath);
    expect(firstRepro.attempts).toBeGreaterThan(1);
    expect(lines(await readFile(cache, 'utf8'))).toHaveLength(firstRepro.attempts);

    const second = await rp(args);
    expect(second.code).toBe(0);
    const secondRepro = await readReproduction(runPath);
    expect(secondRepro.attempts).toBe(0);
    expect(secondRepro.cache_hits).toBeGreaterThanOrEqual(firstRepro.attempts);
    expect(secondRepro.steps).toEqual(firstRepro.steps);
    expect(secondRepro.successful).toBe(true);
    expect(second.out).toMatch(/in 0 attempts for invariant:.* \(\d+ answered from the cache\)/);
    expect(second.err).toContain('(cached)');
    expect(lines(await readFile(cache, 'utf8'))).toHaveLength(firstRepro.attempts);
  }, 60_000);
});

describe('rp shrink --rule latency', () => {
  // Retried, and the margins are 20 ms either side of the limit, because a shrink attempt with
  // three slow steps reproduces only through a stall: one full run under load judged a three
  // step subset as breaching when the limit sat 10 ms above three slow requests.
  it(
    'shrinks a latency breach to the slow steps and labels it statistical',
    { retry: 2, timeout: 60_000 },
    async () => {
      // The slow route answers after 40 ms times the number of slow requests since the last reset,
      // so three slow requests peak at 120 ms and four at 160 ms, against a limit of 140 ms.
      let slowSeen = 0;
      const server = createServer((req, res) => {
        void (async () => {
          if (req.url === '/reset') slowSeen = 0;
          if (req.url === '/slow') {
            slowSeen += 1;
            await new Promise((r) => setTimeout(r, 40 * slowSeen));
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        })();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      cleanups.push(
        () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const exchanges = Array.from({ length: 12 }, (_, index) =>
        makeExchange({
          index,
          request: makeRequest({ path: index % 2 === 1 ? '/slow' : '/fast' }),
          response: jsonResponse({ ok: true }),
          tags: [index % 2 === 1 ? 'slow' : 'fast'],
        }),
      );
      const recording = join(dir, 'latency.jsonl');
      await writeFile(recording, `${exchanges.map((e) => JSON.stringify(e)).join('\n')}\n`);
      const thresholds = join(dir, 'latency-thresholds.yaml');
      await writeFile(thresholds, 'latency:\n  by_tag:\n    slow: { max_ms: 140 }\n');
      const runPath = join(dir, 'latency-run.json');
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
        '--thresholds',
        thresholds,
        '--out',
        runPath,
        '--quiet',
        '--no-preflight',
      ]);
      expect(replayed.code).toBe(2);

      const res = await rp([
        'shrink',
        '--run',
        runPath,
        '--recording',
        recording,
        '--target',
        url,
        '--reset-url',
        `${url}/reset`,
        '--rule',
        'latency:slow:max',
        '--latency-repeat',
        '2',
        '--out',
        join(dir, 'latency-reduced.jsonl'),
      ]);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(
        /^reduced reproduction \(statistical\): 12 -> 4 steps in \d+ attempts for latency:slow:max/,
      );
      const reproduction = await readReproduction(runPath);
      expect(reproduction).toMatchObject({
        label: 'reduced reproduction (statistical)',
        repeat: 2,
        reduced_steps: 4,
        rule: 'latency:slow:max',
      });
      const run = parseRun(await readFile(runPath, 'utf8'));
      expect(run.reproduction?.steps.every((s) => s.path === '/slow')).toBe(true);

      const noLimit = await rp([
        'shrink',
        '--run',
        runPath,
        '--recording',
        recording,
        '--target',
        url,
        '--reset-url',
        `${url}/reset`,
        '--rule',
        'latency:slow:p50',
      ]);
      expect(noLimit.code).toBe(1);
      expect(noLimit.err).toContain('set no p50_ms limit under latency.by_tag.slow');
    },
  );
});
