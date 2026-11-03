import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { jsonResponse, makeExchange, makeRequest, parseRun } from '@replay-parity/core';
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
