import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REDACTED_HEADERS,
  RecordingWriter,
  encodeBody,
  normalizeHeaders,
  redactHeaders,
  ulid as defaultUlid,
  type Exchange,
  type HeaderMap,
  type Query,
} from '@replay-parity/core';
import { Pool, type Dispatcher } from 'undici';
import { OrderedSink } from './ordered-sink.js';
import { tagsFor, type TagRule } from './tag-rules.js';

/**
 * The capture proxy. Forwards every request to the target, streams the
 * response back unchanged, and appends the exchange to the recording.
 */

export interface CaptureOptions {
  /** Base URL of the reference system, for example `http://localhost:3000`. */
  target: string;
  /** Recording file path. */
  out: string;
  /** Append to an existing file (default) or start a new one. */
  append?: boolean;
  tagRules?: readonly TagRule[];
  /** Fraction of exchanges to record, from 0 to 1. Default 1. */
  sample?: number;
  redactHeaders?: readonly string[];
  maxBodyBytes?: number;
  /** Upstream headers and body timeout in milliseconds. Default 30000. */
  upstreamTimeoutMs?: number;
  /** Injectable clock and randomness for tests. */
  now?: () => number;
  random?: () => number;
  ulid?: () => string;
  onError?: (error: unknown, context: string) => void;
}

export interface CaptureStats {
  /** Requests received. */
  seen: number;
  /** Exchanges written to the recording. */
  recorded: number;
  /** Requests that failed upstream and were answered with 502 or 504. */
  failed: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface PendingExchange {
  tsMs: number;
  exchange: Omit<Exchange, 'offset_ms'>;
}

function parseQuery(params: URLSearchParams): Query {
  const out: Query = {};
  for (const [key, value] of params) {
    const current = out[key];
    if (current === undefined) {
      out[key] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      out[key] = [current, value];
    }
  }
  return out;
}

function forwardableRequestHeaders(headers: IncomingMessage['headers']): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(normalizeHeaders(headers))) {
    if (HOP_BY_HOP.has(name) || name === 'host' || name === 'content-length') continue;
    out[name] = value;
  }
  return out;
}

function forwardableResponseHeaders(
  headers: Dispatcher.ResponseData['headers'],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = Array.isArray(value) ? value : String(value);
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
}

function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function sendError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

export class CaptureServer {
  private readonly server: Server;
  private readonly pool: Pool;
  private readonly writer: RecordingWriter;
  private readonly sink: OrderedSink<PendingExchange>;
  private readonly tagRules: readonly TagRule[];
  private readonly sample: number;
  private readonly redacted: readonly string[];
  private readonly maxBodyBytes: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly nextId: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private firstTs: number | null = null;
  private inflight = 0;
  private drainWaiters: (() => void)[] = [];
  private closing = false;
  private readonly counts: CaptureStats = { seen: 0, recorded: 0, failed: 0 };

  private constructor(options: CaptureOptions, writer: RecordingWriter) {
    this.writer = writer;
    this.tagRules = options.tagRules ?? [];
    this.sample = options.sample ?? 1;
    if (!(this.sample > 0 && this.sample <= 1)) {
      throw new RangeError(`sample must be greater than 0 and at most 1, got ${this.sample}`);
    }
    this.redacted = options.redactHeaders ?? DEFAULT_REDACTED_HEADERS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.nextId = options.ulid ?? defaultUlid;
    this.onError = options.onError ?? (() => undefined);
    const timeout = options.upstreamTimeoutMs ?? 30_000;
    this.pool = new Pool(options.target, { headersTimeout: timeout, bodyTimeout: timeout });
    this.sink = new OrderedSink<PendingExchange>(
      (item) => this.persist(item),
      (err) => this.onError(err, 'recording write'),
    );
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  static async create(options: CaptureOptions): Promise<CaptureServer> {
    const writer = await RecordingWriter.open(options.out, { append: options.append ?? true });
    try {
      return new CaptureServer(options, writer);
    } catch (err) {
      await writer.close();
      throw err;
    }
  }

  get stats(): CaptureStats {
    return { ...this.counts };
  }

  get address(): AddressInfo | null {
    const addr = this.server.address();
    return typeof addr === 'object' ? addr : null;
  }

  async listen(options: { port: number; host?: string }): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(options.port, options.host ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    return this.address as AddressInfo;
  }

  /** Stops accepting requests, lets in flight requests finish, then flushes and closes the recording. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    if (this.inflight > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    this.server.closeIdleConnections();
    await closed;
    await this.sink.idle();
    await this.writer.close();
    await this.pool.close();
  }

  private async persist(item: PendingExchange): Promise<void> {
    this.firstTs ??= item.tsMs;
    await this.writer.write({ ...item.exchange, offset_ms: item.tsMs - this.firstTs });
    this.counts.recorded += 1;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.counts.seen += 1;
    this.inflight += 1;
    const seq = this.sink.reserve();
    const tsMs = this.now();
    const sampled = this.random() < this.sample;
    let pending: PendingExchange | null = null;
    try {
      pending = await this.forward(req, res, tsMs, sampled);
    } catch (err) {
      this.counts.failed += 1;
      this.onError(err, `${req.method ?? 'GET'} ${req.url ?? '/'}`);
      sendError(res, 502, 'proxy_error');
    } finally {
      await this.sink.complete(seq, pending);
      this.inflight -= 1;
      if (this.inflight === 0) {
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    tsMs: number,
    sampled: boolean,
  ): Promise<PendingExchange | null> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const requestBody = await readBody(req);
    const requestHeaders = normalizeHeaders(req.headers);

    const startedAt = performance.now();
    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await this.pool.request({
        method,
        path: `${url.pathname}${url.search}`,
        headers: forwardableRequestHeaders(req.headers),
        body: requestBody.length > 0 ? requestBody : null,
      });
    } catch (err) {
      this.counts.failed += 1;
      this.onError(err, `${method} ${url.pathname}`);
      sendError(res, isTimeout(err) ? 504 : 502, 'upstream_unavailable');
      return null;
    }

    const chunks: Buffer[] = [];
    let lastByteAt = performance.now();
    res.writeHead(upstream.statusCode, forwardableResponseHeaders(upstream.headers));
    for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
      lastByteAt = performance.now();
      if (sampled) chunks.push(chunk);
      if (!res.write(chunk) && !res.destroyed) {
        await waitForDrainOrClose(res);
      }
    }
    res.end();
    if (!sampled) return null;

    const latencyMs = Math.max(0, lastByteAt - startedAt);
    const responseHeaders = normalizeHeaders(upstream.headers);
    for (const name of HOP_BY_HOP) delete responseHeaders[name];
    const recordedRequestHeaders: HeaderMap = {};
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (!HOP_BY_HOP.has(name)) recordedRequestHeaders[name] = value;
    }

    const exchange: Omit<Exchange, 'offset_ms'> = {
      id: this.nextId(),
      ts: new Date(tsMs).toISOString(),
      adapter: 'http',
      request: {
        method,
        path: url.pathname,
        query: parseQuery(url.searchParams),
        headers: redactHeaders(recordedRequestHeaders, this.redacted),
        ...encodeBody(requestBody, requestHeaders['content-type'], this.maxBodyBytes),
      },
      response: {
        status: upstream.statusCode,
        headers: redactHeaders(responseHeaders, this.redacted),
        latency_ms: Math.round(latencyMs * 1000) / 1000,
        ...encodeBody(Buffer.concat(chunks), responseHeaders['content-type'], this.maxBodyBytes),
      },
      tags: tagsFor(this.tagRules, method, url.pathname),
    };
    return { tsMs, exchange };
  }
}
