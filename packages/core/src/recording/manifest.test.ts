import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { makeExchange } from '../testing.js';
import { hashRecordingFile } from './hash.js';
import {
  MANIFEST_VERSION,
  buildManifest,
  isManifestRecord,
  manifestLine,
  parseManifestRecord,
} from './manifest.js';
import { migrateRecording } from './migrate.js';
import { partFileName, validateRecording } from './ops.js';
import {
  RecordingParseError,
  iterateRecording,
  parseRecordingText,
  readRecording,
  readRecordingManifest,
} from './reader.js';
import { RecordingWriter, isGzipPath } from './writer.js';

const DEMO = resolve(import.meta.dirname, '../../../../demo/recording.jsonl');
const DEMO_SHA256 = '7cda06869f89dfd093a305fe21162d2f499bd809cf2ac852dc0189124d438503';

const manifest = buildManifest({
  tool_version: '1.2.3',
  created_at: '2026-11-01T00:00:00.000Z',
  target: 'http://reference:3000',
  tag_rules: ['POST /v1/orders=create-order'],
  headers: ['authorization'],
  query: ['token'],
  fraction: 0.5,
  seed: 7,
  session_key: 'header:x-session',
});

const line = (index: number, offset = index * 100): string =>
  JSON.stringify(makeExchange({ index, offset_ms: offset }));

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-manifest-'));
}

describe('manifest schema', () => {
  it('builds a version 1 manifest and reads it back', () => {
    expect(manifest.manifest).toBe(MANIFEST_VERSION);
    const raw: unknown = JSON.parse(manifestLine(manifest));
    expect(isManifestRecord(raw)).toBe(true);
    expect(parseManifestRecord(raw)).toEqual(manifest);
  });

  it('fills defaults for fields not given', () => {
    const m = buildManifest({ tool_version: '0.1.0', created_at: '2026-11-01T00:00:00Z' });
    expect(m).toMatchObject({
      target: null,
      tag_rules: [],
      redaction: { headers: [], query: [] },
      sample: { fraction: 1, seed: null },
      session_key: null,
    });
  });

  it('rejects an unknown version and an unknown key', () => {
    expect(() => parseManifestRecord({ ...manifest, manifest: 2 })).toThrow(/invalid manifest/);
    expect(() => parseManifestRecord({ ...manifest, extra: true })).toThrow(/unknown key/);
  });

  it('does not mistake an exchange for a manifest', () => {
    expect(isManifestRecord(JSON.parse(line(0)))).toBe(false);
    expect(isManifestRecord([1])).toBe(false);
    expect(isManifestRecord(null)).toBe(false);
  });
});

describe('reading a recording with a manifest', () => {
  const withManifest = `${manifestLine(manifest)}${line(0)}\n${line(1)}\n`;
  const without = `${line(0)}\n${line(1)}\n`;

  it('yields the same exchanges with and without the manifest', () => {
    expect(parseRecordingText(withManifest)).toEqual(parseRecordingText(without));
  });

  it('allows blank lines before the manifest', () => {
    expect(parseRecordingText(`\n${withManifest}`)).toHaveLength(2);
  });

  it('refuses a manifest after the first line and names the line', () => {
    const text = `${line(0)}\n${manifestLine(manifest)}`;
    expect(() => parseRecordingText(text)).toThrow(RecordingParseError);
    expect(() => parseRecordingText(text)).toThrow(/line 2: a manifest may only be the first line/);
  });

  it('reports an invalid manifest with its line number', () => {
    expect(() => parseRecordingText(`{"manifest": 9}\n${line(0)}\n`)).toThrow(
      /recording line 1: invalid manifest/,
    );
  });

  it('exposes the manifest on the iterator without changing the stream', async () => {
    const dir = await tempDir();
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    await writeFile(a, withManifest);
    await writeFile(b, without);
    const it1 = iterateRecording(a);
    expect(it1.manifest).toBeUndefined();
    const seen = [];
    for await (const e of it1) seen.push(e);
    expect(it1.manifest).toEqual(manifest);
    expect(seen).toEqual(await readRecording(b));
    const it2 = iterateRecording(b);
    for await (const e of it2) void e;
    expect(it2.manifest).toBeNull();
  });

  it('sets the manifest of a file holding only a manifest, and null for an empty file', async () => {
    const dir = await tempDir();
    const only = join(dir, 'only.jsonl');
    const empty = join(dir, 'empty.jsonl');
    await writeFile(only, manifestLine(manifest));
    await writeFile(empty, '');
    const a = iterateRecording(only);
    expect(await a.next()).toEqual({ done: true, value: undefined });
    expect(a.manifest).toEqual(manifest);
    const b = iterateRecording(empty);
    await b.next();
    expect(b.manifest).toBeNull();
  });

  it('readRecordingManifest returns the manifest or null', async () => {
    const dir = await tempDir();
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    await writeFile(a, withManifest);
    await writeFile(b, without);
    expect(await readRecordingManifest(a)).toEqual(manifest);
    expect(await readRecordingManifest(b)).toBeNull();
  });

  it('keeps line numbers of the file in validation and counts no manifest as an exchange', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bad.jsonl');
    await writeFile(path, `${manifestLine(manifest)}${line(0, 500)}\n${line(1, 400)}\n`);
    const result = await validateRecording(path);
    expect(result.ok).toBe(false);
    expect(result.problem?.line).toBe(3);
    expect(result.exchanges).toBe(1);
    expect(result.manifest).toEqual(manifest);
  });
});

describe('the committed demo recording', () => {
  it('has no manifest, parses, and keeps its hash', async () => {
    expect(await readRecordingManifest(DEMO)).toBeNull();
    expect((await readRecording(DEMO)).length).toBeGreaterThan(0);
    expect((await hashRecordingFile(DEMO)).sha256).toBe(DEMO_SHA256);
  });
});

describe('RecordingWriter with a manifest', () => {
  it('writes the manifest first on a new file', async () => {
    const path = join(await tempDir(), 'new.jsonl');
    const writer = await RecordingWriter.open(path, { manifest });
    await writer.write(makeExchange({ index: 0 }));
    await writer.close();
    expect(writer.wroteManifest).toBe(true);
    const text = await readFile(path, 'utf8');
    expect(text.startsWith(manifestLine(manifest))).toBe(true);
    expect(writer.bytes).toBe(Buffer.byteLength(text));
    expect(await readRecordingManifest(path)).toEqual(manifest);
  });

  it('does not add one when appending to a file that has content', async () => {
    const path = join(await tempDir(), 'old.jsonl');
    await writeFile(path, `${line(0)}\n`);
    const writer = await RecordingWriter.open(path, { manifest });
    await writer.write(makeExchange({ index: 1, offset_ms: 100 }));
    await writer.close();
    expect(writer.wroteManifest).toBe(false);
    expect(await readRecordingManifest(path)).toBeNull();
    expect(await readRecording(path)).toHaveLength(2);
  });
});

describe('migrateRecording', () => {
  it('writes the manifest and then the input byte for byte', async () => {
    const dir = await tempDir();
    const out = join(dir, 'migrated.jsonl');
    const result = await migrateRecording(DEMO, out, manifest);
    const input = await readFile(DEMO);
    const output = await readFile(out);
    const head = Buffer.from(manifestLine(manifest));
    expect(output.subarray(0, head.byteLength).equals(head)).toBe(true);
    expect(output.subarray(head.byteLength).equals(input)).toBe(true);
    expect(result.copied_bytes).toBe(input.byteLength);
    expect(await readRecording(out)).toEqual(await readRecording(DEMO));
    expect((await hashRecordingFile(DEMO)).sha256).toBe(DEMO_SHA256);
  });

  it('keeps a missing final newline and CRLF endings', async () => {
    const dir = await tempDir();
    const input = join(dir, 'in.jsonl');
    const text = `${line(0)}\r\n${line(1)}`;
    await writeFile(input, text);
    const out = join(dir, 'out.jsonl');
    await migrateRecording(input, out, manifest);
    expect(await readFile(out, 'utf8')).toBe(`${manifestLine(manifest)}${text}`);
  });

  it('refuses an input that has a manifest, an invalid input, and writing over the input', async () => {
    const dir = await tempDir();
    const has = join(dir, 'has.jsonl');
    await writeFile(has, `${manifestLine(manifest)}${line(0)}\n`);
    await expect(migrateRecording(has, join(dir, 'o1.jsonl'), manifest)).rejects.toThrow(
      /already has a manifest/,
    );
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, `${line(0)}\nnot json\n`);
    await expect(migrateRecording(bad, join(dir, 'o2.jsonl'), manifest)).rejects.toThrow(
      ConfigError,
    );
    await expect(migrateRecording(bad, bad, manifest)).rejects.toThrow(/must differ/);
  });
});

describe('gzip recordings', () => {
  it('writes gzip for a .gz path and reads it back with its manifest', async () => {
    const path = join(await tempDir(), 'rec.jsonl.gz');
    expect(isGzipPath(path)).toBe(true);
    expect(isGzipPath('rec.jsonl')).toBe(false);
    const writer = await RecordingWriter.open(path, { manifest });
    expect(writer.gzip).toBe(true);
    for (let i = 0; i < 50; i += 1) await writer.write(makeExchange({ index: i, offset_ms: i }));
    await writer.flush();
    await writer.close();
    const raw = await readFile(path);
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
    const text = gunzipSync(raw).toString('utf8');
    expect(writer.bytes).toBe(Buffer.byteLength(text));
    expect(text.startsWith(manifestLine(manifest))).toBe(true);
    expect(await readRecordingManifest(path)).toEqual(manifest);
    expect(await readRecording(path)).toEqual(parseRecordingText(text));
    expect((await validateRecording(path)).exchanges).toBe(50);
  });

  it('appends a second gzip member that reads as one stream', async () => {
    const path = join(await tempDir(), 'rec.jsonl.gz');
    const first = await RecordingWriter.open(path);
    await first.write(makeExchange({ index: 0, offset_ms: 0 }));
    await first.close();
    const second = await RecordingWriter.open(path, { manifest });
    expect(second.wroteManifest).toBe(false);
    await second.write(makeExchange({ index: 1, offset_ms: 5 }));
    await second.close();
    expect((await readRecording(path)).map((e) => e.offset_ms)).toEqual([0, 5]);
  });

  it('reads a gzip file without a final newline and with CRLF endings', async () => {
    const path = join(await tempDir(), 'crlf.jsonl.gz');
    await writeFile(path, gzipSync(`${line(0)}\r\n${line(1)}`));
    expect(await readRecording(path)).toHaveLength(2);
  });

  it('names the problem with a file that is not gzip and with a missing file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'plain.jsonl.gz');
    await writeFile(path, `${line(0)}\n`);
    await expect(readRecording(path)).rejects.toThrow(/header/);
    await expect(validateRecording(join(dir, 'none.jsonl.gz'))).rejects.toThrow(ConfigError);
  });

  it('keeps gzip in split part names', () => {
    expect(partFileName('/x/rec.jsonl.gz', 3)).toBe('rec-0003.jsonl.gz');
    expect(partFileName('/x/rec.jsonl', 3)).toBe('rec-0003.jsonl');
  });

  it('migrates a gzip input to a gzip output with the exchange bytes unchanged', async () => {
    const dir = await tempDir();
    const input = join(dir, 'in.jsonl.gz');
    const text = `${line(0)}\n${line(1)}\n`;
    await writeFile(input, gzipSync(text));
    await appendFile(input, gzipSync(`${line(2)}\n`));
    const out = join(dir, 'out.jsonl.gz');
    const result = await migrateRecording(input, out, manifest);
    expect(result.exchanges).toBe(3);
    expect(gunzipSync(await readFile(out)).toString('utf8')).toBe(
      `${manifestLine(manifest)}${text}${line(2)}\n`,
    );
  });
});
