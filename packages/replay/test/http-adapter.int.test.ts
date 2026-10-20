import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { REDACTED, makeRequest } from '@replay-parity/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpAdapter } from '../src/index.js';

interface Echo {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let url: string;
const ctx = { id: 'e', index: 0, tags: [], signal: new AbortController().signal };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString(
        'utf8',
      );
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync('{"items":[{"sku":"A"}]}'));
        return;
      }
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 400);
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 255]));
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(2048));
        return;
      }
      if (req.url === '/empty') {
        res.writeHead(204);
        res.end();
        return;
      }
      const echo: Echo = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
      res.end(JSON.stringify(echo));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('HttpAdapter', () => {
  it('sends method, path, query, headers, and a JSON body and measures latency', async () => {
    const adapter = new HttpAdapter(url);
    const res = await adapter.send(
      makeRequest({
        method: 'POST',
        path: '/v1/orders',
        query: { a: '1', b: ['x', 'y'] },
        headers: {
          host: 'reference:3000',
          'content-length': '999',
          'content-type': 'application/json',
          authorization: REDACTED,
          'x-tenant': 'acme',
        },
        body: { sku: 'A', qty: 2 },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-echo']).toBe('yes');
    expect(res.latency_ms).toBeGreaterThan(0);
    const echo = res.body as unknown as Echo;
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/v1/orders?a=1&b=x&b=y');
    expect(JSON.parse(echo.body)).toEqual({ sku: 'A', qty: 2 });
    expect(echo.headers['x-tenant']).toBe('acme');
    expect(echo.headers.authorization).toBeUndefined();
    expect(echo.headers.host).toMatch(/^127\.0\.0\.1:/);
    expect(echo.headers['content-length']).toBe(
      String(JSON.stringify({ sku: 'A', qty: 2 }).length),
    );
    await adapter.close();
  });

  it('prefixes a target path and sends base64 bodies as bytes', async () => {
    const adapter = new HttpAdapter(`${url}/base/`);
    const res = await adapter.send(
      makeRequest({
        method: 'PUT',
        path: '/raw',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      }),
      ctx,
    );
    const echo = res.body as unknown as Echo;
    expect(echo.url).toBe('/base/raw');
    expect(echo.body).toBe('hello');
    await adapter.close();
  });

  it('sends a decoded request body with its coding applied again and decodes a compressed response', async () => {
    const adapter = new HttpAdapter(url);
    const sent = await adapter.send(
      makeRequest({
        method: 'POST',
        path: '/v1/orders',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: { sku: 'A', qty: 2 },
        content_encoding: 'gzip',
      }),
      ctx,
    );
    const echo = sent.body as unknown as Echo;
    expect(echo.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(echo.body)).toEqual({ sku: 'A', qty: 2 });
    const compressed = await adapter.send(makeRequest({ path: '/gzip' }), ctx);
    expect(compressed).toMatchObject({
      status: 200,
      body: { items: [{ sku: 'A' }] },
      content_encoding: 'gzip',
    });
    expect(compressed.encoding).toBeUndefined();
    expect(compressed.headers['content-encoding']).toBe('gzip');
    await adapter.close();
  });

  it('stores binary, empty, and oversized responses by the body rules', async () => {
    const adapter = new HttpAdapter(url, { maxBodyBytes: 1024 });
    const binary = await adapter.send(makeRequest({ path: '/binary' }), ctx);
    expect(binary).toMatchObject({
      encoding: 'base64',
      body: Buffer.from([0, 1, 2, 255]).toString('base64'),
    });
    const empty = await adapter.send(makeRequest({ path: '/empty' }), ctx);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeUndefined();
    const big = await adapter.send(makeRequest({ path: '/big' }), ctx);
    expect(big).toMatchObject({ truncated: true, body_size: 2048 });
    expect(big.body).toBeUndefined();
    await adapter.close();
  });

  it('reports timeouts and connection failures as send errors', async () => {
    const slow = new HttpAdapter(url, { timeoutMs: 50 });
    await expect(slow.send(makeRequest({ path: '/slow' }), ctx)).rejects.toMatchObject({
      name: 'SendError',
      kind: 'timeout',
    });
    await slow.close();
    const refused = new HttpAdapter('http://127.0.0.1:9');
    await expect(refused.send(makeRequest(), ctx)).rejects.toMatchObject({
      name: 'SendError',
      kind: 'connection',
    });
    await refused.close();
  });

  it('honors an abort signal', async () => {
    const adapter = new HttpAdapter(url);
    const controller = new AbortController();
    const send = adapter.send(makeRequest({ path: '/slow' }), {
      ...ctx,
      signal: controller.signal,
    });
    controller.abort();
    await expect(send).rejects.toMatchObject({ name: 'SendError', kind: 'aborted' });
    await adapter.close();
  });
});
