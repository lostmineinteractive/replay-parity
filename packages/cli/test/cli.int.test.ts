import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseRecordingText,
  parseRun,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockModelClient } from '@replay-parity/agent';
import { CLI_VERSION, NO_KEY_MESSAGE, runAgentCommand, runCli } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const MAIN = join(ROOT, 'packages/cli/src/main.ts');
const PACKAGE_JSON = join(ROOT, 'packages/cli/package.json');

const RULES = `
ignore: ["$.created_at"]
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`;

// Every command takes the configuration flags.
const CONFIG_FLAGS = ['--config', '--profile'];
/** The progress flags of the commands that run long. */
const PROGRESS_FLAGS = ['--progress', '--progress-every', '--heartbeat-ms'];
/** The options of the program itself, listed in the top level help. */
const GLOBAL_FLAGS = ['--log-level', '--log-format'];

const FLAGS: Record<string, string[]> = {
  capture: [
    '--listen',
    '--target',
    '--out',
    '--tag-rule',
    '--sample',
    '--redact-header',
    '--redact-query',
    '--max-body-bytes',
    '--no-append',
    '--upstream-timeout-ms',
    '--tls-cert',
    '--tls-key',
    '--upstream-ca',
    '--upstream-cert',
    '--upstream-key',
    '--upstream-insecure',
    '--upstream-servername',
    ...PROGRESS_FLAGS,
    ...CONFIG_FLAGS,
  ],
  replay: [
    '--recording',
    '--target',
    '--out',
    '--pace',
    '--rps',
    '--concurrency',
    '--warmup',
    '--filter',
    '--limit',
    '--no-include-dependencies',
    '--max-gap-ms',
    '--rules',
    '--thresholds',
    '--adapter',
    '--bus-url',
    '--header',
    '--headers-file',
    '--query',
    '--barrier-tag',
    '--barrier-timeout-ms',
    '--candidate-recording',
    '--invariants',
    '--timeout-ms',
    '--max-body-bytes',
    '--quiet',
    '--no-preflight',
    '--preflight-probe',
    '--bus-group',
    '--bus-consumer',
    '--adapter-module',
    '--adapter-setting',
    '--http-proxy',
    '--upstream-ca',
    '--upstream-cert',
    '--upstream-key',
    '--upstream-insecure',
    '--upstream-servername',
    ...PROGRESS_FLAGS,
    '--trace',
    '--metrics-port',
    ...CONFIG_FLAGS,
  ],
  report: ['--run', '--out', '--format', '--explain', '--fail-on-verdict', ...CONFIG_FLAGS],
  invariants: ['--recording', '--out', '--system', ...CONFIG_FLAGS],
  shrink: [
    '--run',
    '--recording',
    '--target',
    '--reset',
    '--reset-url',
    '--reset-command',
    '--reset-module',
    '--reset-health',
    '--reset-timeout-ms',
    '--targets',
    '--cache',
    '--latency-repeat',
    '--rule',
    '--rules',
    '--max-attempts',
    '--time-budget-ms',
    '--out',
    '--header',
    '--headers-file',
    '--query',
    '--barrier-tag',
    '--timeout-ms',
    '--no-preflight',
    '--preflight-probe',
    '--adapter-module',
    '--adapter-setting',
    '--http-proxy',
    '--upstream-ca',
    '--upstream-cert',
    '--upstream-key',
    '--upstream-insecure',
    '--upstream-servername',
    ...PROGRESS_FLAGS,
    ...CONFIG_FLAGS,
  ],
  agent: [
    '--run',
    '--recording',
    '--target',
    '--reference',
    '--rules',
    '--thresholds',
    '--out',
    '--cases-per-round',
    '--model',
    '--budget-usd',
    '--max-rounds',
    '--header',
    '--headers-file',
    '--timeout-ms',
    '--env',
    ...CONFIG_FLAGS,
  ],
  validate: [
    '--recording',
    '--rules',
    '--thresholds',
    '--target',
    '--reference',
    '--reset',
    '--barrier-tag',
    ...CONFIG_FLAGS,
  ],
  doctor: ['--target', '--reference', '--reset', ...CONFIG_FLAGS],
  compare: ['--format', ...CONFIG_FLAGS],
};

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, signal });
  return { code, out: stdout.text, err: stderr.text };
}

let validate: RunValidator;
let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
  dir = await mkdtemp(join(tmpdir(), 'rp-cli-'));
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('help and usage', () => {
  it('lists the commands and every flag with a description', async () => {
    const top = await rp(['--help']);
    expect(top.code).toBe(0);
    for (const name of Object.keys(FLAGS)) expect(top.out).toContain(`  ${name}`);
    for (const flag of GLOBAL_FLAGS) {
      const line = top.out.split('\n').find((l) => l.includes(`${flag} `));
      expect(line, flag).toBeDefined();
      expect(
        ((line as string).split(flag)[1] ?? '').replace(/<[^>]*>/g, '').trim().length,
      ).toBeGreaterThan(5);
    }
    for (const [name, flags] of Object.entries(FLAGS)) {
      const help = await rp([name, '--help']);
      expect(help.code).toBe(0);
      for (const flag of flags) {
        const line = help.out
          .split('\n')
          .find(
            (l) => l.includes(`${flag} `) || l.includes(`${flag}\n`) || l.trimEnd().endsWith(flag),
          );
        expect(line, `${name} ${flag}`).toBeDefined();
        const after = (line as string).split(flag)[1] ?? '';
        expect(
          after.replace(/<[^>]*>|\[[^\]]*\]/g, '').trim().length,
          `${name} ${flag} has no description`,
        ).toBeGreaterThan(5);
      }
    }
    const version = await rp(['--version']);
    expect(version.code).toBe(0);
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.out.trim()).toBe(pkg.version);
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('exits 1 with a message on an unknown flag, a missing required flag, and a missing file', async () => {
    const unknown = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://x',
      '--bogus',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown option '--bogus'");
    const missingFlag = await rp(['report']);
    expect(missingFlag.code).toBe(1);
    expect(missingFlag.err).toContain("required option '--run <path>' not specified");
    const missingFile = await rp(['report', '--run', join(dir, 'nope.json')]);
    expect(missingFile.code).toBe(1);
    expect(missingFile.err).toMatch(/^rp: .*nope\.json/);
    const badValue = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://x',
      '--concurrency',
      '0',
    ]);
    expect(badValue.code).toBe(1);
    expect(badValue.err).toContain('expected a positive integer');
    const badRule = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://x',
      '--rules',
      join(dir, 'nope.yaml'),
    ]);
    expect(badRule.code).toBe(1);
    expect(badRule.err).toMatch(/^rp: .*nope\.yaml/);
  });
});

describe('replay and report', () => {
  it('exits 2 on a failing run, 0 on a passing run, and 3 on an inconclusive run', async () => {
    const thresholds = join(dir, 'thresholds.yaml');
    await writeFile(
      thresholds,
      'latency:\n  by_tag:\n    adjust-stock: { p99_ms: 30 }\ncorrectness:\n  by_tag:\n    list-inventory: { mismatch_rate_max: 0 }\n',
    );
    const on = await candidate('on');
    const failing = join(dir, 'failing.json');
    const fail = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      on,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      join(dir, 'rules.yaml'),
      '--thresholds',
      thresholds,
      '--out',
      failing,
    ]);
    expect(fail.code).toBe(2);
    expect(fail.out).toContain(': FAIL');
    expect(fail.out).toContain('latency.by_tag.adjust-stock.p99_ms');
    expect(fail.err).toContain(`wrote ${failing}: FAIL`);
    const run = parseRun(await readFile(failing, 'utf8'));
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(run.recording.path).toBe(RECORDING);

    const off = await candidate('off');
    const passing = join(dir, 'passing.json');
    // The pass case is gated on the correctness and error rows of demo/thresholds.yaml and on no
    // latency row. The candidate runs in this process, so a stall of the worker is measured as
    // its latency, and the adjust-stock p99 row of the file above failed with stalls of 7 to
    // 10 s when other suites ran at the same time on a shared machine. The latency gates are
    // proven by the fail case above, by packages/replay/test/engine.int.test.ts, and by
    // demo/load/test/demo.int.test.ts.
    const passingThresholds = join(dir, 'passing-thresholds.yaml');
    await writeFile(
      passingThresholds,
      [
        'correctness:',
        '  mismatch_rate_max: 0',
        '  by_tag:',
        '    create-order: { mismatch_rate_max: 0 }',
        '    get-order: { mismatch_rate_max: 0 }',
        '    list-inventory: { mismatch_rate_max: 0 }',
        'errors:',
        '  rate_max: 0',
        '',
      ].join('\n'),
    );
    const pass = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      off,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      join(dir, 'rules.yaml'),
      '--thresholds',
      passingThresholds,
      '--out',
      passing,
      '--quiet',
      '--header',
      'x-run: cli',
      '--barrier-tag',
      'list-ledger',
      '--invariants',
      '--candidate-recording',
      join(dir, 'candidate.jsonl'),
    ]);
    expect(pass.code).toBe(0);
    expect(pass.out).toBe('');
    const passed = parseRun(await readFile(passing, 'utf8'));
    expect(passed.verdict).toBe('pass');
    expect(passed.threshold_results.filter((r) => r.section === 'latency')).toEqual([]);
    expect(passed.threshold_results.map((r) => r.section)).toEqual(
      expect.arrayContaining(['correctness', 'errors']),
    );
    expect(passed.pacing.barrier_tags).toEqual(['list-ledger']);
    expect(passed.invariants.candidate?.violations).toBe(0);
    expect(parseRecordingText(await readFile(join(dir, 'candidate.jsonl'), 'utf8'))).toHaveLength(
      283,
    );

    const thin = join(dir, 'thin.yaml');
    await writeFile(thin, 'latency:\n  min_samples: 1000\n  overall: { p99_ms: 100 }\n');
    const inconclusive = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      off,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--limit',
      '20',
      '--thresholds',
      thin,
      '--out',
      join(dir, 'thin.json'),
      '--quiet',
    ]);
    expect(inconclusive.code).toBe(3);
    expect(inconclusive.err).toContain('INCONCLUSIVE');
  }, 60_000);

  it('stops on a signal, writes the partial run, and exits 3', async () => {
    const off = await candidate('off');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const partial = join(dir, 'partial.json');
    const res = await rp(
      [
        'replay',
        '--recording',
        RECORDING,
        '--target',
        off,
        '--pace',
        'as-recorded',
        '--rules',
        join(dir, 'rules.yaml'),
        '--out',
        partial,
        '--quiet',
      ],
      controller.signal,
    );
    expect(res.code).toBe(3);
    const sent = Number(/replay stopped by signal after (\d+) of 283 exchanges/.exec(res.err)?.[1]);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(283);
    expect(res.err).toContain(`wrote ${partial}: INCONCLUSIVE`);
    const run = parseRun(await readFile(partial, 'utf8'));
    expect(run.verdict).toBe('inconclusive');
    expect(run.inconclusive).toEqual([
      { kind: 'aborted', detail: `stopped by signal after ${sent} of 283 exchanges` },
    ]);
    expect(run.recording.selected).toBe(283);
    expect(run.exchanges).toHaveLength(sent);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('caps recorded gaps with --max-gap-ms and selects dependencies under --filter', async () => {
    const off = await candidate('off');
    const exchanges = [0, 10_000, 10_010].map((offset, i) =>
      makeExchange({
        index: i,
        offset_ms: offset,
        tags: ['list-inventory'],
        request: makeRequest({ path: '/v1/inventory' }),
        response: jsonResponse({ items: [] }),
      }),
    );
    const gappy = join(dir, 'gappy.jsonl');
    await writeFile(gappy, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const capped = join(dir, 'capped.json');
    const res = await rp([
      'replay',
      '--recording',
      gappy,
      '--target',
      off,
      '--max-gap-ms',
      '50',
      '--out',
      capped,
      '--quiet',
    ]);
    expect(res.code).toBe(0);
    expect(res.err).toContain('capped 1 recorded gap at 50 ms');
    const run = parseRun(await readFile(capped, 'utf8'));
    expect(run.pacing).toMatchObject({ max_gap_ms: 50, gaps_capped: 1 });
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 50, 60]);
    const uncapped = await rp([
      'replay',
      '--recording',
      gappy,
      '--target',
      off,
      '--pace',
      'max',
      '--max-gap-ms',
      '0',
      '--out',
      capped,
      '--quiet',
    ]);
    expect(uncapped.err).not.toMatch(/capped \d+ recorded gap/);
    expect(parseRun(await readFile(capped, 'utf8')).pacing).toMatchObject({
      max_gap_ms: null,
      gaps_capped: 0,
    });

    const filtered = join(dir, 'filtered.json');
    const base = [
      'replay',
      '--recording',
      RECORDING,
      '--target',
      off,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      join(dir, 'rules.yaml'),
      '--filter',
      'tag=get-order',
      '--out',
      filtered,
      '--quiet',
    ];
    const withDeps = await rp(base);
    expect(withDeps.err).toContain('selected 44 dependency exchanges');
    const run2 = parseRun(await readFile(filtered, 'utf8'));
    expect(run2.filter).toEqual({ tag: 'get-order', include_dependencies: true, dependencies: 44 });
    expect(run2.exchanges.filter((e) => e.dependency)).toHaveLength(44);
    expect(run2.stats.overall.count).toBe(109);
    const bare = await rp([...base, '--no-include-dependencies']);
    expect(bare.err).not.toContain('dependency');
    expect(parseRun(await readFile(filtered, 'utf8')).filter).toEqual({
      tag: 'get-order',
      include_dependencies: false,
      dependencies: 0,
    });
  }, 60_000);

  it('rejects contradictory replay flags with exit 1', async () => {
    const res = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--pace',
      'fixed-rate',
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('rp: fixed-rate pacing needs --rps');
    const bus = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--adapter',
      'bus',
    ]);
    expect(bus.code).toBe(1);
    expect(bus.err).toContain('--adapter bus needs --bus-url');
  });

  it('renders terminal, html, and json, and explains one or every mismatch', async () => {
    const failing = join(dir, 'failing.json');
    const terminal = await rp(['report', '--run', failing, '--format', 'terminal']);
    expect(terminal.code).toBe(0);
    expect(terminal.out).toContain(': FAIL');
    const html = join(dir, 'report.html');
    const rendered = await rp(['report', '--run', failing, '--out', html]);
    expect(rendered.code).toBe(0);
    expect(rendered.err).toContain(`wrote ${html} (html): FAIL`);
    expect((await readFile(html, 'utf8')).startsWith('<!doctype html>')).toBe(true);
    const json = await rp(['report', '--run', failing, '--format', 'json']);
    expect(json.code).toBe(0);
    expect(validate(JSON.parse(json.out)), validate.errors ?? '').toBe(true);

    const run = parseRun(await readFile(failing, 'utf8'));
    const mismatched = run.exchanges.filter((e) => !e.control && e.diff?.verdict === 'mismatch');
    const first = mismatched[0]!;
    const one = await rp(['report', '--run', failing, '--explain', first.id]);
    expect(one.code).toBe(0);
    expect(one.out.startsWith(`${first.id} ${first.method} ${first.path}`)).toBe(true);
    expect(one.out).toContain('The responses mismatch.');
    expect(one.out.split('\n\n')).toHaveLength(1);
    const all = await rp(['report', '--run', failing, '--explain']);
    expect(all.code).toBe(0);
    for (const e of mismatched) expect(all.out).toContain(`${e.id} ${e.method} ${e.path}`);
    expect(all.out.split('\n\n')).toHaveLength(mismatched.length);
    const unknown = await rp(['report', '--run', failing, '--explain', 'nope']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('rp: exchange nope is not in the run');
  });
});

describe('invariants and shrink', () => {
  it('evaluates the invariants of one recording', async () => {
    const out = join(dir, 'invariants.json');
    const res = await rp([
      'invariants',
      '--recording',
      RECORDING,
      '--system',
      'reference',
      '--out',
      out,
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('invariants for reference');
    expect(res.out).toContain('10 hold');
    expect(res.out).toMatch(/ 1\. holds\s+shipment-applied-once/);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      system: 'reference',
      violations: 0,
    });
  });

  it('shrinks a failing run and updates it in place', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const runPath = join(dir, 'defect.json');
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
    const reduced = join(dir, 'reduced.jsonl');
    const shrunk = await rp([
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
      reduced,
    ]);
    expect(shrunk.code).toBe(0);
    expect(shrunk.out).toMatch(
      /^reduced reproduction: 283 -> \d+ steps in \d+ attempts for invariant:candidate:shipment-applied-once/,
    );
    expect(shrunk.err).toMatch(/attempt 1 \(confirm, \d+ steps\): reproduced/);
    const run = parseRun(await readFile(runPath, 'utf8'));
    expect(run.reproduction).toMatchObject({
      successful: true,
      label: 'reduced reproduction',
      recording: reduced,
    });
    expect(run.reproduction?.reduced_steps).toBeLessThanOrEqual(5);
    expect(parseRecordingText(await readFile(reduced, 'utf8'))).toHaveLength(
      run.reproduction?.reduced_steps ?? -1,
    );
    expect(validate(run), validate.errors ?? '').toBe(true);

    // A signal already aborted spends no attempt, still writes both files, and exits 3.
    const stoppedOut = join(dir, 'reduced-stopped.jsonl');
    const stopped = await rp(
      [
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
        stoppedOut,
      ],
      AbortSignal.abort(),
    );
    expect(stopped.code).toBe(3);
    expect(stopped.err).toContain(
      'shrink stopped by signal after 0 attempts, keeping the best reduction so far',
    );
    expect(stopped.out).toContain('reduction unsuccessful: 283 -> 283 steps in 0 attempts');
    expect(parseRecordingText(await readFile(stoppedOut, 'utf8'))).toHaveLength(283);
    expect(parseRun(await readFile(runPath, 'utf8')).reproduction).toMatchObject({
      attempts: 0,
      successful: false,
      recording: stoppedOut,
    });

    const nothing = await rp([
      'shrink',
      '--run',
      join(dir, 'passing.json'),
      '--recording',
      RECORDING,
      '--target',
      url,
      '--reset',
      `${url}/admin/reset`,
    ]);
    expect(nothing.code).toBe(1);
    expect(nothing.err).toContain('no violated invariant and no mismatched exchange');
  }, 60_000);
});

describe('agent', () => {
  it('prints a message and exits 0 without a key, reading .env only when the variable is unset', async () => {
    const envFile = join(dir, 'empty.env');
    await writeFile(envFile, '# no key here\n');
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runAgentCommand(
      {
        run: join(dir, 'failing.json'),
        recording: RECORDING,
        target: 'http://127.0.0.1:9',
        reference: 'http://127.0.0.1:9',
        out: join(dir, 'generated-cases.jsonl'),
        casesPerRound: 8,
        model: 'claude-sonnet-5-5',
        budgetUsd: 2,
        maxRounds: 3,
        header: [],
        timeoutMs: 1000,
        env: envFile,
      },
      { stdout, stderr },
      {
        env: {},
        clientFactory: () => {
          throw new Error('the client must not be built without a key');
        },
      },
    );
    expect(code).toBe(0);
    expect(stdout.text).toContain(NO_KEY_MESSAGE);
    expect(stdout.text).toContain(`Looked for a .env file at ${envFile}.`);
    expect(stderr.text).toBe('');
  });

  it('stops on a signal, writes the agent section with the aborted stop reason, and exits 3', async () => {
    const runPath = join(dir, 'agent-stopped.json');
    await writeFile(runPath, await readFile(join(dir, 'failing.json'), 'utf8'));
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await runAgentCommand(
      {
        run: runPath,
        recording: RECORDING,
        target: 'http://127.0.0.1:9',
        reference: 'http://127.0.0.1:9',
        out: join(dir, 'stopped-cases.jsonl'),
        casesPerRound: 4,
        model: 'claude-sonnet-5-5',
        budgetUsd: 2,
        maxRounds: 2,
        header: [],
        timeoutMs: 1000,
        env: join(dir, 'key.env'),
      },
      { stdout, stderr },
      {
        env: { ANTHROPIC_API_KEY: 'test-key' },
        clientFactory: (_apiKey, model) =>
          new MockModelClient([JSON.stringify({ cases: [] })], { model }),
      },
      AbortSignal.abort(),
    );
    expect(code).toBe(3);
    expect(stdout.text).toContain('0 of 2 rounds, stopped on aborted');
    expect(stderr.text).toContain('agent stopped by signal at a case boundary');
    const updated = parseRun(await readFile(runPath, 'utf8'));
    expect(updated.agent).toMatchObject({ stop_reason: 'aborted', rounds: 0, executed: 0 });
    expect(validate(updated), validate.errors ?? '').toBe(true);
    expect(await readFile(join(dir, 'stopped-cases.jsonl'), 'utf8')).toBe('');
    expect(
      (
        JSON.parse(await readFile(join(dir, 'agent-transcript.json'), 'utf8')) as {
          stop_reason: string;
        }
      ).stop_reason,
    ).toBe('aborted');
  });

  it('runs the loop with an injected client and adds the agent section to the run', async () => {
    const url = await candidate('on');
    const ref = buildReference();
    await ref.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => ref.close());
    const refUrl = `http://127.0.0.1:${(ref.server.address() as AddressInfo).port}`;
    // Both systems are fresh, so they assign the same ids to the cases.
    const envFile = join(dir, 'key.env');
    await writeFile(envFile, 'ANTHROPIC_API_KEY=test-key-from-file\n');
    const runPath = join(dir, 'agent-run.json');
    await writeFile(runPath, await readFile(join(dir, 'failing.json'), 'utf8'));
    const stdout = new Sink();
    const stderr = new Sink();
    let seenKey = '';
    const code = await runAgentCommand(
      {
        run: runPath,
        recording: RECORDING,
        target: url,
        reference: refUrl,
        out: join(dir, 'cases.jsonl'),
        casesPerRound: 4,
        model: 'claude-sonnet-5-5',
        budgetUsd: 2,
        maxRounds: 2,
        header: [],
        timeoutMs: 5000,
        env: envFile,
      },
      { stdout, stderr },
      {
        env: {},
        clientFactory: (apiKey, model) => {
          seenKey = apiKey;
          return new MockModelClient(
            [
              JSON.stringify({
                cases: [
                  {
                    hypothesis: 'a half cent total rounds differently',
                    tags: ['create-order'],
                    steps: [
                      {
                        request: {
                          method: 'POST',
                          path: '/v1/orders',
                          body: { sku: 'A-100', qty: 3 },
                        },
                      },
                    ],
                  },
                ],
              }),
              JSON.stringify({ cases: [] }),
            ],
            { model },
          );
        },
      },
    );
    expect(code).toBe(0);
    expect(seenKey).toBe('test-key-from-file');
    expect(stdout.text).toContain(
      'agent: claude-sonnet-5-5, 2 of 2 rounds, stopped on no_valid_cases',
    );
    expect(stdout.text).toContain('kept 1');
    expect(stdout.text).not.toContain('test-key-from-file');
    expect(stderr.text).not.toContain('test-key-from-file');
    const updated = parseRun(await readFile(runPath, 'utf8'));
    expect(updated.agent?.kept).toBe(1);
    expect(updated.agent?.cases[0]?.dedupe_key).toBe('mismatch:$.total');
    expect(validate(updated), validate.errors ?? '').toBe(true);
    const lines = (await readFile(join(dir, 'cases.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const transcript = JSON.parse(await readFile(join(dir, 'agent-transcript.json'), 'utf8')) as {
      rounds: unknown[];
    };
    expect(transcript.rounds).toHaveLength(2);
    expect(JSON.stringify(transcript)).not.toContain('test-key-from-file');
    const html = await rp(['report', '--run', runPath, '--format', 'html']);
    expect(html.out).toContain('id="agent"');
    expect(html.out).toContain('a half cent total rounds differently');
  }, 60_000);
});

describe('capture as a child process', () => {
  it('records traffic and exits cleanly on SIGTERM', async () => {
    const reference = buildReference();
    await reference.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => reference.close());
    const referenceUrl = `http://127.0.0.1:${(reference.server.address() as AddressInfo).port}`;
    const port = await freePort();
    const out = join(dir, 'captured.jsonl');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        MAIN,
        'capture',
        '--listen',
        `127.0.0.1:${port}`,
        '--target',
        referenceUrl,
        '--out',
        out,
        '--tag-rule',
        'GET /v1/inventory=list-inventory',
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const deadline = Date.now() + 20_000;
    while (!stderr.includes('capturing on') && Date.now() < deadline) await sleep(100);
    expect(stderr).toContain(`capturing on 127.0.0.1:${port}`);
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/inventory`);
      expect(res.status).toBe(200);
    }
    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(stderr).toContain('capture closed: 3 requests seen, 3 recorded, 0 failed upstream');
    const recorded = parseRecordingText(await readFile(out, 'utf8'));
    expect(recorded).toHaveLength(3);
    expect(recorded.every((e) => e.tags.includes('list-inventory'))).toBe(true);
  }, 30_000);
});
