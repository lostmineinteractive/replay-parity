import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { makeRun, parseRun, parseThresholds, writeRun } from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

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
  const code = await runCli(args, { stdout, stderr });
  return { code, out: stdout.text, err: stderr.text };
}

const thresholds = parseThresholds(
  'latency:\n  overall: { p99_ms: 100 }\n  by_tag:\n    get-items: { p50_ms: 5 }\ncorrectness:\n  mismatch_rate_max: 0\nerrors:\n  rate_max: 0.5\n',
);

let dir: string;
let failing: string;
let passing: string;
let inconclusive: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-report-'));
  failing = join(dir, 'failing.json');
  passing = join(dir, 'passing.json');
  inconclusive = join(dir, 'inconclusive.json');
  await writeRun(failing, makeRun({ thresholds }));
  await writeRun(passing, makeRun());
  await writeRun(inconclusive, {
    ...makeRun(),
    verdict: 'inconclusive',
    inconclusive: [{ kind: 'barrier_timeout', detail: 'list-ledger waited 10000 ms' }],
  });
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('rp report formats', () => {
  it('renders junit to stdout and to a file', async () => {
    const run = parseRun(await readFile(failing, 'utf8'));
    const stdout = await rp(['report', '--run', failing, '--format', 'junit']);
    expect(stdout.code).toBe(0);
    expect(stdout.err).toBe('');
    expect(stdout.out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(
      true,
    );
    expect(stdout.out).toContain(`<property name="run_id" value="${run.run_id}"/>`);
    for (const row of run.threshold_results) {
      expect(stdout.out).toContain(`<testcase classname="${row.section}" name="${row.id}"`);
    }
    expect(stdout.out).toContain(
      '<testcase classname="run" name="verdict" time="0.3">\n      <failure message="verdict fail: 2 threshold rows failed, 0 invariant violations"',
    );
    const file = join(dir, 'junit.xml');
    const written = await rp(['report', '--run', failing, '--format', 'junit', '--out', file]);
    expect(written.code).toBe(0);
    expect(written.out).toBe('');
    expect(written.err).toContain(`wrote ${file} (junit): FAIL`);
    expect(await readFile(file, 'utf8')).toBe(stdout.out);
  });

  it('renders markdown to stdout and to a file', async () => {
    const run = parseRun(await readFile(failing, 'utf8'));
    const stdout = await rp(['report', '--run', failing, '--format', 'markdown']);
    expect(stdout.code).toBe(0);
    expect(stdout.out.startsWith(`# replay-parity: FAIL (run ${run.run_id})\n`)).toBe(true);
    expect(stdout.out).toContain('## Thresholds');
    expect(stdout.out).toContain('| fail | `latency.by_tag.get-items.p50_ms` | 5 | 12.007 |  |');
    expect(stdout.out).toContain('| `$.total` | 1 | 1 |');
    expect(stdout.out).not.toMatch(/<[a-z!/][^>]*>/i);
    const file = join(dir, 'summary.md');
    const written = await rp(['report', '--run', failing, '--format', 'markdown', '--out', file]);
    expect(written.code).toBe(0);
    expect(written.err).toContain(`wrote ${file} (markdown): FAIL`);
    expect(await readFile(file, 'utf8')).toBe(stdout.out);
  });

  it('rejects an unknown format and documents the new ones in help', async () => {
    const bad = await rp(['report', '--run', failing, '--format', 'sarif']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("option '--format <name>' argument 'sarif' is invalid");
    const help = await rp(['report', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('junit');
    expect(help.out).toContain('markdown');
    expect(help.out).toContain('--fail-on-verdict');
    expect(help.out).toContain('0 pass, 2 fail, 3 inconclusive');
  });
});

describe('rp report --fail-on-verdict', () => {
  it('exits with the verdict code after writing the output, and 0 without the flag', async () => {
    for (const [path, code, label] of [
      [passing, 0, 'PASS'],
      [failing, 2, 'FAIL'],
      [inconclusive, 3, 'INCONCLUSIVE'],
    ] as const) {
      const plain = await rp(['report', '--run', path, '--format', 'terminal']);
      expect(plain.code, label).toBe(0);
      expect(plain.out).toContain(`: ${label}`);

      const gated = await rp([
        'report',
        '--run',
        path,
        '--format',
        'terminal',
        '--fail-on-verdict',
      ]);
      expect(gated.code, label).toBe(code);
      expect(gated.out).toBe(plain.out);

      const file = join(dir, `${label}.html`);
      const written = await rp(['report', '--run', path, '--out', file, '--fail-on-verdict']);
      expect(written.code, label).toBe(code);
      expect(written.err).toContain(`wrote ${file} (html): ${label}`);
      expect((await readFile(file, 'utf8')).startsWith('<!doctype html>')).toBe(true);

      const junit = await rp(['report', '--run', path, '--format', 'junit', '--fail-on-verdict']);
      expect(junit.code, label).toBe(code);
      expect(junit.out).toContain(`<property name="verdict" value="${label.toLowerCase()}"/>`);
    }
  });

  it('applies to --explain as well', async () => {
    const explained = await rp(['report', '--run', failing, '--explain', '--fail-on-verdict']);
    expect(explained.code).toBe(2);
    expect(explained.out).toContain('The responses mismatch.');
    const unknown = await rp([
      'report',
      '--run',
      failing,
      '--explain',
      'nope',
      '--fail-on-verdict',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('rp: exchange nope is not in the run');
  });
});

describe('the demo run', () => {
  it('renders a Markdown summary under 150 lines and a JUnit case per row and rule', async () => {
    const app = buildCandidate({ divergences: 'on', seed: 1 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const target = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const runPath = join(dir, 'demo.json');
    const replayed = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      target,
      '--pace',
      'max',
      '--concurrency',
      '1',
      '--rules',
      DEMO_RULES,
      '--thresholds',
      DEMO_THRESHOLDS,
      '--barrier-tag',
      'list-ledger',
      '--invariants',
      '--out',
      runPath,
      '--quiet',
    ]);
    expect(replayed.code).toBe(2);
    const run = parseRun(await readFile(runPath, 'utf8'));
    expect(run.verdict).toBe('fail');

    const md = await rp(['report', '--run', runPath, '--format', 'markdown', '--fail-on-verdict']);
    expect(md.code).toBe(2);
    const lines = md.out.split('\n');
    expect(lines.length).toBeLessThan(150);
    expect(md.out).toContain(`# replay-parity: FAIL (run ${run.run_id})`);
    expect(md.out).toContain('| fail | `correctness.by_tag.list-inventory.mismatch_rate_max` |');
    expect(md.out).toContain('| `$.total` |');
    expect(md.out).toContain('- reference: 10 hold');
    expect(md.out).toContain('- candidate: ');

    const xml = await rp(['report', '--run', runPath, '--format', 'junit', '--fail-on-verdict']);
    expect(xml.code).toBe(2);
    const rules =
      (run.invariants.reference?.results.length ?? 0) +
      (run.invariants.candidate?.results.length ?? 0);
    expect(rules).toBe(20);
    expect(xml.out.match(/<testcase /g)).toHaveLength(run.threshold_results.length + rules + 1);
    expect(xml.out).toContain('<testsuite name="invariants.reference" tests="10" failures="0"');
    expect(xml.out).toContain('<testsuite name="invariants.candidate" tests="10"');
    expect(xml.out).toContain('<failure message="verdict fail: ');
  }, 60_000);
});
