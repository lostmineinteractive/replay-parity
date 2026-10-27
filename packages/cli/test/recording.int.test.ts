import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  REDACTED,
  hashRecordingFile,
  jsonResponse,
  makeExchange,
  makeExchangeResult,
  makeRequest,
  makeRun,
  parseRecordingText,
  parseRun,
  writeRun,
  type Exchange,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const RULES = join(ROOT, 'demo/diff-rules.yaml');

/** Every flag of every subcommand, checked for a description in the help. */
const FLAGS: Record<string, string[]> = {
  validate: [],
  stats: ['--json', '--rules'],
  filter: [
    '--out',
    '--tag',
    '--method',
    '--path',
    '--status',
    '--from',
    '--to',
    '--include-dependencies',
    '--rules',
  ],
  sample: ['--out', '--fraction', '--by-session', '--seed'],
  split: ['--out-dir', '--every', '--every-ms'],
  merge: ['--out'],
  scan: ['--json'],
};

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

async function readBack(path: string): Promise<Exchange[]> {
  return parseRecordingText(await readFile(path, 'utf8'));
}

let dir: string;
let demoSha256: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-recording-'));
  demoSha256 = (await hashRecordingFile(RECORDING)).sha256;
});

async function writeExchanges(name: string, exchanges: readonly Exchange[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, exchanges.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return path;
}

describe('rp recording help', () => {
  it('lists the subcommands and describes every flag', async () => {
    const top = await rp(['--help']);
    expect(top.code).toBe(0);
    expect(top.out).toContain('  recording');
    const group = await rp(['recording', '--help']);
    expect(group.code).toBe(0);
    for (const name of Object.keys(FLAGS)) expect(group.out).toContain(`  ${name}`);
    for (const [name, flags] of Object.entries(FLAGS)) {
      const help = await rp(['recording', name, '--help']);
      expect(help.code, name).toBe(0);
      expect(help.out).toContain(`Usage: rp recording ${name}`);
      for (const flag of flags) {
        // Option lines start with the flag; a wrapped description may also mention one.
        const line = help.out.split('\n').find((l) => l.trimStart().startsWith(`${flag} `));
        expect(line, `${name} ${flag}`).toBeDefined();
        const after = (line as string).split(flag)[1] ?? '';
        expect(
          after.replace(/<[^>]*>|\[[^\]]*\]/g, '').trim().length,
          `${name} ${flag} has no description`,
        ).toBeGreaterThan(5);
      }
    }
  });

  it('exits 1 on a missing argument, an unknown flag, and a missing file', async () => {
    const noArg = await rp(['recording', 'validate']);
    expect(noArg.code).toBe(1);
    expect(noArg.err).toContain("missing required argument 'path'");
    const unknown = await rp(['recording', 'stats', RECORDING, '--bogus']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown option '--bogus'");
    const missing = await rp(['recording', 'stats', join(dir, 'nope.jsonl')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^rp: .*nope\.jsonl/);
    const noOut = await rp(['recording', 'filter', RECORDING]);
    expect(noOut.code).toBe(1);
    expect(noOut.err).toContain("required option '--out <path>' not specified");
  });
});

describe('rp recording validate', () => {
  it('accepts the demo recording and exits 0', async () => {
    const res = await rp(['recording', 'validate', RECORDING]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`${RECORDING}: valid, 283 exchanges, offsets 0 to 12849 ms`);
    expect(res.out).toMatch(/get-order\s+109/);
  });

  it('exits 1 with the line of the first problem', async () => {
    const a = makeExchange({ index: 0 });
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, `${JSON.stringify(a)}\n\n{broken\n`);
    const res = await rp(['recording', 'validate', bad]);
    expect(res.code).toBe(1);
    expect(res.out).toContain(`${bad}: invalid at line 3: invalid JSON`);
    expect(res.out).toContain('1 exchanges parsed before the problem');
    const dup = await writeExchanges('dup.jsonl', [a, { ...makeExchange({ index: 1 }), id: a.id }]);
    const repeated = await rp(['recording', 'validate', dup]);
    expect(repeated.code).toBe(1);
    expect(repeated.out).toContain(`invalid at line 2: id ${a.id} repeats`);
  });
});

describe('rp recording stats', () => {
  it('prints a table, and JSON with --json and the producers with --rules', async () => {
    const table = await rp(['recording', 'stats', RECORDING, '--rules', RULES]);
    expect(table.code).toBe(0);
    expect(table.out).toContain(
      '283 exchanges, 2026-10-16T20:50:45.469Z to 2026-10-16T20:50:58.318Z',
    );
    expect(table.out).toContain('offsets 0 to 12849 ms (span 12849 ms)');
    expect(table.out).toContain('largest gap 66 ms after');
    expect(table.out).toMatch(/by method\n\s+GET\s+178\n\s+POST\s+105/);
    expect(table.out).toMatch(/by status class\n\s+2xx\s+270\n\s+4xx\s+13/);
    expect(table.out).toMatch(/response\s+283\s+222\s+690\s+690\s+690/);
    expect(table.out).toMatch(/order_id\s+create-order\s+\$\.order_id\s+47\s+44/);
    const json = await rp(['recording', 'stats', RECORDING, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({
      path: RECORDING,
      exchanges: 283,
      by_method: { GET: 178, POST: 105 },
      producers: [],
    });
  });
});

describe('rp recording filter', () => {
  it('keeps matching exchanges in order with rebased offsets and leaves the input alone', async () => {
    const out = join(dir, 'filtered.jsonl');
    const res = await rp([
      'recording',
      'filter',
      RECORDING,
      '--out',
      out,
      '--tag',
      'get-order',
      '--status',
      '4xx',
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toBe(`kept 8 of 283 exchanges to ${out}\n`);
    const kept = await readBack(out);
    expect(kept).toHaveLength(8);
    expect(kept[0]?.offset_ms).toBe(0);
    expect(kept.every((e) => e.tags.includes('get-order') && e.response.status === 404)).toBe(true);
    expect((await hashRecordingFile(RECORDING)).sha256).toBe(demoSha256);
    const byPath = await rp([
      'recording',
      'filter',
      RECORDING,
      '--out',
      out,
      '--method',
      'post',
      '--path',
      '/v1/orders',
      '--from',
      '1000',
      '--to',
      '5000',
    ]);
    expect(byPath.code).toBe(0);
    const posts = await readBack(out);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((e) => e.request.method === 'POST' && e.request.path === '/v1/orders')).toBe(
      true,
    );
    const bad = await rp(['recording', 'filter', RECORDING, '--out', out, '--status', 'ok']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('rp: status "ok"');
  });

  it('pulls in the producers of substituted values with --include-dependencies', async () => {
    const out = join(dir, 'with-deps.jsonl');
    const missingRules = await rp([
      'recording',
      'filter',
      RECORDING,
      '--out',
      out,
      '--tag',
      'get-order',
      '--include-dependencies',
    ]);
    expect(missingRules.code).toBe(1);
    expect(missingRules.err).toContain('--include-dependencies needs --rules');
    const res = await rp([
      'recording',
      'filter',
      RECORDING,
      '--out',
      out,
      '--tag',
      'get-order',
      '--include-dependencies',
      '--rules',
      RULES,
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toBe(
      `kept 153 of 283 exchanges to ${out}, 44 of them pulled in as producers\n`,
    );
    const kept = await readBack(out);
    expect(kept.filter((e) => e.tags.includes('get-order'))).toHaveLength(109);
    expect(kept.filter((e) => e.tags.includes('create-order'))).toHaveLength(44);
    expect(kept[0]?.offset_ms).toBe(0);
    const offsets = kept.map((e) => e.offset_ms);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});

describe('rp recording sample', () => {
  it('samples per exchange with a seed and by session', async () => {
    const out = join(dir, 'sampled.jsonl');
    const res = await rp([
      'recording',
      'sample',
      RECORDING,
      '--out',
      out,
      '--fraction',
      '0.2',
      '--seed',
      '5',
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(
      new RegExp(`^kept \\d+ of 283 exchanges to .* \\(fraction 0.2, seed 5\\)\\n$`),
    );
    const first = (await readBack(out)).map((e) => e.id);
    expect(first.length).toBeGreaterThan(20);
    expect(first.length).toBeLessThan(100);
    await rp(['recording', 'sample', RECORDING, '--out', out, '--fraction', '0.2', '--seed', '5']);
    expect((await readBack(out)).map((e) => e.id)).toEqual(first);
    const unseeded = await rp([
      'recording',
      'sample',
      RECORDING,
      '--out',
      out,
      '--fraction',
      '0.2',
    ]);
    expect(unseeded.code).toBe(0);
    expect(unseeded.out).toMatch(/seed \d+\)/);

    const sessions = Array.from({ length: 40 }, (_, i) =>
      makeExchange({
        index: i,
        request: makeRequest({ headers: { 'x-session': `s-${i % 4}` } }),
      }),
    );
    sessions.push(makeExchange({ index: 40 }));
    const input = await writeExchanges('sessions.jsonl', sessions);
    const bySession = await rp([
      'recording',
      'sample',
      input,
      '--out',
      out,
      '--fraction',
      '0.5',
      '--seed',
      '2',
      '--by-session',
      'x-session',
    ]);
    expect(bySession.code).toBe(0);
    expect(bySession.out).toContain('4 sessions by x-session, 1 without a key kept');
    const kept = await readBack(out);
    const keptSessions = new Set(
      kept.map((e) => e.request.headers['x-session']).filter((s) => s !== undefined),
    );
    expect(kept).toHaveLength(keptSessions.size * 10 + 1);
    const badFraction = await rp(['recording', 'sample', input, '--out', out, '--fraction', '2']);
    expect(badFraction.code).toBe(1);
    expect(badFraction.err).toContain('expected a number above 0 and at most 1');
  });
});

describe('rp recording split and merge', () => {
  it('splits by count or by time into a directory and merges back by ts', async () => {
    const outDir = join(dir, 'parts');
    const res = await rp(['recording', 'split', RECORDING, '--out-dir', outDir, '--every', '100']);
    expect(res.code).toBe(0);
    expect(res.out).toBe(`split 283 exchanges into 3 parts in ${outDir}\n`);
    expect(res.err).toContain(`wrote ${join(outDir, 'recording-0001.jsonl')}: 100 exchanges`);
    expect(res.err).toContain(`wrote ${join(outDir, 'recording-0003.jsonl')}: 83 exchanges`);
    const second = await readBack(join(outDir, 'recording-0002.jsonl'));
    expect(second).toHaveLength(100);
    expect(second[0]?.offset_ms).toBe(0);

    const timeDir = join(dir, 'windows');
    const byTime = await rp([
      'recording',
      'split',
      RECORDING,
      '--out-dir',
      timeDir,
      '--every-ms',
      '5000',
    ]);
    expect(byTime.code).toBe(0);
    expect(byTime.out).toBe(`split 283 exchanges into 3 parts in ${timeDir}\n`);
    const parts = await Promise.all(
      [1, 2, 3].map((i) => readBack(join(timeDir, `recording-000${i}.jsonl`))),
    );
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(283);
    expect(parts.every((p) => p[0]?.offset_ms === 0)).toBe(true);

    const neither = await rp(['recording', 'split', RECORDING, '--out-dir', outDir]);
    expect(neither.code).toBe(1);
    expect(neither.err).toContain('exactly one of --every and --every-ms');
    const both = await rp([
      'recording',
      'split',
      RECORDING,
      '--out-dir',
      outDir,
      '--every',
      '1',
      '--every-ms',
      '1',
    ]);
    expect(both.code).toBe(1);

    const merged = join(dir, 'merged.jsonl');
    const merge = await rp([
      'recording',
      'merge',
      '--out',
      merged,
      join(outDir, 'recording-0003.jsonl'),
      join(outDir, 'recording-0001.jsonl'),
      join(outDir, 'recording-0002.jsonl'),
    ]);
    expect(merge.code).toBe(0);
    expect(merge.out).toBe(
      `merged 283 exchanges from 3 inputs to ${merged}, 2026-10-16T20:50:45.469Z to 2026-10-16T20:50:58.318Z\n`,
    );
    const original = await readBack(RECORDING);
    const back = await readBack(merged);
    expect(back.map((e) => e.id)).toEqual(original.map((e) => e.id));
    expect(back.map((e) => e.offset_ms)).toEqual(original.map((e) => e.offset_ms));
    expect((await hashRecordingFile(merged)).sha256).toBe(demoSha256);
  });

  it('refuses to merge files whose ids collide', async () => {
    const out = join(dir, 'collision.jsonl');
    const res = await rp(['recording', 'merge', '--out', out, RECORDING, RECORDING]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(
      /^rp: id \S+ appears in both .*recording\.jsonl and .*recording\.jsonl/,
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe('rp recording scan', () => {
  it('reports the demo recording as clean apart from the redacted header', async () => {
    const res = await rp(['recording', 'scan', RECORDING]);
    expect(res.code).toBe(0);
    expect(res.out).toBe(
      `${RECORDING}: scanned 283 exchanges\n  redacted: request.headers:authorization (283)\n  no field looks like personal data\n`,
    );
    const json = await rp(['recording', 'scan', RECORDING, '--json']);
    expect(JSON.parse(json.out)).toEqual({
      path: RECORDING,
      exchanges: 283,
      redacted: [{ location: 'request.headers:authorization', count: 283 }],
      findings: [],
    });
  });

  it('groups what looks like personal data by path with a masked example and exits 0', async () => {
    const input = await writeExchanges('pii.jsonl', [
      makeExchange({
        index: 0,
        request: makeRequest({
          method: 'POST',
          path: '/v1/customers',
          query: { email: 'bob@example.com', token: REDACTED },
          headers: { 'x-api-key': 'k3Jd9fLq2ZxT8vWm4nPb6yRs1cHg7aEu' },
          body: { customer: { email: 'alice@example.com', dob: '1990-01-02' }, ips: ['10.0.0.1'] },
        }),
        response: jsonResponse({ number: 4111111111111111 }),
      }),
      makeExchange({
        index: 1,
        request: makeRequest({ body: { customer: { email: 'carol@example.com' } } }),
      }),
    ]);
    const res = await rp(['recording', 'scan', input]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('redacted: request.query:token (1)');
    expect(res.out).toMatch(/request\.body:\$\.customer\.email\s+email\s+2\s+al\*+om/);
    expect(res.out).toMatch(/request\.body:\$\.customer\.dob\s+date-of-birth\s+1/);
    expect(res.out).toMatch(/request\.body:\$\.ips\[\*\]\s+ipv4\s+1/);
    expect(res.out).toMatch(/request\.headers:x-api-key\s+high-entropy\s+1/);
    expect(res.out).toMatch(/request\.query:email\s+email\s+1/);
    expect(res.out).toMatch(/response\.body:\$\.number\s+luhn-number\s+1\s+41\*+11/);
    expect(res.out).not.toContain('alice@example.com');
    expect(res.out).not.toContain('4111111111111111');
    const json = await rp(['recording', 'scan', input, '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ exchanges: 2 });
  });
});

describe('the recording hash in rp replay and rp shrink', () => {
  it('replay records the hash of the file it read', async () => {
    const runPath = join(dir, 'hashed.json');
    const res = await rp([
      'replay',
      '--recording',
      RECORDING,
      '--target',
      'http://127.0.0.1:9',
      '--pace',
      'max',
      '--limit',
      '1',
      '--timeout-ms',
      '500',
      '--out',
      runPath,
      '--quiet',
    ]);
    expect([0, 2]).toContain(res.code);
    expect(parseRun(await readFile(runPath, 'utf8')).recording.recording_sha256).toBe(demoSha256);
  });

  it('shrink refuses a recording whose hash differs unless told otherwise', async () => {
    // A run with no mismatch and no violation, so a shrink that passes the hash check stops
    // on the rule lookup instead of touching the network.
    const base = makeRun({ exchanges: [makeExchangeResult()] });
    const runPath = join(dir, 'shrink-run.json');
    await writeRun(runPath, {
      ...base,
      recording: { ...base.recording, path: RECORDING, recording_sha256: demoSha256 },
    });
    const other = await writeExchanges('other.jsonl', [makeExchange({ index: 0 })]);
    const otherSha256 = (await hashRecordingFile(other)).sha256;
    const args = (recording: string): string[] => [
      'shrink',
      '--run',
      runPath,
      '--recording',
      recording,
      '--target',
      'http://127.0.0.1:9',
      '--reset',
      'http://127.0.0.1:9/admin/reset',
      '--out',
      join(dir, 'reduced.jsonl'),
    ];
    const refused = await rp(args(other));
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      `rp: ${other} is not the recording the run replayed: the run recorded sha256 ${demoSha256} and the file has ${otherSha256}. Pass --allow-recording-mismatch to shrink it anyway.\n`,
    );
    expect(parseRun(await readFile(runPath, 'utf8')).reproduction).toBeNull();

    const allowed = await rp([...args(other), '--allow-recording-mismatch']);
    expect(allowed.code).toBe(1);
    expect(allowed.err).toContain(
      `warning: ${other} has sha256 ${otherSha256}, the run recorded ${demoSha256}; shrinking it anyway`,
    );
    expect(allowed.err).toContain('no violated invariant and no mismatched exchange');

    const matching = await rp(args(RECORDING));
    expect(matching.code).toBe(1);
    expect(matching.err).not.toContain('sha256');
    expect(matching.err).toContain('no violated invariant and no mismatched exchange');
  });
});
