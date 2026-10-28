import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { MockModelClient, PRICES_AS_OF, PRICING_MAX_AGE_DAYS } from '@replay-parity/agent';
import {
  compileRunValidator,
  makeRun,
  parseRun,
  readRecording,
  writeRun,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentCommand, type AgentCommandHooks } from '../src/commands/agent.js';
import { NO_KEY_MESSAGE, runCli } from '../src/index.js';

/**
 * The agent command's flags. The no key path and the help go through
 * `runCli`. The flags that need a model client go through the same
 * `agentCommand` that `runCli` builds, with a mock client factory, because
 * `runCli` takes no hooks.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

const NEW_FLAGS = [
  '--pricing',
  '--no-fallbacks',
  '--export-recording',
  '--reset-between-cases',
  '--reset-reference',
  '--case-concurrency',
];

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

async function rp(args: string[]): Promise<Result> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr });
  return { code, out: stdout.text, err: stderr.text };
}

/** Parses `args` with the agent command the way `runCli` does, with hooks. */
async function rpAgent(args: string[], hooks: AgentCommandHooks): Promise<Result> {
  const stdout = new Sink();
  const stderr = new Sink();
  let code = 0;
  const command = agentCommand(
    { stdout, stderr },
    new AbortController().signal,
    (c) => {
      code = c;
    },
    hooks,
  )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: (text) => {
        stderr.write(text);
      },
    });
  await command.parseAsync(args, { from: 'user' });
  return { code, out: stdout.text, err: stderr.text };
}

/** A server that counts the POSTs it receives. */
function counter(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    let count = 0;
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST') count += 1;
        res.writeHead(204);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolveServer({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/reset`,
        count: () => count,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

const roundingCase = {
  hypothesis: 'a half cent total rounds differently',
  tags: ['create-order'],
  steps: [{ request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 3 } } }],
};
const unknownCase = {
  hypothesis: 'an unknown order id answers 200 instead of 404',
  tags: ['get-order'],
  steps: [{ request: { method: 'GET', path: '/v1/orders/o-does-not-exist' } }],
};

let validate: RunValidator;
let dir: string;
let refUrl: string;
let candUrl: string;
const savedKey = process.env.ANTHROPIC_API_KEY;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
  dir = await mkdtemp(join(tmpdir(), 'rp-cli-agent-'));
  const ref = buildReference();
  const cand = buildCandidate({ divergences: 'on', seed: 1 });
  await ref.listen({ port: 0, host: '127.0.0.1' });
  await cand.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(
    () => ref.close(),
    () => cand.close(),
  );
  refUrl = `http://127.0.0.1:${(ref.server.address() as AddressInfo).port}`;
  candUrl = `http://127.0.0.1:${(cand.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function freshRun(name: string): Promise<string> {
  const path = join(dir, name);
  await writeRun(path, makeRun());
  return path;
}

describe('rp agent flags', () => {
  it('lists the new flags with a description each', async () => {
    const help = await rp(['agent', '--help']);
    expect(help.code).toBe(0);
    for (const flag of NEW_FLAGS) {
      const line = help.out.split('\n').find((l) => l.includes(`${flag} `) || l.endsWith(flag));
      expect(line, flag).toBeDefined();
      const after = (line as string).split(flag)[1] ?? '';
      expect(after.replace(/<[^>]*>|\[[^\]]*\]/g, '').trim().length, flag).toBeGreaterThan(5);
    }
    expect(help.out).toContain('--no-fallbacks');
  });

  it('prints the no key message and exits 0 through the cli, with the new flags accepted', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const runPath = await freshRun('no-key.json');
    const before = await readFile(runPath, 'utf8');
    const result = await rp([
      'agent',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--reference',
      'http://127.0.0.1:9',
      '--env',
      join(dir, 'none.env'),
      '--no-fallbacks',
      '--case-concurrency',
      '2',
      '--pricing',
      join(dir, 'nope.json'),
      '--export-recording',
      join(dir, 'never.jsonl'),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(NO_KEY_MESSAGE);
    expect(result.out).toContain(`Looked for a .env file at ${join(dir, 'none.env')}.`);
    expect(result.err).toBe('');
    expect(await readFile(runPath, 'utf8')).toBe(before);
    const badValue = await rp([
      'agent',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--reference',
      'http://127.0.0.1:9',
      '--case-concurrency',
      '0',
    ]);
    expect(badValue.code).toBe(1);
    expect(badValue.err).toContain('expected a positive integer');
  });

  it('fails the preflight with exit 1 when the thresholds name a tag the recording lacks', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    const runPath = await freshRun('preflight.json');
    const thresholds = join(dir, 'preflight-thresholds.yaml');
    await writeFile(thresholds, 'latency:\n  by_tag:\n    no-such-tag: { p99_ms: 10 }\n', 'utf8');
    const args = [
      'agent',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--reference',
      'http://127.0.0.1:9',
      '--env',
      join(dir, 'none.env'),
      '--thresholds',
      thresholds,
    ];
    const failed = await rp(args);
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/preflight: error thresholds: .*no-such-tag/);
    expect(failed.err).toMatch(/preflight failed, no case was sent/);
    // With the checks skipped the command proceeds to the systems, which refuse the connection.
    const skipped = await rp([
      ...args,
      '--no-preflight',
      '--max-rounds',
      '1',
      '--budget-usd',
      '0.01',
    ]);
    expect(skipped.err).not.toMatch(/preflight failed/);
  });

  it('rejects a missing pricing file with exit 1 through the cli before any call is made', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    const runPath = await freshRun('bad-pricing.json');
    const result = await rp([
      'agent',
      '--run',
      runPath,
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--reference',
      'http://127.0.0.1:9',
      '--env',
      join(dir, 'none.env'),
      '--pricing',
      join(dir, 'nope.json'),
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^rp: .*nope\.json/);
  });

  it('threads pricing, fallbacks, resets, concurrency, and the export through the command', async () => {
    const pricing = join(dir, 'prices.json');
    await writeFile(
      pricing,
      JSON.stringify({
        'claude-sonnet-5-5': { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
      }),
    );
    const candidateReset = await counter();
    const referenceReset = await counter();
    cleanups.push(candidateReset.close, referenceReset.close);
    const runPath = await freshRun('isolated.json');
    const exported = join(dir, 'agent-cases.jsonl');
    const seen: { apiKey: string; model: string; fallbacks: boolean; timeoutMs: number }[] = [];
    const hooks: AgentCommandHooks = {
      env: { ANTHROPIC_API_KEY: 'test-key-not-real' },
      clientFactory: (apiKey, model, options) => {
        seen.push({ apiKey, model, ...options });
        return new MockModelClient(
          [JSON.stringify({ cases: [roundingCase, unknownCase] }), JSON.stringify({ cases: [] })],
          { model, usage: { input_tokens: 5000, output_tokens: 1000 } },
        );
      },
      // A clock past the table's age limit, so the warning prints.
      now: () =>
        new Date(
          Date.parse(`${PRICES_AS_OF}T00:00:00Z`) + (PRICING_MAX_AGE_DAYS + 10) * 86_400_000,
        ),
    };
    const result = await rpAgent(
      [
        '--run',
        runPath,
        '--recording',
        RECORDING,
        '--target',
        candUrl,
        '--reference',
        refUrl,
        '--out',
        join(dir, 'isolated-cases.jsonl'),
        '--cases-per-round',
        '4',
        '--max-rounds',
        '2',
        '--env',
        join(dir, 'none.env'),
        '--pricing',
        pricing,
        '--no-fallbacks',
        '--export-recording',
        exported,
        '--reset-between-cases',
        candidateReset.url,
        '--reset-reference',
        referenceReset.url,
        '--case-concurrency',
        '3',
      ],
      hooks,
    );
    expect(result.code).toBe(0);
    expect(seen).toEqual([
      {
        apiKey: 'test-key-not-real',
        model: 'claude-sonnet-5-5',
        fallbacks: false,
        timeoutMs: 120_000,
      },
    ]);
    // The staleness warning is printed once, before the loop starts.
    const warnings = result.err.split('\n').filter((l) => l.includes('the price table is from'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      `agent: the price table is from ${PRICES_AS_OF}, ${PRICING_MAX_AGE_DAYS + 10} days old; costs may be out of date`,
    );
    expect(result.err.indexOf('the price table is from')).toBeLessThan(
      result.err.indexOf('round 1'),
    );
    expect(result.err).toContain('cases run one at a time because a reset is set');
    expect(result.out).toContain('kept 2');
    expect(result.out).toContain('isolation: reset before every case, 1 case at a time');
    expect(result.out).toContain(`wrote ${exported} with 2 exchanges from the kept cases`);
    // Two cases executed, one reset on each system before each.
    expect(candidateReset.count()).toBe(2);
    expect(referenceReset.count()).toBe(2);
    // The custom table priced both calls.
    expect(result.out).toContain(`cost: $${((2 * (5000 * 1 + 1000 * 2)) / 1_000_000).toFixed(4)}`);
    expect(result.out).not.toContain('test-key-not-real');
    expect(result.err).not.toContain('test-key-not-real');

    const transcript = JSON.parse(await readFile(join(dir, 'agent-transcript.json'), 'utf8')) as {
      pricing_as_of: string;
      pricing_assumed: boolean;
      pricing_path: string;
      isolation: { reset_between_cases: boolean; case_concurrency: number };
      rounds: { estimator: string; schema_constrained: boolean; fallback_ran: boolean }[];
    };
    expect(transcript.pricing_as_of).toBe(PRICES_AS_OF);
    expect(transcript.pricing_assumed).toBe(false);
    expect(transcript.pricing_path).toBe(pricing);
    expect(transcript.isolation).toEqual({ reset_between_cases: true, case_concurrency: 1 });
    expect(transcript.rounds.map((r) => r.estimator)).toEqual(['heuristic', 'heuristic']);
    expect(transcript.rounds[0]).toMatchObject({ schema_constrained: false, fallback_ran: false });

    const back = await readRecording(exported);
    expect(back.map((e) => e.id)).toEqual(['case-1-1:1', 'case-1-2:1']);
    expect(back.map((e) => e.tags)).toEqual([
      ['create-order', 'agent:case-1-1'],
      ['get-order', 'agent:case-1-2'],
    ]);
    expect(back[0]?.request.body).toEqual({ sku: 'A-100', qty: 3 });
    expect(back[1]?.response.status).toBe(404);
    const updated = parseRun(await readFile(runPath, 'utf8'));
    expect(updated.agent?.kept).toBe(2);
    expect(validate(updated), validate.errors ?? '').toBe(true);

    // Without resets the requested concurrency applies and the export is written even when empty.
    const second = await rpAgent(
      [
        '--run',
        await freshRun('parallel.json'),
        '--recording',
        RECORDING,
        '--target',
        candUrl,
        '--reference',
        refUrl,
        '--out',
        join(dir, 'parallel-cases.jsonl'),
        '--max-rounds',
        '1',
        '--env',
        join(dir, 'none.env'),
        '--export-recording',
        join(dir, 'parallel.jsonl'),
        '--case-concurrency',
        '2',
      ],
      {
        env: { ANTHROPIC_API_KEY: 'test-key-not-real' },
        clientFactory: (_apiKey, model, options) => {
          expect(options.fallbacks).toBe(true);
          return new MockModelClient([JSON.stringify({ cases: [] })], { model });
        },
      },
    );
    expect(second.code).toBe(0);
    expect(second.out).toContain('isolation: no reset, 2 cases at a time');
    expect(second.out).toContain(`wrote ${join(dir, 'parallel.jsonl')} with 0 exchanges`);
    expect(second.err).not.toContain('the price table is from');
    expect(await readFile(join(dir, 'parallel.jsonl'), 'utf8')).toBe('');
    expect(candidateReset.count()).toBe(2);
  }, 60_000);
});
