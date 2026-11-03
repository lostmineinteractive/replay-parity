import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, get as httpsGet, type Server } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  parseRecordingText,
  parseRun,
} from '@replay-parity/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** A key pair and certificate made only for these tests, kept with the replay package's fixtures. */
const FIXTURES = resolve(import.meta.dirname, '../../replay/test/fixtures');
const CERT = join(FIXTURES, 'test-only-localhost.crt');
const KEY = join(FIXTURES, 'test-only-localhost.private-key');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(args: string[], cwd?: string): Promise<{ code: number; err: string }> {
  const stderr = new Sink();
  const code = await runCli(args, { stdout: new Sink(), stderr, ...(cwd ? { cwd } : {}) });
  return { code, err: stderr.text };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

let dir: string;
let recording: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-tls-'));
  recording = join(dir, 'recording.jsonl');
  const exchange = makeExchange({
    request: makeRequest({ path: '/v1/items' }),
    response: jsonResponse({ ok: true }),
  });
  await writeFile(recording, `${JSON.stringify(exchange)}\n`);
});

interface Seen {
  clientCert: string | undefined;
  sni: string[];
  paths: string[];
}

async function tlsServer(requestCert = false): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { clientCert: undefined, sni: [], paths: [] };
  const server: Server = createServer(
    {
      cert: readFileSync(CERT),
      key: readFileSync(KEY),
      ca: readFileSync(CERT),
      requestCert,
      rejectUnauthorized: false,
      SNICallback: (name, done) => {
        seen.sni.push(name);
        done(null, undefined);
      },
    },
    (req, res) => {
      const cn = (req.socket as TLSSocket).getPeerCertificate()?.subject?.CN;
      seen.clientCert = Array.isArray(cn) ? cn[0] : cn;
      seen.paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
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
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function replayArgs(target: string, out: string, extra: string[] = []): string[] {
  return [
    'replay',
    '--recording',
    recording,
    '--target',
    target,
    '--out',
    out,
    '--pace',
    'max',
    '--quiet',
    '--no-preflight',
    ...extra,
  ];
}

describe('rp replay over TLS', () => {
  it('fails without the authority and passes with --upstream-ca', async () => {
    const { url } = await tlsServer();
    const bad = join(dir, 'bad.json');
    await rp(replayArgs(url, bad));
    const failedRun = parseRun(await readFile(bad, 'utf8'));
    expect(failedRun.exchanges[0]?.error).toMatch(/certificate|SELF_SIGNED/i);

    const good = join(dir, 'good.json');
    const passed = await rp(replayArgs(url, good, ['--upstream-ca', CERT]));
    expect(passed.code).toBe(0);
    expect(parseRun(await readFile(good, 'utf8')).exchanges[0]?.diff?.verdict).toBe('match');
  });

  it('accepts the certificate with --upstream-insecure', async () => {
    const { url } = await tlsServer();
    const out = join(dir, 'insecure.json');
    expect((await rp(replayArgs(url, out, ['--upstream-insecure']))).code).toBe(0);
  });

  it('presents --upstream-cert and --upstream-key and sends --upstream-servername', async () => {
    const { url, seen } = await tlsServer(true);
    const out = join(dir, 'client-cert.json');
    const result = await rp(
      replayArgs(url, out, [
        '--upstream-ca',
        CERT,
        '--upstream-cert',
        CERT,
        '--upstream-key',
        KEY,
        '--upstream-servername',
        'localhost',
      ]),
    );
    expect(result.code).toBe(0);
    expect(seen.clientCert).toBe('localhost');
    expect(seen.sni).toContain('localhost');
  });

  it('reads the upstream flags from rp.yaml', async () => {
    const { url } = await tlsServer();
    const cwd = await mkdtemp(join(tmpdir(), 'rp-tls-cfg-'));
    await writeFile(
      join(cwd, 'rp.yaml'),
      `replay:\n  upstream-ca: ${CERT}\n  recording: ${recording}\n  target: ${url}\n  pace: max\n  quiet: true\n  no-preflight: true\n`,
    );
    const out = join(dir, 'config.json');
    expect((await rp(['replay', '--out', out], cwd)).code).toBe(0);
  });

  it('probes the target with the same options under --preflight-probe', async () => {
    const { url, seen } = await tlsServer();
    const out = join(dir, 'probe.json');
    const args = replayArgs(url, out, ['--preflight-probe']).filter((a) => a !== '--no-preflight');
    const refused = await rp(args);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('preflight failed');
    expect(seen.paths).toEqual([]);
    const accepted = await rp([...args, '--upstream-ca', CERT]);
    expect(accepted.code).toBe(0);
    expect(seen.paths[0]).toBe('/healthz');
  });

  it('rejects a certificate without a key and an unreadable file', async () => {
    const out = join(dir, 'x.json');
    const lone = await rp(replayArgs('https://127.0.0.1:1', out, ['--upstream-cert', CERT]));
    expect(lone.code).toBe(1);
    expect(lone.err).toContain('--upstream-cert and --upstream-key are used together');
    const missing = await rp(
      replayArgs('https://127.0.0.1:1', out, ['--upstream-ca', join(dir, 'nope.pem')]),
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('--upstream-ca');
  });
});

describe('rp capture over TLS', () => {
  async function freePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    return port;
  }

  function fetchOnce(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      httpsGet(url, { ca: readFileSync(CERT, 'utf8'), agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', reject);
    });
  }

  async function fetchWhenUp(url: string): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await fetchOnce(url);
      } catch {
        await sleep(20);
      }
    }
    throw new Error(`${url} never came up`);
  }

  it('listens over https with --tls-cert and --tls-key and reaches an https reference with --upstream-ca', async () => {
    const { url, seen } = await tlsServer();
    const port = await freePort();
    const out = join(dir, 'captured.jsonl');
    const controller = new AbortController();
    const stderr = new Sink();
    const running = runCli(
      [
        'capture',
        '--listen',
        `127.0.0.1:${port}`,
        '--target',
        url,
        '--out',
        out,
        '--no-append',
        '--tls-cert',
        CERT,
        '--tls-key',
        KEY,
        '--upstream-ca',
        CERT,
      ],
      { stdout: new Sink(), stderr, signal: controller.signal },
    );
    expect(await fetchWhenUp(`https://127.0.0.1:${port}/v1/items`)).toBe(200);
    controller.abort();
    expect(await running).toBe(0);
    expect(seen.paths).toContain('/v1/items');
    expect(stderr.text).toContain('1 recorded');
    // The file starts with a manifest line, then the one exchange.
    expect(parseRecordingText(await readFile(out, 'utf8'))).toHaveLength(1);
  });

  it('needs the certificate and the key together', async () => {
    const result = await rp([
      'capture',
      '--target',
      'http://127.0.0.1:1',
      '--out',
      join(dir, 'x.jsonl'),
      '--tls-cert',
      CERT,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--tls-cert and --tls-key are used together');
  });
});
