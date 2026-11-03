import { Buffer } from 'node:buffer';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  emptyThresholds,
  jsonResponse,
  makeExchange,
  makeRequest,
  type Exchange,
  type Thresholds,
} from '@replay-parity/core';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { HttpAdapter, SendError, replayExchanges } from '../src/index.js';

/**
 * Chaos tests. A node:http stand in misbehaves in the ways a candidate can
 * misbehave on a real network, and the tests assert how the HTTP adapter
 * classifies each failure and how a run reports it.
 */

let server: Server;
let url: string;
let flakyHits = 0;
let cleanHits = 0;
const parked: ServerResponse[] = [];
const ctx = { id: 'e', index: 0, tags: [], signal: new AbortController().signal };
const JSON_TYPE = { 'content-type': 'application/json' };

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/half-body': {
        // Headers and half of a 64 byte body, then the socket is destroyed once the
        // half has been flushed.
        res.writeHead(200, { ...JSON_TYPE, 'content-length': '64' });
        res.write('{"items":[{"sku":"A"},{"sku":"B"},', () => res.destroy());
        return;
      }
      case '/never': {
        // Parked until the suite ends.
        parked.push(res);
        return;
      }
      case '/bad-gzip': {
        // Announced as gzip, but the bytes are neither gzip nor JSON.
        res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'gzip' });
        res.end('not gzip and not json');
        return;
      }
      case '/bad-gzip-json': {
        // Announced as gzip, but the bytes are plain JSON.
        res.writeHead(200, { ...JSON_TYPE, 'content-encoding': 'gzip' });
        res.end('{"not":"gzip"}');
        return;
      }
      case '/flaky': {
        // Every third request gets a 503 status line whose body never arrives.
        flakyHits += 1;
        if (flakyHits % 3 === 0) {
          res.writeHead(503, { ...JSON_TYPE, 'content-length': '24' });
          res.flushHeaders();
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, JSON_TYPE);
        res.end('{"ok":true}');
        return;
      }
      case '/flaky-clean': {
        // Every third request is a complete 503 response.
        cleanHits += 1;
        if (cleanHits % 3 === 0) {
          res.writeHead(503, JSON_TYPE);
          res.end('{"error":"unavailable"}');
          return;
        }
        res.writeHead(200, JSON_TYPE);
        res.end('{"ok":true}');
        return;
      }
      case '/close-before-headers': {
        req.socket.destroy();
        return;
      }
      default: {
        res.writeHead(404, JSON_TYPE);
        res.end('{"error":"not_found"}');
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of parked) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function sendError(adapter: HttpAdapter, path: string): Promise<SendError> {
  try {
    await adapter.send(makeRequest({ path }), ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(SendError);
    return err as SendError;
  } finally {
    await adapter.close();
  }
  throw new Error('expected the send to fail');
}

function recording(path: string, count: number): Exchange[] {
  return Array.from({ length: count }, (_, index) =>
    makeExchange({
      index,
      tags: ['read'],
      request: makeRequest({ path }),
      response: jsonResponse({ ok: true }),
    }),
  );
}

function errorRateThresholds(): Thresholds {
  return { ...emptyThresholds(), errors: { rate_max: 0 } };
}

describe('HTTP adapter under chaos', () => {
  it('classifies a connection destroyed after the headers and half the body as a transport failure, not other', async () => {
    const err = await sendError(new HttpAdapter(url, { timeoutMs: 2000 }), '/half-body');
    // undici reports the early close as `UND_ERR_SOCKET: other side closed`, which the
    // adapter maps to `connection`. A content length mismatch would arrive as `protocol`.
    // Either is a transport failure; `other` would mean the error went unclassified.
    expect(err.kind).toBe('connection');
    expect(err.message).toMatch(/^UND_ERR_SOCKET: /);
    expect(err.kind).not.toBe('other');
  }, 5000);

  // Retried because the upper bound below failed with stalls of 7 to 10 s when other suites ran
  // at the same time on a shared machine. The error kind and the lower bound hold under any stall.
  it(
    'reports a server that never answers as a timeout close to the configured deadline',
    { retry: 2, timeout: 5000 },
    async () => {
      const timeoutMs = 300;
      let elapsed: number | null = null;
      let err: SendError | null = null;
      // Logs the fields of a failed attempt, so a retry is never silent in the output.
      onTestFailed(({ task }) => {
        const failures = task.result?.errors ?? [];
        console.error(
          `attempt failed: ${failures[failures.length - 1]?.message ?? 'no error recorded'}\n` +
            `timeoutMs ${timeoutMs} elapsed ${elapsed ?? '-'} kind ${err?.kind ?? '-'} ` +
            `message ${err?.message ?? '-'}`,
        );
      });
      const started = performance.now();
      err = await sendError(new HttpAdapter(url, { timeoutMs }), '/never');
      elapsed = performance.now() - started;
      expect(err.kind).toBe('timeout');
      // The adapter must not give up before the deadline.
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
      // A quiet machine measures about 304 ms. The bound leaves 1696 ms of slack over that figure,
      // since a bound of timeoutMs + 700 failed under the stall above. The lower bound and the
      // error kind are what prove the deadline is honored.
      expect(elapsed).toBeLessThan(timeoutMs + 2000);
    },
  );

  it('stores a body announced as gzip that is not gzip as received, with no coding note', async () => {
    // body.ts: data that does not decode is stored as the bytes received, by the usual
    // rules, with no `content_encoding` note. Bytes that are not JSON go to base64, and
    // bytes that happen to be JSON are stored parsed.
    const adapter = new HttpAdapter(url, { timeoutMs: 2000 });
    const raw = await adapter.send(makeRequest({ path: '/bad-gzip' }), ctx);
    const json = await adapter.send(makeRequest({ path: '/bad-gzip-json' }), ctx);
    await adapter.close();
    for (const res of [raw, json]) {
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.content_encoding).toBeUndefined();
      expect(res.truncated).toBeUndefined();
    }
    expect(raw).toMatchObject({
      body: Buffer.from('not gzip and not json').toString('base64'),
      encoding: 'base64',
    });
    expect(json.body).toEqual({ not: 'gzip' });
    expect(json.encoding).toBeUndefined();
  }, 5000);

  it('fails a run on the error rate row when every third response breaks, and records the error kinds', async () => {
    flakyHits = 0;
    const run = await replayExchanges(recording('/flaky', 9), {
      target: url,
      pace: 'max',
      concurrency: 1,
      timeoutMs: 2000,
      thresholds: errorRateThresholds(),
    });
    expect(run.verdict).toBe('fail');
    const row = run.threshold_results.find((r) => r.id === 'errors.rate_max');
    expect(row).toMatchObject({ outcome: 'fail', limit: 0 });
    expect(row?.measured).toBeCloseTo(1 / 3, 5);
    expect(run.stats.overall).toMatchObject({ count: 9, errors: 3, compared: 6, mismatches: 0 });
    const failed = run.exchanges.filter((e) => e.error !== null);
    expect(failed.map((e) => run.exchanges.indexOf(e))).toEqual([2, 5, 8]);
    for (const e of failed) {
      // The 503 status line arrives, then the socket closes before the announced body.
      expect(e.error).toMatch(/^connection: UND_ERR_SOCKET: /);
      expect(e.candidate).toBeNull();
      expect(e.diff).toBeNull();
      expect(e.acked_at_ms).toBeNull();
    }
    for (const e of run.exchanges.filter((x) => x.error === null)) {
      expect(e.candidate?.status).toBe(200);
      expect(e.diff?.verdict).toBe('match');
    }
  }, 5000);

  it('counts a complete 503 as a compared mismatch rather than an error', async () => {
    // The error rate row only counts transport failures. A 503 that arrives in full
    // is diffed, mismatches on status, and leaves the error rate at zero.
    cleanHits = 0;
    const run = await replayExchanges(recording('/flaky-clean', 6), {
      target: url,
      pace: 'max',
      concurrency: 1,
      timeoutMs: 2000,
      thresholds: errorRateThresholds(),
    });
    expect(run.stats.overall).toMatchObject({ count: 6, errors: 0, compared: 6, mismatches: 2 });
    expect(run.threshold_results.find((r) => r.id === 'errors.rate_max')).toMatchObject({
      outcome: 'pass',
      measured: 0,
    });
    expect(run.exchanges.every((e) => e.error === null)).toBe(true);
    const mismatched = run.exchanges.filter((e) => e.diff?.verdict === 'mismatch');
    expect(mismatched.map((e) => run.exchanges.indexOf(e))).toEqual([2, 5]);
    expect(mismatched[0]?.diff?.findings[0]).toMatchObject({
      path: 'status',
      kind: 'status',
      reference: 200,
      candidate: 503,
    });
  }, 5000);

  it('classifies a connection closed before any header as connection', async () => {
    const err = await sendError(new HttpAdapter(url, { timeoutMs: 2000 }), '/close-before-headers');
    expect(err.kind).toBe('connection');
  }, 5000);
});
