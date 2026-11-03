import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaptureRulesSchema,
  REDACTED,
  bucketOf,
  hashRedaction,
  makeExchange,
  readRecording,
  readRecordingManifest,
  type Exchange,
} from '@replay-parity/core';
import { request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CaptureServer,
  nextPartIndex,
  parseTagRule,
  partPath,
  usesParts,
  type CaptureOptions,
} from '../src/index.js';

/**
 * The recording format as the capture writes it: the manifest line, and
 * the options that shape what is kept. The upstream is a stand-in that
 * echoes the request as JSON.
 */

interface Harness {
  upstream: Server;
  capture: CaptureServer;
  url: string;
  dir: string;
  out: string;
}

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.capture.close();
    await new Promise<void>((resolve) => h.upstream.close(() => resolve()));
  }
});

function echo(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const body = JSON.stringify({ path: req.url, received: text.length === 0 ? null : text });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
}

async function start(
  options: Partial<CaptureOptions> = {},
  out?: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void = echo,
): Promise<Harness> {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), 'rp-capture-format-'));
  const file = out ?? join(dir, 'recording.jsonl');
  let capture: CaptureServer;
  try {
    capture = await CaptureServer.create({ target, out: file, ...options });
  } catch (err) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    throw err;
  }
  const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
  const h = { upstream, capture, url: `http://127.0.0.1:${addr.port}`, dir, out: file };
  open.push(h);
  return h;
}

async function send(
  h: Harness,
  path: string,
  init: Parameters<typeof request>[1] = {},
): Promise<void> {
  const res = await request(`${h.url}${path}`, init);
  await res.body.arrayBuffer();
}

async function stop(h: Harness): Promise<Exchange[]> {
  await h.capture.close();
  return readRecording(h.out);
}

describe('manifest', () => {
  it('starts a new file with a manifest built from the options', async () => {
    const h = await start({
      toolVersion: '9.9.9',
      tagRules: [parseTagRule('GET /a=alpha')],
      redactHeaders: ['authorization'],
      redactQuery: ['token'],
      now: () => Date.parse('2026-11-01T10:00:00.000Z'),
    });
    await send(h, '/a');
    const exchanges = await stop(h);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.tags).toEqual(['alpha']);
    const manifest = await readRecordingManifest(h.out);
    expect(manifest).toMatchObject({
      manifest: 1,
      tool_version: '9.9.9',
      created_at: '2026-11-01T10:00:00.000Z',
      tag_rules: ['GET /a=alpha'],
      redaction: { headers: ['authorization'], query: ['token'] },
      sample: { fraction: 1, seed: null },
      session_key: null,
    });
    expect(manifest?.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('does not add a manifest when appending to a file that lacks one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-format-'));
    const out = join(dir, 'old.jsonl');
    const old = makeExchange({ index: 0, offset_ms: 0 });
    await writeFile(out, `${JSON.stringify(old)}\n`);
    const h = await start({ toolVersion: '9.9.9' }, out);
    await send(h, '/b');
    const exchanges = await stop(h);
    expect(exchanges).toHaveLength(2);
    expect(await readRecordingManifest(out)).toBeNull();
    expect((await readFile(out, 'utf8')).startsWith(JSON.stringify(old))).toBe(true);
  });

  it('writes no manifest without a tool version', async () => {
    const h = await start();
    await send(h, '/c');
    await stop(h);
    expect(await readRecordingManifest(h.out)).toBeNull();
  });
});

/** A stream of sessions: each creates, then reads twice, interleaved across sessions. */
async function sessionStream(
  h: Harness,
  sessions: readonly string[],
  carry: (session: string) => Record<string, string>,
): Promise<void> {
  for (const step of ['create', 'read-1', 'read-2']) {
    for (const s of sessions) {
      const method = step === 'create' ? 'POST' : 'GET';
      await send(h, `/${s}/${step}`, {
        method,
        headers: { 'content-type': 'application/json', ...carry(s) },
        ...(method === 'POST' ? { body: JSON.stringify({ session: s }) } : {}),
      });
    }
  }
}

function sessionsIn(exchanges: readonly Exchange[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of exchanges) {
    const [, session, step] = e.request.path.split('/');
    out.set(session as string, [...(out.get(session as string) ?? []), step as string]);
  }
  return out;
}

const SESSIONS = Array.from({ length: 24 }, (_, i) => `s${String(i).padStart(2, '0')}`);

describe('session aware sampling', () => {
  it('keeps or drops whole sessions by a header, as bucketOf decides for the seed', async () => {
    const h = await start({ sample: 0.5, sampleBy: 'header:x-session', sampleSeed: 11 });
    expect(h.capture.sampleSeed).toBe(11);
    await sessionStream(h, SESSIONS, (s) => ({ 'x-session': s }));
    const kept = sessionsIn(await stop(h));
    for (const steps of kept.values()) expect(steps).toEqual(['create', 'read-1', 'read-2']);
    const expected = SESSIONS.filter((s) => bucketOf(11, s) < 0.5);
    expect([...kept.keys()].sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(SESSIONS.length);
    const manifest = await readRecordingManifest(h.out);
    expect(manifest).toBeNull();
  });

  it('chooses the same sessions for the same seed and writes the selector in the manifest', async () => {
    const runs: string[][] = [];
    for (let i = 0; i < 2; i += 1) {
      const h = await start({
        sample: 0.3,
        sampleBy: 'cookie:sid',
        sampleSeed: 5,
        toolVersion: '1.0.0',
      });
      await sessionStream(h, SESSIONS, (s) => ({ cookie: `theme=dark; sid=${s}` }));
      const kept = sessionsIn(await stop(h));
      for (const steps of kept.values()) expect(steps).toHaveLength(3);
      runs.push([...kept.keys()].sort());
      expect(await readRecordingManifest(h.out)).toMatchObject({
        sample: { fraction: 0.3, seed: 5 },
        session_key: 'cookie:sid',
      });
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it('reads a body path once the request body is in', async () => {
    const h = await start({ sample: 0.5, sampleBy: '$.session', sampleSeed: 2, random: () => 0 });
    // Each request carries its session in the body, so reads are posts here.
    for (const step of ['create', 'read-1']) {
      for (const s of SESSIONS) {
        await send(h, `/${s}/${step}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: s }),
        });
      }
    }
    const kept = sessionsIn(await stop(h));
    const expected = SESSIONS.filter((s) => bucketOf(2, JSON.stringify(s)) < 0.5);
    expect([...kept.keys()].sort()).toEqual(expected);
    for (const steps of kept.values()) expect(steps).toEqual(['create', 'read-1']);
  });

  it('samples a request without a session value on its own draw', async () => {
    let n = 0;
    const h = await start({
      sample: 0.5,
      sampleBy: 'header:x-session',
      sampleSeed: 1,
      random: () => (n++ % 2 === 0 ? 0.1 : 0.9),
    });
    for (let i = 0; i < 4; i += 1) await send(h, `/keyless/${i}`);
    const exchanges = await stop(h);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/keyless/0', '/keyless/2']);
  });

  it('refuses a selector it cannot read', async () => {
    await expect(start({ sampleBy: 'x-session' })).rejects.toThrow(/must be header/);
    await expect(start({ sampleBy: 'header:a', sampleSeed: -1 })).rejects.toThrow(RangeError);
  });
});

/** A clock that moves forward by `step` milliseconds on each call. */
function steppingClock(start: number, step: number): () => number {
  let t = start - step;
  return () => (t += step);
}

describe('rotation and compression', () => {
  it('names parts after the stem and continues after the highest existing part', async () => {
    expect(partPath('/d/rec.jsonl', 2, false)).toBe('/d/rec.0002.jsonl');
    expect(partPath('/d/rec.jsonl.gz', 12, true)).toBe('/d/rec.0012.jsonl.gz');
    expect(usesParts({})).toBe(false);
    expect(usesParts({ gzip: true })).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'rp-parts-'));
    expect(await nextPartIndex(join(dir, 'rec.jsonl'))).toBe(1);
    await writeFile(join(dir, 'rec.0003.jsonl.gz'), '');
    await writeFile(join(dir, 'rec.0001.jsonl'), '');
    await writeFile(join(dir, 'other.0009.jsonl'), '');
    expect(await nextPartIndex(join(dir, 'rec.jsonl'))).toBe(4);
    expect(await nextPartIndex(join(dir, 'missing', 'rec.jsonl'))).toBe(1);
  });

  it('rotates by bytes into parts that each start with a manifest, offsets continuing', async () => {
    const h = await start({
      toolVersion: '1.0.0',
      rotateBytes: 1500,
      now: steppingClock(Date.parse('2026-11-01T00:00:00Z'), 10),
    });
    for (let i = 0; i < 12; i += 1) await send(h, `/item/${i}`);
    await h.capture.close();
    const files = h.capture.files;
    expect(files.length).toBeGreaterThan(2);
    expect(files[0]).toBe(join(h.dir, 'recording.0001.jsonl'));
    const all: Exchange[] = [];
    for (const [i, file] of files.entries()) {
      const manifest = await readRecordingManifest(file);
      expect(manifest?.part).toBe(i + 1);
      const part = await readRecording(file);
      expect(part.length).toBeGreaterThan(0);
      all.push(...part);
    }
    expect(all.map((e) => e.request.path)).toEqual(
      Array.from({ length: 12 }, (_, i) => `/item/${i}`),
    );
    const offsets = all.map((e) => e.offset_ms);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBe(0);
    // The offset of a later part's first exchange is the time since the capture's first exchange.
    expect(offsets[offsets.length - 1]).toBeGreaterThan(0);
    expect(await readdir(h.dir)).not.toContain('recording.jsonl');
  });

  it('rotates by interval on the capture clock', async () => {
    // Each request reads the clock once, so exchanges are 100 ms apart.
    const h = await start({
      rotateIntervalMs: 250,
      now: steppingClock(Date.parse('2026-11-01T00:00:00Z'), 100),
    });
    for (let i = 0; i < 7; i += 1) await send(h, `/t/${i}`);
    await h.capture.close();
    const parts = [];
    for (const file of h.capture.files)
      parts.push((await readRecording(file)).map((e) => e.offset_ms));
    expect(parts).toEqual([[0, 100, 200], [300, 400, 500], [600]]);
  });

  it('writes gzip parts the reader opens', async () => {
    const h = await start({ gzip: true, toolVersion: '1.0.0' });
    for (let i = 0; i < 3; i += 1) await send(h, `/g/${i}`);
    await h.capture.close();
    expect(h.capture.files).toEqual([join(h.dir, 'recording.0001.jsonl.gz')]);
    const file = h.capture.files[0] as string;
    const text = gunzipSync(await readFile(file)).toString('utf8');
    expect(text.split('\n')[0]).toContain('"manifest":1');
    expect(await readRecording(file)).toHaveLength(3);
    expect((await readRecordingManifest(file))?.part).toBe(1);
  });

  it('refuses a rotation size or interval that is not positive', async () => {
    await expect(start({ rotateBytes: 0 })).rejects.toThrow(RangeError);
    await expect(start({ rotateIntervalMs: -1 })).rejects.toThrow(RangeError);
  });
});

describe('limits that end a capture', () => {
  it('ends after --max-exchanges and records exactly that many', async () => {
    const h = await start({ maxExchanges: 3 });
    for (let i = 0; i < 3; i += 1) await send(h, `/m/${i}`);
    expect(await h.capture.ended).toBe('max-exchanges');
    // A request after the limit and before the owner closes is answered and not recorded.
    await send(h, '/m/late');
    const exchanges = await stop(h);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/m/0', '/m/1', '/m/2']);
    expect(h.capture.stats).toMatchObject({ seen: 4, recorded: 3 });
  });

  it('ends after the duration once listening', async () => {
    const h = await start({ durationMs: 50 });
    await send(h, '/d/0');
    expect(await h.capture.ended).toBe('duration');
    expect(await stop(h)).toHaveLength(1);
  });

  it('refuses limits that are not positive integers', async () => {
    await expect(start({ maxExchanges: 0 })).rejects.toThrow(RangeError);
    await expect(start({ durationMs: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe('body redaction from capture rules', () => {
  const KEY = 'capture-test-key';
  const rules = CaptureRulesSchema.parse({
    redact: {
      body: [
        { path: '$.secret', mode: 'drop' },
        { path: '$..user', mode: 'hash' },
      ],
      query: [{ name: 'q', mode: 'hash' }],
      headers: [{ name: 'x-user', mode: 'hash' }],
    },
  });

  it('drops and hashes request and response bodies, query, and headers', async () => {
    const h = await start(
      { captureRules: rules, redactionKey: KEY, toolVersion: '1.0.0' },
      undefined,
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ user: 'u-1', list: [{ user: 'u-2' }], secret: 's' }));
        });
      },
    );
    await send(h, '/r?q=find&page=2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'u-1' },
      body: JSON.stringify({ user: 'u-1', secret: 'pw', keep: 1 }),
    });
    const [e] = await stop(h);
    const hash = (t: string): string => hashRedaction(KEY, t);
    expect(e?.request.body).toEqual({ user: hash('u-1'), secret: REDACTED, keep: 1 });
    expect(e?.response.body).toEqual({
      user: hash('u-1'),
      list: [{ user: hash('u-2') }],
      secret: REDACTED,
    });
    expect(e?.request.query).toEqual({ q: hash('find'), page: '2' });
    expect(e?.request.headers['x-user']).toBe(hash('u-1'));
    const text = await readFile(h.out, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('"u-1"');
    const manifest = await readRecordingManifest(h.out);
    expect(manifest?.redaction.rules?.body).toEqual([
      { path: '$.secret', mode: 'drop' },
      { path: '$..user', mode: 'hash' },
    ]);
  });

  it('refuses to start with a hash rule and no key, before creating the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-format-'));
    const out = join(dir, 'never.jsonl');
    await expect(start({ captureRules: rules }, out)).rejects.toThrow(/RP_REDACTION_KEY/);
    await expect(access(out)).rejects.toThrow();
  });
});
