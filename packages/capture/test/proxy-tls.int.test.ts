import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { parseRecordingText } from '@replay-parity/core';
import { Agent, request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureServer, type CaptureOptions } from '../src/index.js';

/** A key pair and certificate made only for these tests, kept with the replay package's fixtures. */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../replay/test/fixtures/${name}`, import.meta.url), 'utf8');
const cert = fixture('test-only-localhost.crt');
const key = fixture('test-only-localhost.private-key');

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0).reverse()) await fn();
});

async function capture(
  options: Pick<CaptureOptions, 'target' | 'tls' | 'upstream'>,
): Promise<{ port: number; out: string; server: CaptureServer }> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-capture-tls-'));
  const out = join(dir, 'recording.jsonl');
  const server = await CaptureServer.create({ ...options, out, append: false });
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => server.close());
  return { port: address.port, out, server };
}

async function plainUpstream(): Promise<string> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"plain"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function tlsUpstream(
  requestCert: boolean,
): Promise<{ url: string; clientCerts: (string | undefined)[]; sni: string[] }> {
  const clientCerts: (string | undefined)[] = [];
  const sni: string[] = [];
  const server = createHttpsServer(
    {
      cert,
      key,
      ca: cert,
      requestCert,
      rejectUnauthorized: false,
      SNICallback: (name, done) => {
        sni.push(name);
        done(null, undefined);
      },
    },
    (req, res) => {
      const cn = (req.socket as TLSSocket).getPeerCertificate()?.subject?.CN;
      clientCerts.push(Array.isArray(cn) ? cn[0] : cn);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"from":"tls"}');
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clientCerts,
    sni,
  };
}

async function get(url: string, ca?: string): Promise<{ status: number; body: string }> {
  const dispatcher = new Agent(ca === undefined ? {} : { connect: { ca } });
  try {
    const res = await request(url, { dispatcher });
    return { status: res.statusCode, body: await res.body.text() };
  } finally {
    await dispatcher.close();
  }
}

describe('capture proxy listening over TLS', () => {
  it('serves https clients and records the exchange', async () => {
    const target = await plainUpstream();
    const { port, out, server } = await capture({ target, tls: { cert, key } });
    const res = await get(`https://127.0.0.1:${port}/v1/items`, cert);
    expect(res).toEqual({ status: 200, body: '{"from":"plain"}' });
    await server.close();
    const [exchange] = parseRecordingText(await readFile(out, 'utf8'));
    expect(exchange?.request.path).toBe('/v1/items');
    expect(exchange?.response.status).toBe(200);
  });

  it('refuses a client that does not trust the certificate', async () => {
    const target = await plainUpstream();
    const { port } = await capture({ target, tls: { cert, key } });
    await expect(get(`https://127.0.0.1:${port}/v1/items`)).rejects.toThrow();
  });

  it('does not answer plain http when it listens over TLS', async () => {
    const target = await plainUpstream();
    const { port } = await capture({ target, tls: { cert, key } });
    await expect(get(`http://127.0.0.1:${port}/v1/items`)).rejects.toThrow();
  });
});

describe('capture proxy connecting to an https reference', () => {
  it('answers 502 when the reference certificate is not trusted', async () => {
    const upstream = await tlsUpstream(false);
    const { port, server } = await capture({ target: upstream.url });
    const res = await get(`http://127.0.0.1:${port}/v1/items`);
    expect(res.status).toBe(502);
    expect(server.stats.failed).toBe(1);
  });

  it('forwards when the authority is given', async () => {
    const upstream = await tlsUpstream(false);
    const { port, out, server } = await capture({ target: upstream.url, upstream: { ca: cert } });
    const res = await get(`http://127.0.0.1:${port}/v1/items`);
    expect(res).toEqual({ status: 200, body: '{"from":"tls"}' });
    await server.close();
    expect(parseRecordingText(await readFile(out, 'utf8'))).toHaveLength(1);
  });

  it('forwards when rejectUnauthorized is false', async () => {
    const upstream = await tlsUpstream(false);
    const { port } = await capture({
      target: upstream.url,
      upstream: { rejectUnauthorized: false },
    });
    expect((await get(`http://127.0.0.1:${port}/v1/items`)).status).toBe(200);
  });

  it('presents the client certificate and the servername', async () => {
    const upstream = await tlsUpstream(true);
    const { port } = await capture({
      target: upstream.url,
      upstream: { ca: cert, cert, key, servername: 'localhost' },
    });
    expect((await get(`http://127.0.0.1:${port}/v1/items`)).status).toBe(200);
    expect(upstream.clientCerts).toEqual(['localhost']);
    expect(upstream.sni).toContain('localhost');
  });

  it('works with TLS on both sides', async () => {
    const upstream = await tlsUpstream(false);
    const { port } = await capture({
      target: upstream.url,
      tls: { cert, key },
      upstream: { ca: cert },
    });
    const res = await get(`https://127.0.0.1:${port}/v1/items`, cert);
    expect(res).toEqual({ status: 200, body: '{"from":"tls"}' });
  });
});
