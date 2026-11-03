import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketOf,
  makeExchange,
  readRecording,
  readRecordingManifest,
  type Exchange,
} from '@replay-parity/core';
import { request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureServer, parseTagRule, type CaptureOptions } from '../src/index.js';

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
  const capture = await CaptureServer.create({ target, out: file, ...options });
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
