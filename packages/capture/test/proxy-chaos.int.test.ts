import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  connect,
  createServer as createRawServer,
  type AddressInfo,
  type Server as RawServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseRecordingText, type Exchange } from '@replay-parity/core';
import { request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureServer } from '../src/index.js';

/**
 * Chaos cases for the capture proxy: a client that leaves mid upload,
 * upstreams that stall, close early, answer before reading, or send less
 * than their length, and a concurrent mix of outcomes. Every case checks
 * that the proxy answers the next request and that the recording parses.
 */

interface Capture {
  capture: CaptureServer;
  out: string;
  proxyUrl: string;
  port: number;
  errors: { code: string | undefined; context: string }[];
}

const JSON_HEADERS = { 'content-type': 'application/json' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function waitFor(predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${deadlineMs} ms`);
    await sleep(5);
  }
}

function url(server: Server | RawServer): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return url(server);
}

/** A server that hands the first bytes of every connection to `onRequest` and keeps the socket. */
async function startRaw(onRequest: (head: string, socket: Socket) => void): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createRawServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', (head: Buffer) => onRequest(head.toString('latin1'), socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return url(server);
}

function okResponse(body: string): string {
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
}

async function startCapture(
  target: string,
  options: Partial<Parameters<typeof CaptureServer.create>[0]> = {},
): Promise<Capture> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-chaos-'));
  const out = join(dir, 'recording.jsonl');
  const errors: Capture['errors'] = [];
  const capture = await CaptureServer.create({
    target,
    out,
    upstreamTimeoutMs: 300,
    onError: (err, context) => errors.push({ code: (err as { code?: string }).code, context }),
    ...options,
  });
  cleanups.push(() => capture.close());
  const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
  return { capture, out, proxyUrl: `http://127.0.0.1:${addr.port}`, port: addr.port, errors };
}

async function rawClient(port: number): Promise<{ socket: Socket; text: () => string }> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  let received = '';
  socket.on('data', (data: Buffer) => {
    received += data.toString('latin1');
  });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  cleanups.push(() => {
    socket.destroy();
  });
  return { socket, text: () => received };
}

function uploadHead(path: string): string {
  return `POST ${path} HTTP/1.1\r\nhost: proxy\r\ncontent-type: application/octet-stream\r\ntransfer-encoding: chunked\r\n\r\n`;
}

/** One chunk of a chunked request body. */
function chunk(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n')]);
}

async function readRecording(path: string): Promise<Exchange[]> {
  return parseRecordingText(await readFile(path, 'utf8'));
}

async function expectNextRequestWorks(h: Capture): Promise<void> {
  const next = await request(`${h.proxyUrl}/next`);
  expect(next.statusCode).toBe(200);
  expect(await next.body.json()).toEqual({ next: true });
}

describe('capture under chaos', () => {
  it('fails the upstream request when the client leaves mid upload, writes nothing for it, and serves the next request', async () => {
    let received = 0;
    let ended = false;
    let aborted = false;
    const upstream = await startHttp((req, res) => {
      if (req.url === '/next') {
        res.writeHead(200, JSON_HEADERS);
        res.end('{"next":true}');
        return;
      }
      req.on('data', (data: Buffer) => {
        received += data.length;
      });
      req.on('end', () => {
        ended = true;
        res.writeHead(200, JSON_HEADERS);
        res.end('{"uploaded":true}');
      });
      req.on('close', () => {
        if (!req.complete) aborted = true;
      });
    });
    const h = await startCapture(upstream);
    const client = await rawClient(h.port);
    client.socket.write(uploadHead('/upload'));
    client.socket.write(chunk(Buffer.alloc(1000, 'a')));
    await waitFor(() => received > 0);
    client.socket.write(chunk(Buffer.alloc(1000, 'b')));
    client.socket.destroy();

    await waitFor(() => h.capture.stats.failed === 1);
    await waitFor(() => aborted);
    expect(ended).toBe(false);
    expect(client.text()).toBe('');
    await expectNextRequestWorks(h);
    await h.capture.close();

    // Nothing is written for the aborted upload: the upstream request fails
    // before a response exists, so its slot completes empty and the file
    // holds only the request that followed.
    const exchanges = await readRecording(h.out);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/next']);
    expect(h.capture.stats).toEqual({ seen: 2, recorded: 1, failed: 1 });
    expect(h.errors.map((e) => e.context)).toEqual(['POST /upload']);
  });

  it('destroys the client response when the upstream stalls mid body past the timeout, and serves the next request', async () => {
    const upstream = await startHttp((req, res) => {
      if (req.url === '/stall') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
        res.write('hel');
        return;
      }
      res.writeHead(200, JSON_HEADERS);
      res.end('{"next":true}');
    });
    const h = await startCapture(upstream, { upstreamTimeoutMs: 200 });
    const stalled = await request(`${h.proxyUrl}/stall`);
    expect(stalled.statusCode).toBe(200);
    await expect(stalled.body.text()).rejects.toThrow();
    await waitFor(() => h.capture.stats.failed === 1);
    expect(h.errors).toEqual([{ code: 'UND_ERR_BODY_TIMEOUT', context: 'GET /stall' }]);
    await expectNextRequestWorks(h);
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/next']);
    expect(h.capture.stats).toEqual({ seen: 2, recorded: 1, failed: 1 });
  });

  it('destroys the client response when the upstream closes the socket after the headers, and serves the next request', async () => {
    const upstream = await startRaw((head, socket) => {
      if (head.startsWith('GET /next ')) {
        socket.write(okResponse('{"next":true}'));
        return;
      }
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 10\r\n\r\n');
    });
    const h = await startCapture(upstream);
    await expect(request(`${h.proxyUrl}/closed`).then((r) => r.body.text())).rejects.toThrow();
    await waitFor(() => h.capture.stats.failed === 1);
    expect(h.errors).toEqual([{ code: 'UND_ERR_SOCKET', context: 'GET /closed' }]);
    await expectNextRequestWorks(h);
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/next']);
    expect(h.capture.stats).toEqual({ seen: 2, recorded: 1, failed: 1 });
  });

  it('fails the exchange when the upstream sends less than its content-length, and serves the next request', async () => {
    const upstream = await startRaw((head, socket) => {
      if (head.startsWith('GET /next ')) {
        socket.write(okResponse('{"next":true}'));
        return;
      }
      socket.end(
        'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 100\r\nconnection: close\r\n\r\nhello',
      );
    });
    const h = await startCapture(upstream);
    const short = await request(`${h.proxyUrl}/short`);
    expect(short.statusCode).toBe(200);
    expect(short.headers['content-length']).toBe('100');
    await expect(short.body.text()).rejects.toThrow();
    await waitFor(() => h.capture.stats.failed === 1);
    expect(h.errors).toEqual([
      { code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', context: 'GET /short' },
    ]);
    await expectNextRequestWorks(h);
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges.map((e) => e.request.path)).toEqual(['/next']);
    expect(h.capture.stats).toEqual({ seen: 2, recorded: 1, failed: 1 });
  });

  it('records the bytes seen when the upstream answers before reading the upload, without waiting on the client', async () => {
    const upstream = await startHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' });
      res.end('early');
    });
    // A long timeout, so a prompt finish shows undici resetting the upload
    // rather than the bound ending the wait.
    const h = await startCapture(upstream, { upstreamTimeoutMs: 10_000 });
    const client = await rawClient(h.port);
    const part = Buffer.from('the only part sent');
    client.socket.write(uploadHead('/early'));
    client.socket.write(chunk(part));
    // The exchange is recorded once the handler is done, which can be before
    // the last bytes reach the client socket, so both are awaited.
    await waitFor(() => h.capture.stats.recorded === 1);
    await waitFor(() => client.text().endsWith('early'));
    expect(client.text().startsWith('HTTP/1.1 200 OK')).toBe(true);
    expect(h.errors).toEqual([]);
    client.socket.destroy();
    await h.capture.close();
    const [early] = await readRecording(h.out);
    expect(early?.request).toMatchObject({
      method: 'POST',
      path: '/early',
      body: part.toString('base64'),
      encoding: 'base64',
    });
    expect(early?.response.body).toBe(Buffer.from('early').toString('base64'));
    expect(h.capture.stats).toEqual({ seen: 1, recorded: 1, failed: 0 });
  });

  it('keeps the recording in arrival order with the right count under 50 concurrent requests with mixed outcomes', async () => {
    const upstream = await startHttp((req, res) => {
      const n = Number(req.url?.split('/').pop());
      // Every fifth request fails upstream before a response exists.
      if (n % 5 === 4) {
        req.socket.destroy();
        return;
      }
      // A jittered delay, so completion order differs from arrival order.
      setTimeout(
        () => {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({ n }));
        },
        (n * 7) % 23,
      );
    });
    // The clock counts arrivals, so `offset_ms` is the arrival index of each
    // exchange relative to the first one recorded.
    let tick = 0;
    const h = await startCapture(upstream, { now: () => 1_761_600_000_000 + tick++ });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(`${h.proxyUrl}/r/${i}`).then(async (r) => ({
          status: r.statusCode,
          body: await r.body.text(),
        })),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(
      Array.from({ length: 50 }, (_, i) => (i % 5 === 4 ? 502 : 200)),
    );
    await h.capture.close();
    const exchanges = await readRecording(h.out);
    expect(exchanges).toHaveLength(40);
    expect(exchanges.every((e) => e.response.status === 200)).toBe(true);
    for (let i = 1; i < exchanges.length; i += 1) {
      expect(exchanges[i]!.offset_ms).toBeGreaterThan(exchanges[i - 1]!.offset_ms);
    }
    const recorded = exchanges.map((e) => Number(e.request.path.split('/').pop()));
    expect(recorded.every((n) => n % 5 !== 4)).toBe(true);
    expect(new Set(recorded).size).toBe(40);
    expect(h.capture.stats).toEqual({ seen: 50, recorded: 40, failed: 10 });
    expect(h.errors.map((e) => e.context).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `GET /r/${i * 5 + 4}`).sort(),
    );
  });
});
