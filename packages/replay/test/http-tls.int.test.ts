import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { makeRequest } from '@replay-parity/core';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpAdapter, SendError, hasUpstreamOptions, upstreamFetch } from '../src/index.js';

/** A key pair and certificate made only for these tests, valid for localhost and 127.0.0.1. */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const cert = fixture('test-only-localhost.crt');
const key = fixture('test-only-localhost.private-key');

const ctx = { id: 'e', index: 0, tags: [], signal: new AbortController().signal };
const get = makeRequest({ path: '/v1/items' });

interface Seen {
  clientCertSubject: string | undefined;
  authorized: boolean | undefined;
  sni: string[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

async function startServer(options: { requestCert?: boolean } = {}): Promise<{
  url: string;
  seen: Seen;
}> {
  const seen: Seen = { clientCertSubject: undefined, authorized: undefined, sni: [] };
  const server: Server = createServer(
    {
      cert,
      key,
      ca: cert,
      requestCert: options.requestCert ?? false,
      rejectUnauthorized: false,
      SNICallback: (name, done) => {
        seen.sni.push(name);
        done(null, undefined);
      },
    },
    (req, res) => {
      const socket = req.socket as TLSSocket;
      seen.authorized = socket.authorized;
      const peer = socket.getPeerCertificate();
      const cn = peer?.subject?.CN;
      seen.clientCertSubject = Array.isArray(cn) ? cn[0] : cn;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('HttpAdapter over TLS', () => {
  it('rejects a certificate the default roots do not trust', async () => {
    const { url } = await startServer();
    const adapter = new HttpAdapter(url);
    closers.push(() => adapter.close());
    const err = await adapter.send(get, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(String((err as SendError).message)).toMatch(/certificate|SELF_SIGNED/i);
  });

  it('accepts the certificate when its authority is given', async () => {
    const { url } = await startServer();
    const adapter = new HttpAdapter(url, { tls: { ca: cert } });
    closers.push(() => adapter.close());
    const res = await adapter.send(get, ctx);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts any certificate when rejectUnauthorized is false', async () => {
    const { url } = await startServer();
    const adapter = new HttpAdapter(url, { tls: { rejectUnauthorized: false } });
    closers.push(() => adapter.close());
    expect((await adapter.send(get, ctx)).status).toBe(200);
  });

  it('presents the client certificate when the server asks for one', async () => {
    const { url, seen } = await startServer({ requestCert: true });
    const adapter = new HttpAdapter(url, { tls: { ca: cert, cert, key } });
    closers.push(() => adapter.close());
    expect((await adapter.send(get, ctx)).status).toBe(200);
    expect(seen.clientCertSubject).toBe('localhost');
    expect(seen.authorized).toBe(true);
  });

  it('sends no client certificate without one configured', async () => {
    const { url, seen } = await startServer({ requestCert: true });
    const adapter = new HttpAdapter(url, { tls: { ca: cert } });
    closers.push(() => adapter.close());
    await adapter.send(get, ctx);
    expect(seen.clientCertSubject).toBeUndefined();
  });

  it('sends the servername in SNI', async () => {
    const { url, seen } = await startServer();
    const adapter = new HttpAdapter(url, { tls: { ca: cert, servername: 'localhost' } });
    closers.push(() => adapter.close());
    await adapter.send(get, ctx);
    expect(seen.sni).toContain('localhost');
  });
});

describe('HttpAdapter tracing over TLS', () => {
  it('sends the traceparent from the context', async () => {
    const received: (string | string[] | undefined)[] = [];
    const server = createServer({ cert, key }, (req, res) => {
      received.push(req.headers.traceparent);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adapter = new HttpAdapter(url, { tls: { ca: cert } });
    closers.push(() => adapter.close());
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await adapter.send(get, { ...ctx, traceparent });
    expect(received).toEqual([traceparent]);
  });
});

describe('HttpAdapter through a proxy', () => {
  async function startProxy(): Promise<{ url: string; tunnels: string[] }> {
    const tunnels: string[] = [];
    const sockets = new Set<Socket>();
    const proxy: HttpServer = createHttpServer();
    proxy.on('connect', (req, clientSocket, head) => {
      tunnels.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      sockets.add(clientSocket as Socket);
      sockets.add(upstream);
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          proxy.close(() => resolve());
        }),
    );
    return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, tunnels };
  }

  it('tunnels an https target through the proxy and applies the TLS settings', async () => {
    const { url } = await startServer();
    const proxy = await startProxy();
    const adapter = new HttpAdapter(url, { tls: { ca: cert }, proxy: proxy.url });
    closers.push(() => adapter.close());
    const res = await adapter.send(get, ctx);
    expect(res.status).toBe(200);
    expect(proxy.tunnels).toEqual([new URL(url).host]);
  });

  it('fails when the proxy is not reachable', async () => {
    const { url } = await startServer();
    const adapter = new HttpAdapter(url, { tls: { ca: cert }, proxy: 'http://127.0.0.1:1' });
    closers.push(() => adapter.close());
    await expect(adapter.send(get, ctx)).rejects.toBeInstanceOf(SendError);
  });
});

describe('upstream helpers', () => {
  it('reports whether any connection option is set', () => {
    expect(hasUpstreamOptions({})).toBe(false);
    expect(hasUpstreamOptions({ tls: { ca: undefined } })).toBe(false);
    expect(hasUpstreamOptions({ tls: { rejectUnauthorized: false } })).toBe(true);
    expect(hasUpstreamOptions({ proxy: 'http://p:3128' })).toBe(true);
  });

  it('fetches with the TLS settings', async () => {
    const { url } = await startServer();
    const res = await upstreamFetch(`${url}/healthz`, { method: 'GET' }, { tls: { ca: cert } });
    expect(res).toEqual({ status: 200, ok: true });
    await expect(upstreamFetch(`${url}/healthz`, { method: 'GET' }, {})).rejects.toThrow();
  });
});
