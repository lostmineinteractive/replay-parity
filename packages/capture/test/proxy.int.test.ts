import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { REDACTED, parseRecordingText, sha256Hex, type Exchange } from '@replay-parity/core';
import { buildApp } from '@replay-parity/demo-reference';
import { request } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureServer, parseTagRule } from '../src/index.js';

const TAG_RULES = [
  'POST /v1/orders=create-order',
  'GET /v1/orders/*=get-order',
  'GET /v1/inventory=list-inventory',
  'POST /v1/inventory/*/adjust=adjust-stock',
].map(parseTagRule);

interface Harness {
  reference: ReturnType<typeof buildApp>;
  referenceUrl: string;
  capture: CaptureServer;
  proxyUrl: string;
  out: string;
}

async function startHarness(
  options: Partial<Parameters<typeof CaptureServer.create>[0]> = {},
): Promise<Harness> {
  const reference = buildApp({ now: () => new Date('2026-10-16T18:00:00.000Z') });
  await reference.listen({ port: 0, host: '127.0.0.1' });
  const referenceUrl = `http://127.0.0.1:${(reference.server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
  const out = join(dir, 'recording.jsonl');
  const capture = await CaptureServer.create({
    target: referenceUrl,
    out,
    tagRules: TAG_RULES,
    ...options,
  });
  const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
  return { reference, referenceUrl, capture, proxyUrl: `http://127.0.0.1:${addr.port}`, out };
}

async function readRecording(path: string): Promise<Exchange[]> {
  return parseRecordingText(await readFile(path, 'utf8'));
}

async function fetchBoth(h: Harness, path: string, init?: Parameters<typeof request>[1]) {
  const [direct, proxied] = await Promise.all([
    request(`${h.referenceUrl}${path}`, init),
    request(`${h.proxyUrl}${path}`, init),
  ]);
  const [directBody, proxiedBody] = await Promise.all([
    direct.body.arrayBuffer(),
    proxied.body.arrayBuffer(),
  ]);
  return {
    direct: { status: direct.statusCode, headers: direct.headers, body: Buffer.from(directBody) },
    proxied: {
      status: proxied.statusCode,
      headers: proxied.headers,
      body: Buffer.from(proxiedBody),
    },
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.capture.close();
    await h.reference.close();
  }
});

describe('pass through', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
    harnesses.push(h);
  });

  it('returns the same status, headers, and bytes as the reference for JSON routes', async () => {
    for (const [path, init] of [
      ['/v1/inventory', undefined],
      ['/v1/orders/o-404', undefined],
      [
        '/v1/orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sku: 'A-100', qty: 1001 }),
        },
      ],
    ] as const) {
      const { direct, proxied } = await fetchBoth(h, path, init);
      expect(proxied.status, path).toBe(direct.status);
      expect(proxied.body.equals(direct.body), path).toBe(true);
      expect(proxied.headers['content-type'], path).toBe(direct.headers['content-type']);
      expect(proxied.headers['content-length'], path).toBe(direct.headers['content-length']);
    }
  });

  it('records an exchange per request with every recording field', async () => {
    await request(`${h.proxyUrl}/v1/orders?source=test&source=again&dry=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        'x-api-key': 'k-1',
      },
      body: JSON.stringify({ sku: 'B-200', qty: 1 }),
    }).then((r) => r.body.text());
    await request(`${h.proxyUrl}/v1/orders/o-1`).then((r) => r.body.text());
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges).toHaveLength(2);
    const [create, get] = exchanges as [Exchange, Exchange];
    expect(create.adapter).toBe('http');
    expect(create.offset_ms).toBe(0);
    expect(get.offset_ms).toBeGreaterThanOrEqual(0);
    expect(create.request).toMatchObject({
      method: 'POST',
      path: '/v1/orders',
      query: { source: ['test', 'again'], dry: '1' },
      body: { sku: 'B-200', qty: 1 },
    });
    expect(create.request.headers.authorization).toBe(REDACTED);
    expect(create.request.headers['x-api-key']).toBe(REDACTED);
    expect(create.request.headers['content-type']).toBe('application/json');
    expect(create.response.status).toBe(201);
    expect(create.response.body).toMatchObject({ order_id: 'o-1', total: 4.13 });
    expect(create.response.headers['content-type']).toContain('application/json');
    expect(create.response.headers['transfer-encoding']).toBeUndefined();
    expect(create.response.latency_ms).toBeGreaterThan(0);
    expect(create.tags).toEqual(['create-order']);
    expect(get.tags).toEqual(['get-order']);
    expect(get.request.body).toBeUndefined();
    expect(get.response.body).toEqual(create.response.body);
    expect(h.capture.stats).toEqual({ seen: 2, recorded: 2, failed: 0 });
  });

  it('keeps arrival order in the recording under concurrency', async () => {
    const paths = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? '/v1/inventory' : `/v1/orders/o-${i}`,
    );
    await Promise.all(paths.map((p) => request(`${h.proxyUrl}${p}`).then((r) => r.body.text())));
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges).toHaveLength(30);
    for (let i = 1; i < exchanges.length; i += 1) {
      expect((exchanges[i] as Exchange).offset_ms).toBeGreaterThanOrEqual(
        (exchanges[i - 1] as Exchange).offset_ms,
      );
    }
  });
});

/** Bytes with a pattern, so a hash of them says something about their order. */
function patterned(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7 + (i >> 8)) % 251;
  return out;
}

describe('body kinds', () => {
  let upstream: Server;
  let upstreamUrl: string;
  const bigBody = Buffer.alloc(2_000_000, 'x');
  const tripleBody = patterned(300_000);
  const gzipHuge = gzipSync(randomBytes(300_000));
  const gzipWide = gzipSync(Buffer.alloc(5000, 'x'));

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-trace': 'abc' });
        res.end('hello there');
      } else if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 255]));
      } else if (req.url === '/chunked') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"a":');
        setTimeout(() => res.end('1}'), 10);
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': bigBody.length });
        res.end(bigBody);
      } else if (req.url === '/cookie') {
        res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'], 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('broken');
      } else if (req.url === '/empty') {
        res.writeHead(204);
        res.end();
      } else if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync('{"a":1,"b":[2,3]}'));
      } else if (req.url === '/gzip-broken') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end('not gzip at all');
      } else if (req.url === '/gunzip') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(gunzipSync(Buffer.concat(chunks)));
        });
      } else if (req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain' });
          res.end(Buffer.concat(chunks));
        });
      } else if (req.url === '/sha') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              sha256: sha256Hex(body),
              size: body.length,
              content_length: req.headers['content-length'] ?? null,
              transfer_encoding: req.headers['transfer-encoding'] ?? null,
            }),
          );
        });
      } else if (req.url === '/triple') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let offset = 0;
        const step = (): void => {
          if (offset >= tripleBody.length) {
            res.end();
            return;
          }
          res.write(tripleBody.subarray(offset, offset + 30_000));
          offset += 30_000;
          setImmediate(step);
        };
        step();
      } else if (req.url === '/gzip-huge') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-encoding': 'gzip',
        });
        res.end(gzipHuge);
      } else if (req.url === '/gzip-wide') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(gzipWide);
      } else if (req.url?.startsWith('/query')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: req.url }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function startCapture(options: Partial<Parameters<typeof CaptureServer.create>[0]> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    const out = join(dir, 'recording.jsonl');
    const capture = await CaptureServer.create({ target: upstreamUrl, out, ...options });
    const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
    return { capture, out, proxyUrl: `http://127.0.0.1:${addr.port}` };
  }

  it('passes text, binary, chunked, cookie, error, and empty responses through byte for byte', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const expectations: Record<string, { status: number; body: Buffer }> = {
      '/text': { status: 200, body: Buffer.from('hello there') },
      '/binary': { status: 200, body: Buffer.from([0, 1, 2, 255]) },
      '/chunked': { status: 200, body: Buffer.from('{"a":1}') },
      '/cookie': { status: 200, body: Buffer.from('{}') },
      '/boom': { status: 500, body: Buffer.from('broken') },
      '/empty': { status: 204, body: Buffer.alloc(0) },
    };
    for (const [path, expected] of Object.entries(expectations)) {
      const res = await request(`${proxyUrl}${path}`);
      const body = Buffer.from(await res.body.arrayBuffer());
      expect(res.statusCode, path).toBe(expected.status);
      expect(body.equals(expected.body), path).toBe(true);
    }
    const cookie = await request(`${proxyUrl}/cookie`);
    await cookie.body.text();
    expect(cookie.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    const text = await request(`${proxyUrl}/text`);
    await text.body.text();
    expect(text.headers['x-trace']).toBe('abc');
    await capture.close();

    const exchanges = await readRecording(out);
    const byPath = Object.fromEntries(exchanges.map((e) => [e.request.path, e]));
    expect(byPath['/text']?.response).toMatchObject({
      status: 200,
      body: Buffer.from('hello there').toString('base64'),
      encoding: 'base64',
    });
    expect(byPath['/binary']?.response.body).toBe(Buffer.from([0, 1, 2, 255]).toString('base64'));
    expect(byPath['/chunked']?.response.body).toEqual({ a: 1 });
    expect(byPath['/cookie']?.response.headers['set-cookie']).toBe(REDACTED);
    expect(byPath['/boom']?.response.status).toBe(500);
    expect(byPath['/empty']?.response.body).toBeUndefined();
    expect(byPath['/empty']?.response.encoding).toBeUndefined();
    expect(byPath['/text']?.tags).toEqual([]);
  });

  it('streams a compressed response through untouched and records it decoded with the coding noted', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const res = await request(`${proxyUrl}/gzip`);
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(body).toString()).toBe('{"a":1,"b":[2,3]}');
    const broken = await request(`${proxyUrl}/gzip-broken`);
    expect(await broken.body.text()).toBe('not gzip at all');
    await capture.close();
    const [good, bad] = await readRecording(out);
    expect(good?.response).toMatchObject({
      status: 200,
      body: { a: 1, b: [2, 3] },
      content_encoding: 'gzip',
    });
    expect(good?.response.encoding).toBeUndefined();
    expect(good?.response.headers['content-encoding']).toBe('gzip');
    expect(bad?.response).toMatchObject({
      body: Buffer.from('not gzip at all').toString('base64'),
      encoding: 'base64',
    });
    expect(bad?.response.content_encoding).toBeUndefined();
  });

  it('forwards a compressed request body as received and records it decoded', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const res = await request(`${proxyUrl}/gunzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync('{"qty":3}'),
    });
    expect(await res.body.json()).toEqual({ qty: 3 });
    await capture.close();
    const [sent] = await readRecording(out);
    expect(sent?.request).toMatchObject({ body: { qty: 3 }, content_encoding: 'gzip' });
    expect(sent?.request.headers['content-encoding']).toBe('gzip');
    expect(sent?.response.body).toEqual({ qty: 3 });
  });

  it('forwards a request body unchanged and records it', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const payload = Buffer.from([7, 8, 9]);
    const res = await request(`${proxyUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    expect(Buffer.from(await res.body.arrayBuffer()).equals(payload)).toBe(true);
    await capture.close();
    const [echo] = await readRecording(out);
    expect(echo?.request).toMatchObject({ body: payload.toString('base64'), encoding: 'base64' });
  });

  it('streams a body over the cap to the caller and records only a hash', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const res = await request(`${proxyUrl}/big`);
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(body.length).toBe(bigBody.length);
    expect(body.equals(bigBody)).toBe(true);
    await capture.close();
    const [big] = await readRecording(out);
    expect(big?.response).toMatchObject({
      truncated: true,
      body_sha256: sha256Hex(bigBody),
      body_size: bigBody.length,
    });
    expect(big?.response.body).toBeUndefined();
  });

  it('records a response three times the cap as a hash while the client receives every byte', async () => {
    const { capture, out, proxyUrl } = await startCapture({ maxBodyBytes: 100_000 });
    const res = await request(`${proxyUrl}/triple`);
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(body.equals(tripleBody)).toBe(true);
    await capture.close();
    const [triple] = await readRecording(out);
    expect(triple?.response).toMatchObject({
      status: 200,
      truncated: true,
      body_sha256: sha256Hex(tripleBody),
      body_size: tripleBody.length,
    });
    expect(triple?.response.body).toBeUndefined();
    expect(triple?.response.content_encoding).toBeUndefined();
  });

  it('notes the coding of a compressed response over the wire cap', async () => {
    const { capture, out, proxyUrl } = await startCapture({ maxBodyBytes: 100_000 });
    expect(gzipHuge.length).toBeGreaterThan(100_000);
    const res = await request(`${proxyUrl}/gzip-huge`);
    const body = Buffer.from(await res.body.arrayBuffer());
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(body.equals(gzipHuge)).toBe(true);
    await capture.close();
    const [huge] = await readRecording(out);
    expect(huge?.response).toMatchObject({
      truncated: true,
      body_sha256: sha256Hex(gzipHuge),
      body_size: gzipHuge.length,
      content_encoding: 'gzip',
    });
  });

  it('still caps a compressed response on its decoded size when the wire fits', async () => {
    const { capture, out, proxyUrl } = await startCapture({ maxBodyBytes: 1000 });
    expect(gzipWide.length).toBeLessThan(1000);
    const wide = await request(`${proxyUrl}/gzip-wide`);
    expect(Buffer.from(await wide.body.arrayBuffer()).equals(gzipWide)).toBe(true);
    const small = await request(`${proxyUrl}/gzip`);
    await small.body.arrayBuffer();
    await capture.close();
    const [first, second] = await readRecording(out);
    expect(first?.response).toMatchObject({
      truncated: true,
      body_sha256: sha256Hex(gzipWide),
      body_size: gzipWide.length,
      content_encoding: 'gzip',
    });
    expect(first?.response.body).toBeUndefined();
    expect(second?.response).toMatchObject({ body: { a: 1, b: [2, 3] }, content_encoding: 'gzip' });
  });

  it('streams a request body over the cap to the upstream intact and records a hash', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const upload = patterned(2 * 1024 * 1024);
    const res = await request(`${proxyUrl}/sha`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: upload,
    });
    expect(await res.body.json()).toEqual({
      sha256: sha256Hex(upload),
      size: upload.length,
      content_length: String(upload.length),
      transfer_encoding: null,
    });
    await capture.close();
    const [sent] = await readRecording(out);
    expect(sent?.request).toMatchObject({
      method: 'POST',
      truncated: true,
      body_sha256: sha256Hex(upload),
      body_size: upload.length,
    });
    expect(sent?.request.body).toBeUndefined();
    expect(sent?.request.headers['content-length']).toBe(String(upload.length));
    expect(sent?.response.body).toMatchObject({ size: upload.length });
    expect(capture.stats).toEqual({ seen: 1, recorded: 1, failed: 0 });
  });

  it('sends a chunked request body chunked and records the bytes within the cap', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const parts = [patterned(1000), patterned(1000).reverse(), Buffer.from('tail')];
    const whole = Buffer.concat(parts);
    const res = await request(`${proxyUrl}/sha`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Readable.from(parts),
    });
    expect(await res.body.json()).toEqual({
      sha256: sha256Hex(whole),
      size: whole.length,
      content_length: null,
      transfer_encoding: 'chunked',
    });
    await capture.close();
    const [sent] = await readRecording(out);
    expect(sent?.request).toMatchObject({ body: whole.toString('base64'), encoding: 'base64' });
    expect(sent?.request.headers['transfer-encoding']).toBeUndefined();
    expect(sent?.request.headers['content-length']).toBeUndefined();
  });

  it('records a small JSON request body parsed and an empty body as absent', async () => {
    const { capture, out, proxyUrl } = await startCapture();
    const posted = await request(`${proxyUrl}/sha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"qty":3}',
    });
    expect(await posted.body.json()).toMatchObject({ size: 9, content_length: '9' });
    const got = await request(`${proxyUrl}/sha`);
    expect(await got.body.json()).toMatchObject({ size: 0, content_length: null });
    const emptyPost = await request(`${proxyUrl}/sha`, { method: 'POST' });
    expect(await emptyPost.body.json()).toMatchObject({ size: 0, content_length: '0' });
    await capture.close();
    const [json, get, post] = await readRecording(out);
    expect(json?.request.body).toEqual({ qty: 3 });
    expect(json?.request.truncated).toBeUndefined();
    for (const empty of [get, post]) {
      expect(empty?.request.body).toBeUndefined();
      expect(empty?.request.encoding).toBeUndefined();
      expect(empty?.request.truncated).toBeUndefined();
      expect(empty?.request.body_sha256).toBeUndefined();
    }
    expect(post?.request.method).toBe('POST');
  });

  it('redacts query values by the default list and by a custom one, forwarding them in clear', async () => {
    const path = '/query?api_key=k-1&Token=t-1&page=2&tag=a&tag=b';
    const byDefault = await startCapture();
    const res = await request(`${byDefault.proxyUrl}${path}`);
    expect(await res.body.json()).toEqual({ url: path });
    await byDefault.capture.close();
    const [recorded] = await readRecording(byDefault.out);
    expect(recorded?.request.query).toEqual({
      api_key: REDACTED,
      Token: REDACTED,
      page: '2',
      tag: ['a', 'b'],
    });

    const custom = await startCapture({ redactQuery: ['tag'] });
    await request(`${custom.proxyUrl}${path}`).then((r) => r.body.text());
    await custom.capture.close();
    const [kept] = await readRecording(custom.out);
    expect(kept?.request.query).toEqual({
      api_key: 'k-1',
      Token: 't-1',
      page: '2',
      tag: [REDACTED, REDACTED],
    });
  });

  it('honors a custom cap and stores a body exactly at the cap', async () => {
    const { capture, out, proxyUrl } = await startCapture({ maxBodyBytes: 11 });
    await request(`${proxyUrl}/text`).then((r) => r.body.text());
    await request(`${proxyUrl}/chunked`).then((r) => r.body.text());
    await capture.close();
    const exchanges = await readRecording(out);
    expect(exchanges[0]?.response.encoding).toBe('base64');
    expect(exchanges[0]?.response.truncated).toBeUndefined();
    expect(exchanges[1]?.response.body).toEqual({ a: 1 });
  });

  it('samples with the injected random source', async () => {
    const draws = [0.05, 0.5, 0.01, 0.99, 0.2];
    let i = 0;
    const { capture, out, proxyUrl } = await startCapture({
      sample: 0.1,
      random: () => draws[i++ % draws.length] as number,
    });
    for (let n = 0; n < 5; n += 1) {
      await request(`${proxyUrl}/text`).then((r) => r.body.text());
    }
    await capture.close();
    const exchanges = await readRecording(out);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[1]?.offset_ms).toBeGreaterThanOrEqual(0);
    expect(capture.stats).toEqual({ seen: 5, recorded: 2, failed: 0 });
  });

  it('rejects an invalid sample fraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    await expect(
      CaptureServer.create({ target: upstreamUrl, out: join(dir, 'r.jsonl'), sample: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      CaptureServer.create({ target: upstreamUrl, out: join(dir, 'r.jsonl'), sample: 1.5 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('failures and shutdown', () => {
  it('answers 502 and records nothing when the upstream is unreachable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    const out = join(dir, 'recording.jsonl');
    const errors: string[] = [];
    const capture = await CaptureServer.create({
      target: 'http://127.0.0.1:1',
      out,
      onError: (_err, context) => errors.push(context),
    });
    const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
    const res = await request(`http://127.0.0.1:${addr.port}/v1/inventory`);
    expect(res.statusCode).toBe(502);
    expect(await res.body.json()).toEqual({ error: 'upstream_unavailable' });
    await capture.close();
    expect(await readFile(out, 'utf8')).toBe('');
    expect(errors).toEqual(['GET /v1/inventory']);
    expect(capture.stats).toEqual({ seen: 1, recorded: 0, failed: 1 });
  });

  it('answers 504 on an upstream timeout', async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    const capture = await CaptureServer.create({
      target: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
      out: join(dir, 'recording.jsonl'),
      upstreamTimeoutMs: 100,
    });
    const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
    const res = await request(`http://127.0.0.1:${addr.port}/slow`);
    expect(res.statusCode).toBe(504);
    await res.body.text();
    await capture.close();
    slow.closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });

  it('lets in flight requests finish and flushes the file on close', async () => {
    const slow = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"slow":true}');
      }, 150);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    const out = join(dir, 'recording.jsonl');
    const capture = await CaptureServer.create({
      target: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
      out,
    });
    const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
    const inflight = Array.from({ length: 6 }, (_, i) =>
      request(`http://127.0.0.1:${addr.port}/slow/${i}`).then(async (r) => ({
        status: r.statusCode,
        body: await r.body.json(),
      })),
    );
    while (capture.stats.seen < 6) await new Promise((resolve) => setTimeout(resolve, 2));
    const closing = capture.close();
    const results = await Promise.all(inflight);
    await closing;
    expect(results.every((r) => r.status === 200)).toBe(true);
    const text = await readFile(out, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRecordingText(text)).toHaveLength(6);
    await capture.close();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });

  it('starts a fresh file when append is false', async () => {
    const h1 = await startHarness();
    await request(`${h1.proxyUrl}/v1/inventory`).then((r) => r.body.text());
    await h1.capture.close();
    const second = await CaptureServer.create({
      target: h1.referenceUrl,
      out: h1.out,
      append: false,
    });
    const addr = await second.listen({ port: 0, host: '127.0.0.1' });
    await request(`http://127.0.0.1:${addr.port}/v1/orders/o-9`).then((r) => r.body.text());
    await second.close();
    await h1.reference.close();
    const exchanges = await readRecording(h1.out);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.path).toBe('/v1/orders/o-9');
  });
});
