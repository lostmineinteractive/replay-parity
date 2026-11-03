import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  REDACTED,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseRecordingText,
  parseRun,
} from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI_VERSION, runCli } from '../src/index.js';

/**
 * The configuration file, its profiles, the environment variables, secrets
 * through interpolation, query overrides, and rp doctor, through runCli.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const DEMO_CONFIG = join(ROOT, 'demo/rp.yaml');
const EXAMPLE_CONFIG = join(ROOT, 'examples/rp.yaml');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function rp(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<Result> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, env, cwd: cwd ?? dir });
  return { code, out: stdout.text, err: stderr.text };
}

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-config-cli-'));
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(): Promise<string> {
  const app = buildCandidate({ divergences: 'on', seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

/** A stand-in candidate that answers every request and keeps what it saw. */
async function standIn(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function writeRecording(
  name: string,
  query: Record<string, string | string[]> = {},
): Promise<string> {
  const exchanges = [0, 1].map((i) =>
    makeExchange({
      index: i,
      tags: ['ping'],
      request: makeRequest({
        path: '/v1/ping',
        query,
        headers: { authorization: REDACTED, 'x-keep': 'recorded' },
      }),
      response: jsonResponse({ ok: true }),
    }),
  );
  const path = join(dir, name);
  await writeFile(path, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('the configuration file and its layers', () => {
  it('applies the file, the selected profile, the environment, and the command line in that order', async () => {
    const config = join(dir, 'layers.yaml');
    await writeFile(
      config,
      [
        'invariants:',
        `  recording: ${RECORDING}`,
        '  system: from-file',
        'profiles:',
        '  p:',
        '    invariants:',
        '      system: from-profile',
        '',
      ].join('\n'),
    );
    const label = (r: Result): string => /invariants for (\S+)/.exec(r.out)?.[1] ?? '';

    const file = await rp(['invariants', '--config', config]);
    expect(file.code).toBe(0);
    expect(label(file)).toBe('from-file');

    const profile = await rp(['invariants', '--config', config, '--profile', 'p']);
    expect(label(profile)).toBe('from-profile');

    const env = { RP_CONFIG: config, RP_PROFILE: 'p', RP_INVARIANTS_SYSTEM: 'from-env' };
    const fromEnv = await rp(['invariants'], env);
    expect(fromEnv.code).toBe(0);
    expect(label(fromEnv)).toBe('from-env');

    const cli = await rp(['invariants', '--system', 'from-cli'], env);
    expect(label(cli)).toBe('from-cli');

    // ./rp.yaml in the working directory is read when nothing names a file.
    const cwd = await mkdtemp(join(tmpdir(), 'rp-cwd-'));
    await writeFile(
      join(cwd, 'rp.yaml'),
      `invariants:\n  recording: ${RECORDING}\n  system: from-cwd\n`,
    );
    expect(label(await rp(['invariants'], {}, cwd))).toBe('from-cwd');
    // Without a file the required flag is still required.
    const none = await rp(['invariants']);
    expect(none.code).toBe(1);
    expect(none.err).toContain("required option '--recording <path>' not specified");
  });

  it('lets a profile override a list, and the preflight sees the merged value', async () => {
    const url = await candidate();
    const config = join(dir, 'lists.yaml');
    await writeFile(
      config,
      [
        'replay:',
        `  recording: ${RECORDING}`,
        '  pace: max',
        '  concurrency: 1',
        '  barrier-tag: [not-a-tag, also-not]',
        '  quiet: true',
        'profiles:',
        '  ledger:',
        '    replay:',
        '      barrier-tag: [list-ledger]',
        '',
      ].join('\n'),
    );
    const out = join(dir, 'lists.json');
    const top = await rp(['replay', '--config', config, '--target', url, '--out', out]);
    expect(top.code).toBe(1);
    expect(top.err).toContain('preflight: error barrier: tag not-a-tag is not in the recording');
    expect(top.err).toContain('preflight: error barrier: tag also-not is not in the recording');
    const overridden = await rp([
      'replay',
      '--config',
      config,
      '--profile',
      'ledger',
      '--target',
      url,
      '--out',
      out,
    ]);
    expect(overridden.code).toBe(0);
    expect(overridden.out).toBe('');
    expect(parseRun(await readFile(out, 'utf8')).pacing.barrier_tags).toEqual(['list-ledger']);
    // A repeated flag on the command line replaces the list instead of extending it.
    const replaced = await rp([
      'replay',
      '--config',
      config,
      '--target',
      url,
      '--out',
      out,
      '--barrier-tag',
      'list-inventory',
    ]);
    expect(replaced.code).toBe(0);
    expect(parseRun(await readFile(out, 'utf8')).pacing.barrier_tags).toEqual(['list-inventory']);
  }, 60_000);

  it('rejects a bad key, a bad type, a bad value, and a missing profile with exit 1 naming the key', async () => {
    const run = async (text: string, extra: string[] = []): Promise<Result> => {
      const config = join(dir, 'bad.yaml');
      await writeFile(config, text);
      return rp(['invariants', '--recording', RECORDING, '--config', config, ...extra]);
    };
    const badKey = await run('invariants:\n  sytem: x\n');
    expect(badKey.code).toBe(1);
    expect(badKey.err).toMatch(/^rp: .*bad\.yaml: unknown key "sytem" at invariants\n/);
    const badCommand = await run('invarants:\n  system: x\n');
    expect(badCommand.err).toMatch(/unknown key "invarants" at \(root\)/);
    const badType = await run('replay:\n  invariants: 1\n');
    expect(badType.code).toBe(1);
    expect(badType.err).toMatch(/expected true or false at replay\.invariants/);
    const badList = await run('replay:\n  header: "a: 1"\n');
    expect(badList.err).toMatch(/expected a list at replay\.header/);
    // A value goes through the flag's own parser when its command runs.
    const replay = async (text: string): Promise<Result> => {
      const config = join(dir, 'bad.yaml');
      await writeFile(config, text);
      return rp(['replay', '--recording', RECORDING, '--target', 'http://x', '--config', config]);
    };
    const badValue = await replay('replay:\n  concurrency: lots\n');
    expect(badValue.code).toBe(1);
    expect(badValue.err).toMatch(
      /^rp: .*bad\.yaml: replay\.concurrency: expected a positive integer\n/,
    );
    const badChoice = await replay('replay:\n  pace: slow\n');
    expect(badChoice.err).toMatch(
      /replay\.pace: Allowed choices are as-recorded, fixed-rate, max\./,
    );
    // Another command does not run the replay parsers, but rp validate runs every section's.
    const elsewhere = await run('replay:\n  concurrency: lots\n');
    expect(elsewhere.code).toBe(0);
    const validated = await rp([
      'validate',
      '--recording',
      RECORDING,
      '--config',
      join(dir, 'bad.yaml'),
    ]);
    expect(validated.code).toBe(1);
    expect(validated.out).toMatch(
      /^error config: .*bad\.yaml: replay\.concurrency: expected a positive integer$/m,
    );
    const missingProfile = await run('invariants:\n  system: x\nprofiles:\n  a: {}\n', [
      '--profile',
      'nightly',
    ]);
    expect(missingProfile.code).toBe(1);
    expect(missingProfile.err).toMatch(/profile "nightly" is not defined \(defined: a\)/);
    const missingFile = await rp(['invariants', '--recording', RECORDING, '--config', 'nope.yaml']);
    expect(missingFile.code).toBe(1);
    expect(missingFile.err).toMatch(/nope\.yaml: config file not found \(from --config\)/);
    // Help still works with a broken file next to it.
    const help = await rp(['invariants', '--help'], { RP_CONFIG: join(dir, 'bad.yaml') });
    expect(help.code).toBe(0);
    expect(help.out).toContain('--config <path>');
  });

  it('replays the committed recording with demo/rp.yaml and parses examples/rp.yaml', async () => {
    const url = await candidate();
    const out = join(dir, 'demo-unordered.json');
    const res = await rp(
      [
        'replay',
        '--config',
        DEMO_CONFIG,
        '--profile',
        'unordered',
        '--recording',
        RECORDING,
        '--pace',
        'max',
        '--target',
        url,
        '--out',
        out,
        '--quiet',
      ],
      {},
      ROOT,
    );
    expect(res.code).toBe(2);
    expect(res.err).toContain('preflight: warn  rules: control tag admin-reset names no exchange');
    const run = parseRun(await readFile(out, 'utf8'));
    expect(run.verdict).toBe('fail');
    expect(run.pacing).toMatchObject({
      mode: 'max',
      concurrency: 8,
      barrier_tags: ['list-ledger'],
    });
    expect(run.rules.unordered).toEqual([
      { path: '$.items', key: '$.sku', when: { tags: ['list-inventory'] } },
    ]);
    expect(Object.keys(run.thresholds.latency.by_tag)).toContain('adjust-stock');
    expect(run.invariants.candidate).not.toBeNull();
    const inventory = run.threshold_results.find(
      (r) => r.id === 'correctness.by_tag.list-inventory.mismatch_rate_max',
    );
    expect(inventory?.outcome).toBe('pass');

    const strict = await rp(
      [
        'replay',
        '--config',
        DEMO_CONFIG,
        '--profile',
        'strict',
        '--recording',
        RECORDING,
        '--pace',
        'max',
        '--target',
        url,
        '--out',
        out,
        '--quiet',
      ],
      {},
      ROOT,
    );
    expect(strict.code).toBe(2);
    expect(parseRun(await readFile(out, 'utf8')).rules.unordered).toEqual([]);

    // The example file parses with every key. Its doctor section needs variables this
    // test does not set, which the doctor reports as a line and still exits 0.
    const example = await rp(['doctor', '--config', EXAMPLE_CONFIG, '--profile', 'nightly']);
    expect(example.code).toBe(0);
    expect(example.out).toContain('replay:');
    expect(example.out).toContain('  target: ${CANDIDATE_URL}  (file)');
    expect(example.out).toContain('  pace: fixed-rate  (profile nightly)');
    expect(example.out).toContain('  header: [x-env: nightly]  (profile nightly)');
    expect(example.out).toContain(
      `error config: environment variable CANDIDATE_URL is not set (used in ${EXAMPLE_CONFIG}: doctor.target)`,
    );
    // With the variables set, rp validate runs every section through its flag parsers. The
    // example's own validate section names files this test does not have, so the command
    // line overrides them.
    const checked = await rp(
      [
        'validate',
        '--recording',
        RECORDING,
        '--config',
        EXAMPLE_CONFIG,
        '--rules',
        join(ROOT, 'demo/diff-rules.yaml'),
        '--thresholds',
        join(ROOT, 'demo/thresholds.yaml'),
        '--target',
        url,
        '--reference',
        url,
        '--reset',
        `${url}/admin/reset`,
        '--barrier-tag',
        'list-ledger',
      ],
      { CANDIDATE_URL: url, REFERENCE_URL: url, TOKEN: 't', API_KEY: 'k' },
    );
    expect(checked.code).toBe(0);
    expect(checked.out).toMatch(/^ok {4}config: .*examples\/rp\.yaml, \d+ values in effect$/m);
    expect(checked.out).not.toContain('error');
  }, 60_000);
});

describe('secrets through interpolation', () => {
  it('sends a header from ${TOKEN} and writes only the redaction marker', async () => {
    const { url, seen } = await standIn();
    const recording = await writeRecording('secret.jsonl');
    const config = join(dir, 'secret.yaml');
    await writeFile(
      config,
      [
        'replay:',
        `  recording: ${recording}`,
        '  pace: max',
        '  quiet: true',
        '  header:',
        "    - 'authorization: Bearer ${TOKEN}'",
        "    - 'x-env: ${ENV_NAME}'",
        '',
      ].join('\n'),
    );
    const out = join(dir, 'secret.json');
    const candidateRecording = join(dir, 'secret-candidate.jsonl');
    const env = { TOKEN: 'very-secret-token', ENV_NAME: 'staging' };
    const res = await rp(
      [
        'replay',
        '--config',
        config,
        '--target',
        url,
        '--out',
        out,
        '--candidate-recording',
        candidateRecording,
      ],
      env,
    );
    expect(res.code).toBe(0);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.headers.authorization).toBe('Bearer very-secret-token');
      expect(s.headers['x-env']).toBe('staging');
      expect(s.headers['x-keep']).toBe('recorded');
    }
    const runText = await readFile(out, 'utf8');
    expect(runText).not.toContain('very-secret-token');
    expect(runText).not.toContain('Bearer');
    const candidateText = await readFile(candidateRecording, 'utf8');
    expect(candidateText).not.toContain('very-secret-token');
    for (const e of parseRecordingText(candidateText)) {
      expect(e.request.headers.authorization).toBe(REDACTED);
      expect(e.request.headers['x-env']).toBe('staging');
    }
    expect(res.out + res.err).not.toContain('very-secret-token');

    // The same through --header, through a headers file, and with $$ as a literal dollar.
    seen.length = 0;
    const headersFile = join(dir, 'headers.txt');
    await writeFile(headersFile, 'authorization: Bearer ${TOKEN}\nx-cost: $$5\n');
    const flags = await rp(
      [
        'replay',
        '--recording',
        recording,
        '--target',
        url,
        '--pace',
        'max',
        '--out',
        out,
        '--quiet',
        '--headers-file',
        headersFile,
        '--header',
        'x-env: ${ENV_NAME}',
      ],
      env,
    );
    expect(flags.code).toBe(0);
    expect(seen[0]?.headers.authorization).toBe('Bearer very-secret-token');
    expect(seen[0]?.headers['x-cost']).toBe('$5');
    expect(seen[0]?.headers['x-env']).toBe('staging');

    // A missing variable names the variable and the key, and nothing is sent.
    seen.length = 0;
    const missing = await rp(['replay', '--config', config, '--target', url, '--out', out], {
      ENV_NAME: 'staging',
    });
    expect(missing.code).toBe(1);
    expect(missing.err).toBe(
      `rp: environment variable TOKEN is not set (used in ${config}: replay.header)\n`,
    );
    const missingFlag = await rp(
      ['replay', '--recording', recording, '--target', url, '--out', out, '--header', 'x: ${NOPE}'],
      {},
    );
    expect(missingFlag.code).toBe(1);
    expect(missingFlag.err).toBe('rp: environment variable NOPE is not set (used in --header)\n');
    const missingInFile = await rp(
      [
        'replay',
        '--recording',
        recording,
        '--target',
        url,
        '--out',
        out,
        '--headers-file',
        headersFile,
      ],
      {},
    );
    expect(missingInFile.code).toBe(1);
    expect(missingInFile.err).toBe(
      `rp: environment variable TOKEN is not set (used in ${headersFile} (authorization))\n`,
    );
    expect(seen).toHaveLength(0);
  });

  it('applies --query with ${KEY} over a redacted recorded parameter', async () => {
    const { url, seen } = await standIn();
    const recording = await writeRecording('query.jsonl', { api_key: REDACTED, page: '1' });
    const out = join(dir, 'query.json');
    const candidateRecording = join(dir, 'query-candidate.jsonl');
    const res = await rp(
      [
        'replay',
        '--recording',
        recording,
        '--target',
        url,
        '--pace',
        'max',
        '--out',
        out,
        '--quiet',
        '--query',
        'api_key=${KEY}',
        '--query',
        'extra=${EXTRA}',
        '--candidate-recording',
        candidateRecording,
      ],
      { KEY: 'live-key-value', EXTRA: 'e=1' },
    );
    expect(res.code).toBe(0);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      const params = new URL(s.url, url).searchParams;
      expect(params.get('api_key')).toBe('live-key-value');
      expect(params.get('page')).toBe('1');
      expect(params.get('extra')).toBe('e=1');
    }
    expect(await readFile(out, 'utf8')).not.toContain('live-key-value');
    const candidateText = await readFile(candidateRecording, 'utf8');
    expect(candidateText).not.toContain('live-key-value');
    expect(parseRecordingText(candidateText)[0]?.request.query).toEqual({
      api_key: REDACTED,
      page: '1',
      extra: 'e=1',
    });
    // Without the override the redacted parameter is not sent at all.
    seen.length = 0;
    const plain = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      url,
      '--pace',
      'max',
      '--out',
      out,
      '--quiet',
    ]);
    expect(plain.code).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(['/v1/ping?page=1', '/v1/ping?page=1']);
    const bad = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      url,
      '--query',
      'novalue',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('expected name=value');
  });
});

describe('rp doctor', () => {
  it('prints the versions, the configuration in effect with secrets unresolved, and the probes', async () => {
    const url = await candidate();
    const config = join(dir, 'doctor.yaml');
    await writeFile(
      config,
      [
        'replay:',
        "  target: '${CANDIDATE}'",
        "  header: ['authorization: Bearer ${TOKEN}']",
        '  concurrency: 2',
        'shrink:',
        "  reset: '${CANDIDATE}/admin/reset'",
        'profiles:',
        '  fast:',
        '    replay:',
        '      concurrency: 16',
        '',
      ].join('\n'),
    );
    const env = {
      RP_CONFIG: config,
      RP_PROFILE: 'fast',
      RP_REPLAY_QUIET: 'true',
      RP_BOGUS: '1',
      CANDIDATE: url,
      TOKEN: 'doctor-secret',
    };
    const res = await rp(
      [
        'doctor',
        '--target',
        '${CANDIDATE}',
        '--reset',
        '${CANDIDATE}/admin/reset',
        '--reference',
        'http://127.0.0.1:1',
      ],
      env,
    );
    expect(res.code).toBe(0);
    expect(res.err).toBe('');
    const lines = res.out.split('\n');
    expect(lines[0]).toBe(`rp ${CLI_VERSION}`);
    expect(lines[1]).toBe(`node ${process.version}`);
    expect(lines[2]).toBe(`platform ${process.platform} ${process.arch}`);
    expect(lines[3]).toBe(`config: ${config} (from RP_CONFIG)`);
    expect(lines[4]).toBe('profile: fast (from RP_PROFILE)');
    expect(res.out).toContain('replay:\n  target: ${CANDIDATE}  (file)\n');
    expect(res.out).toContain('  header: [authorization: Bearer ${TOKEN}]  (file)\n');
    expect(res.out).toContain('  concurrency: 16  (profile fast)\n');
    expect(res.out).toContain('  quiet: true  (RP_REPLAY_QUIET)\n');
    expect(res.out).toContain('shrink:\n  reset: ${CANDIDATE}/admin/reset  (file)\n');
    expect(res.out).toContain('environment: RP_REPLAY_QUIET\n');
    expect(res.out).toContain('environment not matching any flag: RP_BOGUS\n');
    expect(res.out).toMatch(/ok {4}target: GET \$\{CANDIDATE\}\/healthz answered 200 in \d+ ms/);
    expect(res.out).toMatch(
      /ok {4}reset: POST \$\{CANDIDATE\}\/admin\/reset answered 200 in \d+ ms/,
    );
    expect(res.out).toMatch(/error reference: GET http:\/\/127\.0\.0\.1:1\/healthz failed: /);
    expect(res.out).not.toContain('doctor-secret');
    expect(res.out).not.toContain(url);

    const bare = await rp(['doctor']);
    expect(bare.code).toBe(0);
    expect(bare.out).toContain(
      `config: none (no --config, RP_CONFIG not set, no rp.yaml in ${dir})`,
    );
    expect(bare.out).toContain(
      'profile: none\neffective values: none\nenvironment: no RP_ variable applied\n',
    );
  });
});
