import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { MockModelClient } from '@replay-parity/agent';
import { makeRun, writeRun } from '@replay-parity/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentCommand, type AgentCommandHooks } from '../src/commands/agent.js';

/** The key pair and certificate the replay package keeps for its TLS tests. */
const FIXTURES = resolve(import.meta.dirname, '../../replay/test/fixtures');
const CERT = join(FIXTURES, 'test-only-localhost.crt');
const KEY = join(FIXTURES, 'test-only-localhost.private-key');
const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

interface Seen {
  clientCert: string | undefined;
  sni: string[];
  requests: string[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

/** An https stand-in that answers every request with 200 and records what reached it. */
async function tlsServer(requestCert: boolean): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { clientCert: undefined, sni: [], requests: [] };
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
      if (cn !== undefined) seen.clientCert = Array.isArray(cn) ? cn[0] : cn;
      seen.requests.push(`${req.method} ${req.url}`);
      req.resume();
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

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-agent-tls-'));
});

const unknownCase = {
  hypothesis: 'an unknown order id answers 200 instead of 404',
  tags: ['get-order'],
  steps: [{ request: { method: 'GET', path: '/v1/orders/o-does-not-exist' } }],
};

async function rpAgent(args: string[]): Promise<{ code: number; err: string }> {
  const stderr = new Sink();
  let code = 0;
  const hooks: AgentCommandHooks = {
    env: { ANTHROPIC_API_KEY: 'test-key-not-real' },
    clientFactory: (_key, model) =>
      new MockModelClient(
        [JSON.stringify({ cases: [unknownCase] }), JSON.stringify({ cases: [] })],
        {
          model,
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      ),
  };
  const command = agentCommand(
    { stdout: new Sink(), stderr },
    new AbortController().signal,
    (c) => {
      code = c;
    },
    hooks,
  ).exitOverride();
  command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  try {
    await command.parseAsync(args, { from: 'user' });
  } catch (e) {
    return { code: 1, err: e instanceof Error ? e.message : String(e) };
  }
  return { code, err: stderr.text };
}

async function baseArgs(name: string, target: string, reference: string): Promise<string[]> {
  const runPath = join(dir, `${name}.json`);
  await writeRun(runPath, makeRun());
  return [
    '--run',
    runPath,
    '--recording',
    RECORDING,
    '--target',
    target,
    '--reference',
    reference,
    '--out',
    join(dir, `${name}-cases.jsonl`),
    '--max-rounds',
    '2',
    '--env',
    join(dir, 'none.env'),
    '--no-preflight',
  ];
}

describe('rp agent over TLS', () => {
  it('reaches both https systems with their own settings, resets included', async () => {
    const candidate = await tlsServer(false);
    const reference = await tlsServer(true);
    const args = await baseArgs('both', candidate.url, reference.url);
    const result = await rpAgent([
      ...args,
      '--upstream-ca',
      CERT,
      '--reference-ca',
      CERT,
      '--reference-cert',
      CERT,
      '--reference-key',
      KEY,
      '--reference-servername',
      'localhost',
      '--reset-between-cases',
      `${candidate.url}/admin/reset`,
      '--reset-reference',
      `${reference.url}/admin/reset`,
    ]);
    expect(result.code).toBe(0);
    expect(candidate.seen.requests).toContain('GET /v1/orders/o-does-not-exist');
    expect(candidate.seen.requests).toContain('POST /admin/reset');
    expect(reference.seen.requests).toContain('GET /v1/orders/o-does-not-exist');
    expect(reference.seen.requests).toContain('POST /admin/reset');
    expect(reference.seen.clientCert).toBe('localhost');
    expect(reference.seen.sni).toContain('localhost');
    expect(candidate.seen.sni).not.toContain('localhost');
  });

  it('accepts --upstream-insecure and --reference-insecure', async () => {
    const candidate = await tlsServer(false);
    const reference = await tlsServer(false);
    const args = await baseArgs('insecure', candidate.url, reference.url);
    const result = await rpAgent([...args, '--upstream-insecure', '--reference-insecure']);
    expect(result.code).toBe(0);
    expect(candidate.seen.requests).toContain('GET /v1/orders/o-does-not-exist');
    expect(reference.seen.requests).toContain('GET /v1/orders/o-does-not-exist');
  });

  it('does not reach a system whose certificate is not trusted', async () => {
    const candidate = await tlsServer(false);
    const reference = await tlsServer(false);
    const args = await baseArgs('untrusted', candidate.url, reference.url);
    // Only the candidate is trusted, so nothing reaches the reference.
    await rpAgent([...args, '--upstream-ca', CERT]);
    expect(reference.seen.requests).toEqual([]);
  });

  it('rejects a certificate without a key and an unreadable file', async () => {
    const args = await baseArgs('bad', 'https://127.0.0.1:1', 'https://127.0.0.1:1');
    const lone = await rpAgent([...args, '--reference-cert', CERT]);
    expect(lone.code).toBe(1);
    expect(lone.err).toContain('--reference-cert and --reference-key are used together');
    const missing = await rpAgent([...args, '--reference-ca', join(dir, 'nope.pem')]);
    expect(missing.err).toContain('--reference-ca');
  });
});
