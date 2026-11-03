import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
