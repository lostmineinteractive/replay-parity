import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { InvariantReportSchema, parseRecordingText, type Exchange } from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** The key value store example module through `rp invariants --module`. */

const ROOT = resolve(import.meta.dirname, '../../..');
const MODULE = join(ROOT, 'examples/invariants/key-value-store.mjs');
const RECORDING = join(ROOT, 'examples/invariants/key-value-store.jsonl');

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
let exchanges: Exchange[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-kv-invariants-'));
  exchanges = parseRecordingText(await readFile(RECORDING, 'utf8'));
});

/** Writes a copy of the example recording with `edit` applied, and returns its path. */
async function variant(name: string, edit: (log: Exchange[]) => void): Promise<string> {
  const log = structuredClone(exchanges);
  edit(log);
  const path = join(dir, name);
  await writeFile(path, log.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return path;
}

function at(log: Exchange[], i: number): Exchange {
  return log[i] as Exchange;
}

async function evaluate(recording: string) {
  const out = join(dir, 'report.json');
  const res = await rp(['invariants', '--recording', recording, '--module', MODULE, '--out', out]);
  const report = InvariantReportSchema.parse(JSON.parse(await readFile(out, 'utf8')));
  const byName = (name: string) => report.results.find((r) => r.name === name);
  return { res, report, byName };
}

describe('the key value store example module', () => {
  it('holds every rule on the example recording', async () => {
    const { res, report } = await evaluate(RECORDING);
    expect(res.code).toBe(0);
    const sha256 = createHash('sha256')
      .update(await readFile(MODULE))
      .digest('hex');
    expect(report.module).toEqual({ name: 'key-value-store', version: '1.0.0', sha256 });
    expect(report.exchanges).toBe(15);
    expect(report.commands).toBe(7);
    expect(report.results.map((r) => [r.id, r.name, r.status])).toEqual([
      [1, 'put-returns-version', 'holds'],
      [2, 'get-latest-version', 'holds'],
      [3, 'delete-then-404', 'holds'],
      [4, 'versions-never-backwards', 'holds'],
    ]);
    expect(report.results.every((r) => r.checks > 0)).toBe(true);
  });

  it('catches a stale get and names the exchange', async () => {
    const path = await variant('stale.jsonl', (log) => {
      at(log, 3).response.body = { key: 'alpha', value: 'a1', version: 1 };
    });
    const { res, report, byName } = await evaluate(path);
    expect(res.code).toBe(2);
    expect(report.violations).toBe(2);
    const id = at(exchanges, 3).id;
    expect(byName('get-latest-version')?.evidence).toEqual([
      {
        subject: 'key alpha',
        expected: { version: 2, value: 'a2' },
        observed: { version: 1, value: 'a1' },
        detail: `the get did not show the last put, exchange ${at(exchanges, 2).id}`,
        exchange_id: id,
      },
    ]);
    expect(byName('versions-never-backwards')?.evidence[0]?.exchange_id).toBe(id);
    expect(res.out).toContain(`(exchange ${id})`);
  });

  it('catches a deleted key that is still found and a put without a version', async () => {
    const path = await variant('undead.jsonl', (log) => {
      at(log, 7).response.status = 200;
      at(log, 7).response.body = { key: 'alpha', value: 'a2', version: 2 };
      at(log, 13).response.body = { key: 'beta', value: 'b2' };
    });
    const { res, byName } = await evaluate(path);
    expect(res.code).toBe(2);
    expect(byName('delete-then-404')?.evidence[0]).toMatchObject({
      expected: 'status 404',
      observed: 'status 200',
      exchange_id: at(exchanges, 7).id,
    });
    expect(byName('put-returns-version')?.evidence[0]?.exchange_id).toBe(at(exchanges, 13).id);
  });

  it('is inconclusive when a get overlapped a put to the same key', async () => {
    const path = await variant('overlap.jsonl', (log) => {
      at(log, 2).response.latency_ms = 150;
    });
    const { res, byName } = await evaluate(path);
    expect(res.code).toBe(3);
    expect(byName('get-latest-version')?.status).toBe('inconclusive');
    expect(byName('get-latest-version')?.detail).toContain(
      `${at(exchanges, 3).id} overlapped write ${at(exchanges, 2).id}`,
    );
  });
});
