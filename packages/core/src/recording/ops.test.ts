import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonResponse, makeExchange, makeRequest } from '../testing.js';
import { ConfigError } from '../yaml.js';
import { hashRecordingFile } from './hash.js';
import {
  HIGH_ENTROPY_BITS,
  RecordingScanner,
  bucketOf,
  closeOverProducers,
  compileFilter,
  createRandom,
  detectPatterns,
  detectToken,
  filterExchanges,
  filterRecording,
  iterateRecordingLines,
  luhnValid,
  maskValue,
  mergeRecordings,
  parseStatusSelector,
  partFileName,
  recordingStats,
  sampleRecording,
  scanRecording,
  sessionKeyOf,
  shannonEntropy,
  splitRecording,
  storedBodyBytes,
  summarizeSizes,
  validateRecording,
  writeRebased,
} from './ops.js';
import { RecordingParseError, parseRecordingText } from './reader.js';
import { REDACTED } from './redact.js';
import type { Exchange } from './types.js';

const DEMO = resolve(import.meta.dirname, '../../../../demo/recording.jsonl');
const ORDER_ID_RULE = {
  name: 'order_id',
  capture: { tag: 'create-order', path: '$.order_id' },
  apply: ['path', 'query', 'body'] as ('path' | 'query' | 'body')[],
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-ops-'));
}

async function writeLines(dir: string, name: string, lines: readonly string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

async function writeExchangesTo(
  dir: string,
  name: string,
  exchanges: readonly Exchange[],
): Promise<string> {
  return writeLines(
    dir,
    name,
    exchanges.map((e) => JSON.stringify(e)),
  );
}

async function readBack(path: string): Promise<Exchange[]> {
  return parseRecordingText(await readFile(path, 'utf8'));
}

/** Five exchanges at offsets 0, 100, 150, 1000, 5000 with mixed tags, methods, paths, and statuses. */
function fixture(): Exchange[] {
  return [
    makeExchange({
      index: 0,
      offset_ms: 0,
      tags: ['create-order'],
      request: makeRequest({ method: 'POST', path: '/v1/orders', body: { sku: 'A', qty: 2 } }),
      response: jsonResponse({ order_id: 'o-1' }, 201),
    }),
    makeExchange({
      index: 1,
      offset_ms: 100,
      tags: ['get-order'],
      request: makeRequest({ method: 'GET', path: '/v1/orders/o-1' }),
      response: jsonResponse({ order_id: 'o-1', total: 1 }),
    }),
    makeExchange({
      index: 2,
      offset_ms: 150,
      tags: ['list-inventory'],
      request: makeRequest({ method: 'GET', path: '/v1/inventory', query: { sku: 'A' } }),
      response: jsonResponse({ items: [] }),
    }),
    makeExchange({
      index: 3,
      offset_ms: 1000,
      tags: ['get-order'],
      request: makeRequest({ method: 'GET', path: '/v1/orders/o-9' }),
      response: jsonResponse({ error: 'not found' }, 404),
    }),
    makeExchange({
      index: 4,
      offset_ms: 5000,
      tags: [],
      request: makeRequest({ method: 'DELETE', path: '/v1/orders/o-1' }),
      response: jsonResponse({ order_id: 'o-1' }, 200),
    }),
  ];
}

describe('iterateRecordingLines', () => {
  it('yields each exchange with its line number and skips blank lines', async () => {
    const dir = await tempDir();
    const [a, b] = fixture();
    const path = await writeLines(dir, 'r.jsonl', [JSON.stringify(a), '', JSON.stringify(b)]);
    const seen: number[] = [];
    for await (const { line, exchange } of iterateRecordingLines(path)) {
      seen.push(line);
      expect(exchange.id).toBe(line === 1 ? a?.id : b?.id);
    }
    expect(seen).toEqual([1, 3]);
  });

  it('throws a parse error with the line number on bad JSON and on a decreasing offset', async () => {
    const dir = await tempDir();
    const [a, b] = fixture() as [Exchange, Exchange];
    const bad = await writeLines(dir, 'bad.jsonl', [JSON.stringify(a), '{nope']);
    await expect(collect(iterateRecordingLines(bad))).rejects.toThrow(RecordingParseError);
    await expect(collect(iterateRecordingLines(bad))).rejects.toMatchObject({ line: 2 });
    const back = await writeLines(dir, 'back.jsonl', [
      JSON.stringify(b),
      JSON.stringify({ ...a, offset_ms: 50 }),
    ]);
    await expect(collect(iterateRecordingLines(back))).rejects.toThrow(/line 2: offset_ms 50/);
  });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

describe('validateRecording', () => {
  it('accepts the committed demo recording and counts by tag', async () => {
    const result = await validateRecording(DEMO);
    expect(result).toMatchObject({
      ok: true,
      exchanges: 283,
      problem: null,
      first_offset_ms: 0,
      last_offset_ms: 12_849,
    });
    expect(result.by_tag).toMatchObject({
      'create-order': 48,
      'get-order': 109,
      'admin-restart': 1,
    });
  });

  it('reports the line of the first problem and the counts before it', async () => {
    const dir = await tempDir();
    const [a, b, c] = fixture() as [Exchange, Exchange, Exchange];
    const json = await writeLines(dir, 'json.jsonl', [
      JSON.stringify(a),
      '',
      'oops',
      JSON.stringify(b),
    ]);
    expect(await validateRecording(json)).toMatchObject({
      ok: false,
      exchanges: 1,
      problem: { line: 3, message: expect.stringContaining('invalid JSON') as string },
      by_tag: { 'create-order': 1 },
    });
    const offsets = await writeExchangesTo(dir, 'offsets.jsonl', [b, { ...a, offset_ms: 10 }]);
    expect(await validateRecording(offsets)).toMatchObject({
      ok: false,
      exchanges: 1,
      problem: { line: 2, message: expect.stringContaining('lower than') as string },
    });
    const schema = await writeLines(dir, 'schema.jsonl', [
      JSON.stringify(a),
      JSON.stringify({ ...b, response: { ...b.response, status: 99 } }),
    ]);
    expect((await validateRecording(schema)).problem).toMatchObject({ line: 2 });
    const repeated = await writeExchangesTo(dir, 'ids.jsonl', [a, b, { ...c, id: a.id }]);
    expect(await validateRecording(repeated)).toMatchObject({
      ok: false,
      exchanges: 2,
      problem: {
        line: 3,
        message: `recording line 3: id ${a.id} repeats; it was first seen on line 1`,
      },
    });
  });

  it('accepts an empty file and names a missing one', async () => {
    const dir = await tempDir();
    const empty = await writeLines(dir, 'empty.jsonl', []);
    expect(await validateRecording(empty)).toEqual({
      ok: true,
      exchanges: 0,
      problem: null,
      first_offset_ms: null,
      last_offset_ms: null,
      by_tag: {},
      manifest: null,
    });
    const missing = join(dir, 'missing.jsonl');
    await expect(validateRecording(missing)).rejects.toThrow(ConfigError);
    await expect(validateRecording(missing)).rejects.toThrow(missing);
  });
});

describe('storedBodyBytes and summarizeSizes', () => {
  it('measures the stored body of each kind', () => {
    expect(storedBodyBytes({})).toBeNull();
    expect(storedBodyBytes({ body: { a: 1 } })).toBe(7);
    expect(
      storedBodyBytes({ body: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    ).toBe(5);
    expect(
      storedBodyBytes({ body: Buffer.from('hi').toString('base64'), encoding: 'base64' }),
    ).toBe(2);
    expect(
      storedBodyBytes({ body: Buffer.from('abc').toString('base64'), encoding: 'base64' }),
    ).toBe(3);
    expect(storedBodyBytes({ truncated: true, body_sha256: 'x', body_size: 9000 })).toBe(9000);
  });

  it('takes nearest rank percentiles', () => {
    expect(summarizeSizes([])).toEqual({ count: 0, p50: 0, p90: 0, p99: 0, max: 0 });
    expect(summarizeSizes([7])).toEqual({ count: 1, p50: 7, p90: 7, p99: 7, max: 7 });
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarizeSizes(values)).toEqual({ count: 100, p50: 50, p90: 90, p99: 99, max: 100 });
  });
});

describe('recordingStats', () => {
  it('summarizes the demo recording and counts substitution producers', async () => {
    const stats = await recordingStats(DEMO, { rules: [ORDER_ID_RULE] });
    expect(stats).toMatchObject({
      exchanges: 283,
      untagged: 0,
      first_ts: '2026-10-16T20:50:45.469Z',
      last_ts: '2026-10-16T20:50:58.318Z',
      first_offset_ms: 0,
      last_offset_ms: 12_849,
      span_ms: 12_849,
      largest_gap: { ms: 66, from_offset_ms: 11_546, to_offset_ms: 11_612 },
      by_method: { POST: 105, GET: 178 },
      by_status_class: { '2xx': 270, '4xx': 13 },
      body_bytes: { request: { count: 104 }, response: { count: 283, p50: 222, max: 690 } },
      producers: [
        {
          name: 'order_id',
          tag: 'create-order',
          path: '$.order_id',
          producers: 47,
          distinct_values: 44,
        },
      ],
    });
    expect(Object.values(stats.by_tag).reduce((a, b) => a + b, 0)).toBe(283);
    expect((await recordingStats(DEMO)).producers).toEqual([]);
  });

  it('finds the largest gap, the untagged, and handles an empty file', async () => {
    const dir = await tempDir();
    const path = await writeExchangesTo(dir, 'f.jsonl', fixture());
    const stats = await recordingStats(path);
    expect(stats.largest_gap).toEqual({
      ms: 4000,
      from_offset_ms: 1000,
      to_offset_ms: 5000,
      after_id: (fixture()[3] as Exchange).id,
    });
    expect(stats).toMatchObject({
      untagged: 1,
      by_tag: { 'get-order': 2, 'create-order': 1, 'list-inventory': 1 },
      by_method: { GET: 3, POST: 1, DELETE: 1 },
      by_status_class: { '2xx': 4, '4xx': 1 },
    });
    expect(stats.body_bytes.request.count).toBe(1);
    const empty = await recordingStats(await writeLines(dir, 'empty.jsonl', []));
    expect(empty).toMatchObject({ exchanges: 0, largest_gap: null, span_ms: 0, first_ts: null });
  });
});

describe('filters', () => {
  it('parses status selectors', () => {
    expect(parseStatusSelector('2xx')(204)).toBe(true);
    expect(parseStatusSelector('2XX')(301)).toBe(false);
    expect(parseStatusSelector('404')(404)).toBe(true);
    expect(parseStatusSelector('404')(403)).toBe(false);
    expect(() => parseStatusSelector('ok')).toThrow(ConfigError);
    expect(() => parseStatusSelector('6xx')).toThrow(/expected a class such as 2xx or a code/);
  });

  it('matches any value of a list and combines lists with and', () => {
    const all = fixture();
    const ids = (keep: (e: Exchange) => boolean): number[] =>
      all.filter(keep).map((e) => all.indexOf(e));
    expect(ids(compileFilter({}))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(compileFilter({ tags: [], methods: [], paths: [], statuses: [] }))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(ids(compileFilter({ tags: ['get-order', 'create-order'] }))).toEqual([0, 1, 3]);
    expect(ids(compileFilter({ methods: ['get'] }))).toEqual([1, 2, 3]);
    expect(ids(compileFilter({ paths: ['/v1/orders/*'] }))).toEqual([1, 3, 4]);
    expect(ids(compileFilter({ paths: ['/v1/orders', '/v1/inventory'] }))).toEqual([0, 2]);
    expect(ids(compileFilter({ statuses: ['4xx'] }))).toEqual([3]);
    expect(ids(compileFilter({ statuses: ['201', '404'] }))).toEqual([0, 3]);
    expect(ids(compileFilter({ fromMs: 100, toMs: 1000 }))).toEqual([1, 2, 3]);
    expect(ids(compileFilter({ tags: ['get-order'], statuses: ['2xx'] }))).toEqual([1]);
    expect(ids(compileFilter({ methods: ['GET'], paths: ['/v1/orders/*'], toMs: 150 }))).toEqual([
      1,
    ]);
    expect(() => compileFilter({ fromMs: 10, toMs: 5 })).toThrow(ConfigError);
  });

  it('closes a selection over its producers transitively', () => {
    const deps: Record<number, number[]> = { 3: [1], 1: [0], 4: [] };
    expect([...closeOverProducers([3], (i) => deps[i] ?? [])].sort()).toEqual([0, 1]);
    expect([...closeOverProducers([3, 1], (i) => deps[i] ?? [])]).toEqual([0]);
    expect([...closeOverProducers([4], (i) => deps[i] ?? [])]).toEqual([]);
    const all = fixture();
    const selection = filterExchanges(
      all,
      (e) => e.tags.includes('get-order'),
      (i) => deps[i] ?? [],
    );
    expect(selection.kept.map((e) => all.indexOf(e))).toEqual([0, 1, 3]);
    expect(selection.dependencies).toBe(1);
    expect(filterExchanges(all, () => true).dependencies).toBe(0);
  });

  it('writes a rebased output and streams a filter without touching the input', async () => {
    const dir = await tempDir();
    const all = fixture();
    const input = await writeExchangesTo(dir, 'in.jsonl', all);
    const before = await hashRecordingFile(input);
    const out = join(dir, 'out.jsonl');
    expect(await writeRebased(out, all.slice(1, 4))).toBe(3);
    expect((await readBack(out)).map((e) => e.offset_ms)).toEqual([0, 50, 900]);
    expect(await writeRebased(out, [])).toBe(0);
    expect(await readFile(out, 'utf8')).toBe('');
    const result = await filterRecording(input, out, { tags: ['get-order'] });
    expect(result).toEqual({ read: 5, kept: 2 });
    const kept = await readBack(out);
    expect(kept.map((e) => e.id)).toEqual([all[1]?.id, all[3]?.id]);
    expect(kept.map((e) => e.offset_ms)).toEqual([0, 900]);
    expect(kept.map((e) => e.ts)).toEqual([all[1]?.ts, all[3]?.ts]);
    expect(await hashRecordingFile(input)).toEqual(before);
    await expect(filterRecording(input, join(dir, 'no', 'dir.jsonl'), {})).rejects.toThrow(
      join(dir, 'no', 'dir.jsonl'),
    );
    await expect(filterRecording(join(dir, 'missing.jsonl'), out, {})).rejects.toThrow(ConfigError);
  });
});

describe('sampling', () => {
  it('is deterministic for a seed', () => {
    const a = createRandom(7);
    const b = createRandom(7);
    const values = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(values);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(values).not.toEqual(Array.from({ length: 50 }, createRandom(8)));
    expect(bucketOf(1, 'alice')).toBe(bucketOf(1, 'alice'));
    expect(bucketOf(1, 'alice')).not.toBe(bucketOf(2, 'alice'));
    expect(bucketOf(1, 'alice')).not.toBe(bucketOf(1, 'bob'));
    expect(bucketOf(1, 'alice')).toBeGreaterThanOrEqual(0);
    expect(bucketOf(1, 'alice')).toBeLessThan(1);
  });

  it('reads the session key from a header or a body path', () => {
    const e = makeExchange({
      request: makeRequest({ headers: { 'x-session': 's-1' }, body: { user: { id: 42 } } }),
    });
    expect(sessionKeyOf(e, 'X-Session')).toBe('s-1');
    expect(sessionKeyOf(e, 'x-other')).toBeNull();
    expect(sessionKeyOf(e, '$.user.id')).toBe('42');
    expect(sessionKeyOf(e, '$.user')).toBeNull();
    expect(sessionKeyOf(e, '$.nope')).toBeNull();
  });

  it('keeps a fraction per exchange, the same for the same seed', async () => {
    const dir = await tempDir();
    const all = Array.from({ length: 200 }, (_, i) => makeExchange({ index: i }));
    const input = await writeExchangesTo(dir, 'in.jsonl', all);
    const out = join(dir, 'out.jsonl');
    const first = await sampleRecording(input, out, { fraction: 0.25, seed: 3 });
    expect(first).toEqual({ read: 200, kept: first.kept, sessions: null, keyless: null });
    expect(first.kept).toBeGreaterThan(20);
    expect(first.kept).toBeLessThan(80);
    const ids = (await readBack(out)).map((e) => e.id);
    await sampleRecording(input, out, { fraction: 0.25, seed: 3 });
    expect((await readBack(out)).map((e) => e.id)).toEqual(ids);
    await sampleRecording(input, out, { fraction: 0.25, seed: 4 });
    expect((await readBack(out)).map((e) => e.id)).not.toEqual(ids);
    expect((await sampleRecording(input, out, { fraction: 1, seed: 1 })).kept).toBe(200);
    expect((await readBack(out))[0]?.offset_ms).toBe(0);
    await expect(sampleRecording(input, out, { fraction: 0, seed: 1 })).rejects.toThrow(
      ConfigError,
    );
    await expect(sampleRecording(input, out, { fraction: 1.5, seed: 1 })).rejects.toThrow(
      /fraction must be above 0 and at most 1/,
    );
  });

  it('keeps or drops whole sessions and always keeps keyless exchanges', async () => {
    const dir = await tempDir();
    const all: Exchange[] = [];
    for (let i = 0; i < 60; i += 1) {
      all.push(
        makeExchange({
          index: i,
          request: makeRequest({ headers: { 'x-session': `s-${i % 6}` } }),
        }),
      );
    }
    for (let i = 60; i < 63; i += 1) all.push(makeExchange({ index: i }));
    const input = await writeExchangesTo(dir, 'sessions.jsonl', all);
    const out = join(dir, 'out.jsonl');
    const result = await sampleRecording(input, out, {
      fraction: 0.5,
      seed: 11,
      bySession: 'x-session',
    });
    expect(result.read).toBe(63);
    expect(result.sessions).toBe(6);
    expect(result.keyless).toBe(3);
    const kept = await readBack(out);
    const keptSessions = new Set(kept.map((e) => e.request.headers['x-session']));
    keptSessions.delete(undefined);
    expect(kept.length).toBe(keptSessions.size * 10 + 3);
    expect(kept.filter((e) => e.request.headers['x-session'] === undefined)).toHaveLength(3);
    const byBody = await writeExchangesTo(
      dir,
      'body.jsonl',
      all.map((e) => ({
        ...e,
        request: makeRequest({ body: { session: e.request.headers['x-session'] ?? null } }),
      })),
    );
    const viaPath = await sampleRecording(byBody, out, {
      fraction: 0.5,
      seed: 11,
      bySession: '$.session',
    });
    expect(viaPath.sessions).toBe(6);
    expect(viaPath.keyless).toBe(3);
    await expect(
      sampleRecording(byBody, out, { fraction: 0.5, seed: 1, bySession: '$..session' }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('splitRecording', () => {
  it('names parts after the input', () => {
    expect(partFileName('/tmp/recording.jsonl', 3)).toBe('recording-0003.jsonl');
    expect(partFileName('traffic.JSONL', 12)).toBe('traffic-0012.jsonl');
    expect(partFileName('plain', 1)).toBe('plain-0001.jsonl');
  });

  it('splits by count and by recorded time, rebasing each part', async () => {
    const dir = await tempDir();
    const all = fixture();
    const input = await writeExchangesTo(dir, 'rec.jsonl', all);
    const byCount = await splitRecording(input, join(dir, 'count'), { every: 2 });
    expect(byCount.read).toBe(5);
    expect(byCount.parts.map((p) => [p.exchanges, p.first_offset_ms, p.last_offset_ms])).toEqual([
      [2, 0, 100],
      [2, 150, 1000],
      [1, 5000, 5000],
    ]);
    expect(byCount.parts.map((p) => p.path)).toEqual([
      join(dir, 'count', 'rec-0001.jsonl'),
      join(dir, 'count', 'rec-0002.jsonl'),
      join(dir, 'count', 'rec-0003.jsonl'),
    ]);
    expect((await readBack(byCount.parts[1]?.path as string)).map((e) => e.offset_ms)).toEqual([
      0, 850,
    ]);
    const byTime = await splitRecording(input, join(dir, 'time'), { everyMs: 500 });
    expect(byTime.parts.map((p) => [p.exchanges, p.first_offset_ms])).toEqual([
      [3, 0],
      [1, 1000],
      [1, 5000],
    ]);
    expect(byTime.parts.map((p) => p.path)).toEqual([
      join(dir, 'time', 'rec-0001.jsonl'),
      join(dir, 'time', 'rec-0002.jsonl'),
      join(dir, 'time', 'rec-0003.jsonl'),
    ]);
    expect((await readBack(byTime.parts[0]?.path as string)).map((e) => e.offset_ms)).toEqual([
      0, 100, 150,
    ]);
    const empty = await splitRecording(await writeLines(dir, 'empty.jsonl', []), join(dir, 'e'), {
      every: 2,
    });
    expect(empty).toEqual({ read: 0, parts: [] });
  });

  it('rejects bad options', async () => {
    const dir = await tempDir();
    const input = await writeExchangesTo(dir, 'rec.jsonl', fixture());
    await expect(splitRecording(input, dir, {})).rejects.toThrow(ConfigError);
    await expect(splitRecording(input, dir, { every: 1, everyMs: 1 })).rejects.toThrow(ConfigError);
    await expect(splitRecording(input, dir, { every: 0 })).rejects.toThrow(/every must be/);
    await expect(splitRecording(input, dir, { everyMs: -1 })).rejects.toThrow(/everyMs must be/);
    await expect(splitRecording(join(dir, 'nope.jsonl'), dir, { every: 1 })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('mergeRecordings', () => {
  const t0 = Date.parse('2026-10-16T20:50:45.000Z');
  const at = (index: number, ms: number, offset: number): Exchange =>
    makeExchange({ index, ts: new Date(t0 + ms).toISOString(), offset_ms: offset });

  it('merges by ts, recomputes offsets, and keeps input order on ties', async () => {
    const dir = await tempDir();
    const a = await writeExchangesTo(dir, 'a.jsonl', [
      at(1, 0, 0),
      at(2, 100, 100),
      at(3, 300, 300),
    ]);
    const b = await writeExchangesTo(dir, 'b.jsonl', [
      at(4, 50, 0),
      at(5, 100, 50),
      at(6, 150, 100),
    ]);
    const c = await writeLines(dir, 'c.jsonl', []);
    const out = join(dir, 'merged.jsonl');
    const result = await mergeRecordings([a, b, c], out);
    expect(result).toEqual({
      exchanges: 6,
      inputs: 3,
      first_ts: new Date(t0).toISOString(),
      last_ts: new Date(t0 + 300).toISOString(),
    });
    const merged = await readBack(out);
    expect(merged.map((e) => [e.id, e.offset_ms])).toEqual([
      [at(1, 0, 0).id, 0],
      [at(4, 0, 0).id, 50],
      [at(2, 0, 0).id, 100],
      [at(5, 0, 0).id, 100],
      [at(6, 0, 0).id, 150],
      [at(3, 0, 0).id, 300],
    ]);
    const reversed = await mergeRecordings([b, a], join(dir, 'reversed.jsonl'));
    expect(reversed.exchanges).toBe(6);
    const again = await readBack(join(dir, 'reversed.jsonl'));
    expect(again.map((e) => e.id)[2]).toBe(at(5, 0, 0).id);
  });

  it('refuses colliding ids and unordered inputs before writing anything', async () => {
    const dir = await tempDir();
    const a = await writeExchangesTo(dir, 'a.jsonl', [at(1, 0, 0), at(2, 100, 100)]);
    const b = await writeExchangesTo(dir, 'b.jsonl', [at(3, 50, 0), at(1, 200, 150)]);
    const out = join(dir, 'merged.jsonl');
    await expect(mergeRecordings([a, b], out)).rejects.toThrow(ConfigError);
    await expect(mergeRecordings([a, b], out)).rejects.toThrow(
      `id ${at(1, 0, 0).id} appears in both ${a} and ${b}`,
    );
    expect(existsSync(out)).toBe(false);
    const unordered = await writeExchangesTo(dir, 'u.jsonl', [at(7, 500, 0), at(8, 400, 0)]);
    await expect(mergeRecordings([unordered], out)).rejects.toThrow(
      /u\.jsonl: exchange 2 .* has a ts earlier than the one before it/,
    );
    expect(existsSync(out)).toBe(false);
    await expect(mergeRecordings([], out)).rejects.toThrow(/at least one input/);
    await expect(mergeRecordings([join(dir, 'nope.jsonl')], out)).rejects.toThrow(ConfigError);
  });
});

describe('scan helpers', () => {
  it('measures entropy, checks Luhn, and masks', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(shannonEntropy('k3Jd9fLq2ZxT8vWm4nPb6yRs1cHg7aEu')).toBeGreaterThan(HIGH_ENTROPY_BITS);
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid('41x1')).toBe(false);
    expect(maskValue('')).toBe('');
    expect(maskValue('abcd')).toBe('****');
    expect(maskValue('alice@example.com')).toBe('al*************om');
    expect(maskValue('x'.repeat(100))).toBe(`xx${'*'.repeat(36)}xx`);
  });

  it('detects the patterns in body and query leaves', () => {
    expect(detectPatterns('alice@example.com', 'email')).toEqual(['email']);
    expect(detectPatterns('contact alice@example.com now', null)).toEqual(['email']);
    expect(detectPatterns('+14155550123', null)).toEqual(['phone']);
    expect(detectPatterns('14155550123', null)).toEqual([]);
    expect(detectPatterns('4111 1111 1111 1111', null)).toEqual(['luhn-number']);
    expect(detectPatterns('4111-1111-1111-1111', null)).toEqual(['luhn-number']);
    expect(detectPatterns('4111111111111112', null)).toEqual([]);
    expect(detectPatterns('41111111111111111111', null)).toEqual([]);
    expect(detectPatterns(4111111111111111, null)).toEqual(['luhn-number']);
    expect(detectPatterns(4111111111111112, null)).toEqual([]);
    expect(detectPatterns(29.99, null)).toEqual([]);
    expect(detectPatterns('10.0.0.1', null)).toEqual(['ipv4']);
    expect(detectPatterns('from 192.168.1.20 today', null)).toEqual(['ipv4']);
    expect(detectPatterns('1.2.3.4.5', null)).toEqual([]);
    expect(detectPatterns('999.1.1.1', null)).toEqual([]);
    expect(detectPatterns('1990-01-02', 'date_of_birth')).toEqual(['date-of-birth']);
    expect(detectPatterns('1990-01-02T00:00:00Z', 'dob')).toEqual(['date-of-birth']);
    expect(detectPatterns('1990-01-02', 'created_at')).toEqual([]);
    expect(detectPatterns(true, 'dob')).toEqual([]);
    expect(detectPatterns(null, null)).toEqual([]);
  });

  it('detects tokens by entropy and hex shape and skips the redaction marker', () => {
    expect(detectToken(REDACTED)).toBeNull();
    expect(detectToken('k3Jd9fLq2ZxT8vWm4nPb6yRs1cHg7aEu')).toBe('high-entropy');
    expect(detectToken('Bearer k3Jd9fLq2ZxT8vWm4nPb6yRs1cHg7aEu')).toBe('high-entropy');
    expect(detectToken('deadbeefdeadbeefdeadbeefdeadbeef')).toBe('hex-token');
    expect(detectToken('application/json; charset=utf-8')).toBeNull();
    expect(detectToken('Fri, 16 Oct 2026 20:50:45 GMT')).toBeNull();
    expect(detectToken('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(detectToken('short')).toBeNull();
    expect(detectToken('')).toBeNull();
  });
});

describe('scanRecording', () => {
  it('groups findings by generalized path with counts and a masked example', async () => {
    const dir = await tempDir();
    const token = 'k3Jd9fLq2ZxT8vWm4nPb6yRs1cHg7aEu';
    const exchanges = [
      makeExchange({
        index: 0,
        request: makeRequest({
          method: 'POST',
          path: '/v1/customers',
          query: { email: 'bob@example.com', token: REDACTED, page: '2' },
          headers: {
            authorization: REDACTED,
            'x-api-key': token,
            'x-session': 'deadbeefdeadbeefdeadbeefdeadbeef',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: {
            customer: { email: 'alice@example.com', phone: '+14155550123', dob: '1990-01-02' },
            items: [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }],
          },
        }),
        response: jsonResponse({ number: 4111111111111111, ok: true }),
      }),
      makeExchange({
        index: 1,
        request: makeRequest({
          method: 'POST',
          path: '/v1/customers',
          headers: { authorization: REDACTED },
          body: { customer: { email: 'carol@example.com' } },
        }),
        response: jsonResponse({ ok: true }, 200),
      }),
      makeExchange({
        index: 2,
        request: makeRequest({
          body: Buffer.from('alice@example.com').toString('base64'),
          encoding: 'base64',
        }),
      }),
    ];
    const path = await writeExchangesTo(dir, 'pii.jsonl', exchanges);
    const report = await scanRecording(path);
    expect(report.exchanges).toBe(3);
    expect(report.redacted).toEqual([
      { location: 'request.headers:authorization', count: 2 },
      { location: 'request.query:token', count: 1 },
    ]);
    expect(report.findings).toEqual([
      {
        location: 'request.body:$.customer.dob',
        kind: 'date-of-birth',
        count: 1,
        example: '19******02',
      },
      {
        location: 'request.body:$.customer.email',
        kind: 'email',
        count: 2,
        example: 'al*************om',
      },
      {
        location: 'request.body:$.customer.phone',
        kind: 'phone',
        count: 1,
        example: '+1********23',
      },
      { location: 'request.body:$.items[*].ip', kind: 'ipv4', count: 2, example: '10****.1' },
      {
        location: 'request.headers:x-api-key',
        kind: 'high-entropy',
        count: 1,
        example: maskValue(token),
      },
      {
        location: 'request.headers:x-session',
        kind: 'hex-token',
        count: 1,
        example: 'de****************************ef',
      },
      { location: 'request.query:email', kind: 'email', count: 1, example: 'bo***********om' },
      {
        location: 'response.body:$.number',
        kind: 'luhn-number',
        count: 1,
        example: '41************11',
      },
    ]);
  });

  it('reports the demo recording as clean apart from the redacted header', async () => {
    expect(await scanRecording(DEMO)).toEqual({
      exchanges: 283,
      redacted: [{ location: 'request.headers:authorization', count: 283 }],
      findings: [],
    });
    const scanner = new RecordingScanner();
    expect(scanner.finish()).toEqual({ exchanges: 0, redacted: [], findings: [] });
  });

  it('names a missing file', async () => {
    const missing = join(await tempDir(), 'missing.jsonl');
    await expect(scanRecording(missing)).rejects.toThrow(ConfigError);
  });
});
