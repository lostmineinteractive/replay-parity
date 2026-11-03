import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  InvariantReportSchema,
  jsonResponse,
  makeExchange,
  makeRequest,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** `rp invariants` with an invariant module, from the command line and from rp.yaml. */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

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

async function rp(args: string[], cwd?: string): Promise<Result> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr, env: {}, cwd: cwd ?? dir });
  return { code, out: stdout.text, err: stderr.text };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-invariants-module-'));
});

/** Holds unless an accepted response has status 201 and the path contains `bad`. */
const MODULE = `
export const name = 'no-bad-creates';
export const version = '0.2.0';
export function parse(exchange) {
  return {
    kind: exchange.request.method === 'GET' ? 'read' : 'write',
    accepted: exchange.response.status < 300,
    sentMs: exchange.offset_ms,
    ackedMs: exchange.offset_ms + exchange.response.latency_ms,
    id: exchange.id,
    path: exchange.request.path,
  };
}
export const stateChanging = ['write'];
export const rules = [
  {
    id: 1,
    name: 'no-bad-create',
    statement: 'No create under a bad path is accepted.',
    check(epoch) {
      const evidence = [];
      let checks = 0;
      for (const c of epoch.commands) {
        if (c.kind !== 'write') continue;
        checks += 1;
        if (c.accepted && c.path.includes('bad')) {
          evidence.push({ subject: c.path, expected: 'rejected', observed: 'accepted', detail: 'a bad create was accepted', exchange_id: c.id });
        }
      }
      if (evidence.length > 0) return { status: 'violated', checks, evidence };
      return checks === 0 ? { status: 'not_applicable', checks, evidence } : { status: 'holds', checks, evidence };
    },
  },
];
`;

describe('rp invariants --module', () => {
  it('evaluates the module rules and records the module hash', async () => {
    const path = join(dir, 'module.mjs');
    await writeFile(path, MODULE);
    const out = join(dir, 'report.json');
    const res = await rp(['invariants', '--recording', RECORDING, '--module', path, '--out', out]);
    expect(res.err).toContain(`wrote ${out}`);
    expect(res.code).toBe(0);
    const sha256 = createHash('sha256').update(MODULE).digest('hex');
    expect(res.out).toContain(`module no-bad-creates 0.2.0 sha256 ${sha256}`);
    expect(res.out).toMatch(/ 1\. holds\s+no-bad-create \(\d+ checks\)/);
    expect(res.out).not.toContain('ledger reads');
    const report = InvariantReportSchema.parse(JSON.parse(await readFile(out, 'utf8')));
    expect(report.module).toEqual({ name: 'no-bad-creates', version: '0.2.0', sha256 });
    expect(report.results).toHaveLength(1);
  });

  it('exits 2 with evidence on a violation', async () => {
    const path = join(dir, 'module-violation.mjs');
    await writeFile(path, MODULE);
    const recording = join(dir, 'bad.jsonl');
    const exchange = makeExchange({
      request: makeRequest({ method: 'POST', path: '/v1/bad' }),
      response: jsonResponse({ ok: true }, 201),
    });
    await writeFile(recording, `${JSON.stringify(exchange)}\n`);
    const res = await rp(['invariants', '--recording', recording, '--module', path]);
    expect(res.code).toBe(2);
    expect(res.out).toContain('violated');
    expect(res.out).toContain(`(exchange ${exchange.id})`);
  });

  it('reads the module from rp.yaml', async () => {
    const path = join(dir, 'from-config.mjs');
    await writeFile(path, MODULE);
    const cwd = await mkdtemp(join(dir, 'config-'));
    await writeFile(join(cwd, 'rp.yaml'), `invariants:\n  module: ${path}\n`);
    const res = await rp(['invariants', '--recording', RECORDING], cwd);
    expect(res.code).toBe(0);
    expect(res.out).toContain('module no-bad-creates 0.2.0');
  });

  it('exits 1 with the loader message for a missing module', async () => {
    const res = await rp([
      'invariants',
      '--recording',
      RECORDING,
      '--module',
      join(dir, 'missing.mjs'),
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`invariant module ${join(dir, 'missing.mjs')} does not exist`);
  });

  it('keeps the built in module as the default', async () => {
    const res = await rp(['invariants', '--recording', RECORDING]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('module order-lifecycle 1.0.0 (built in)');
    expect(res.out).toContain('16 ledger reads, 69 stock reads, 109 order reads');
  });
});

describe('rp invariants --rules', () => {
  const EXAMPLE = join(ROOT, 'examples/invariants/order-lifecycle.yaml');

  it('holds every declarative rule of the example on the demo recording', async () => {
    const res = await rp(['invariants', '--recording', RECORDING, '--rules', EXAMPLE]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('4 hold');
    expect(res.out).toContain('module declarative 1.0.0 sha256 ');
    expect(res.out).toMatch(/ 4\. holds\s+order-status \(\d+ checks\)/);
  });

  it('exits 2 and names the exchange on a violation', async () => {
    const recording = join(dir, 'went-down.jsonl');
    const exchanges = [3, 2].map((version, index) =>
      makeExchange({
        index,
        tags: ['get'],
        request: makeRequest({ path: '/kv/a' }),
        response: jsonResponse({ version }),
      }),
    );
    await writeFile(recording, exchanges.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const rules = join(dir, 'monotonic.yaml');
    await writeFile(rules, "monotonic: [{ path: '$.version', key: 'path:^/kv/(.+)$' }]\n");
    const res = await rp(['invariants', '--recording', recording, '--rules', rules]);
    expect(res.code).toBe(2);
    expect(res.out).toContain('violated');
    expect(res.out).toContain(`(exchange ${exchanges[1]?.id})`);
  });

  it('rejects --module with --rules and names a bad rules file', async () => {
    const both = await rp([
      'invariants',
      '--recording',
      RECORDING,
      '--rules',
      EXAMPLE,
      '--module',
      join(dir, 'module.mjs'),
    ]);
    expect(both.code).toBe(1);
    expect(both.err).toContain('--module and --rules cannot be used together');
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'monotonic: yes\n');
    const res = await rp(['invariants', '--recording', RECORDING, '--rules', bad]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${bad}: `);
  });
});
