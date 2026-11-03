import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { Transform } from 'node:stream';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REDACTED_HEADERS,
  DEFAULT_REDACTED_QUERY,
  buildManifest,
  normalizeHeaders,
  Redactor,
  ulid as defaultUlid,
  type Exchange,
  type HeaderMap,
  type CaptureRules,
  type Query,
} from '@replay-parity/core';
import { Pool, type Dispatcher } from 'undici';
import { CappedBody } from './capped-body.js';
import { CaptureOutput } from './capture-output.js';
import { OrderedSink } from './ordered-sink.js';
import { SessionSampler, parseSessionSelector, type SessionDecision } from './session-sampler.js';
import { formatTagRule, tagsFor, type TagRule } from './tag-rules.js';

/**
 * The capture proxy. Forwards every request to the target, streams the
 * response back unchanged, and appends the exchange to the recording.
 */

/** TLS settings for listening. Values are PEM text or buffers. */
export interface CaptureListenTls {
  cert: string | Buffer;
  key: string | Buffer;
  passphrase?: string | undefined;
}

/** TLS settings for the connection to the reference system. Values are PEM text or buffers. */
export interface CaptureUpstreamTls {
  ca?: string | Buffer | readonly (string | Buffer)[] | undefined;
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  passphrase?: string | undefined;
  /** False accepts any certificate the reference presents. Default true. */
  rejectUnauthorized?: boolean | undefined;
  servername?: string | undefined;
}

export interface CaptureOptions {
  /** Listen over HTTPS with this certificate and key. Default: plain HTTP. */
  tls?: CaptureListenTls | undefined;
  /** TLS settings for an https target. */
  upstream?: CaptureUpstreamTls | undefined;
  /** Base URL of the reference system, for example `http://localhost:3000`. */
  target: string;
  /** Recording file path. */
  out: string;
  /** Append to an existing file (default) or start a new one. */
  append?: boolean;
  tagRules?: readonly TagRule[];
  /** Fraction of exchanges, or of sessions with `sampleBy`, to record, from 0 to 1. Default 1. */
  sample?: number;
  /**
   * Keep or drop whole sessions: `header:<name>`, `cookie:<name>`, or a
   * request body JSONPath. A request without a session value is sampled on
   * its own.
   */
  sampleBy?: string | undefined;
  /** Seed of the session hash. Default: random, and written in the manifest. */
  sampleSeed?: number | undefined;
  redactHeaders?: readonly string[];
  /** Query parameter names whose values are replaced in the recording. Default `DEFAULT_REDACTED_QUERY`. */
  redactQuery?: readonly string[];
  /** Body, query, and header redaction from a capture rules file, on top of the two lists. */
  captureRules?: CaptureRules | undefined;
  /** The HMAC key for rules that hash. Required when one does. Never written to the recording. */
  redactionKey?: string | undefined;
  /** Bodies above this size, on the wire or once decoded, are stored as a hash. */
  maxBodyBytes?: number;
  /** Upstream headers and body timeout in milliseconds. Default 30000. */
  upstreamTimeoutMs?: number;
  /** Start a new part once a part holds this many bytes of JSON Lines, before compression. */
  rotateBytes?: number | undefined;
  /** Start a new part once an exchange arrives this many milliseconds after the part's first. */
  rotateIntervalMs?: number | undefined;
  /** Write gzip. With any of the three rotation options the capture writes numbered parts. */
  gzip?: boolean | undefined;
  /** End the capture once this many exchanges are recorded. See `ended`. */
  maxExchanges?: number | undefined;
  /** End the capture this many milliseconds after `listen`. See `ended`. */
  durationMs?: number | undefined;
  /**
   * The version written in the manifest. When given, a manifest line starts
   * the file if the file is new or empty. A file that already has content is
   * appended to without one.
   */
  toolVersion?: string | undefined;
  /** Injectable clock and randomness for tests. */
  now?: () => number;
  random?: () => number;
  ulid?: () => string;
  onError?: (error: unknown, context: string) => void;
}

/** Why a capture ended on its own. */
export type CaptureEndReason = 'max-exchanges' | 'duration';

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

/** A request carries a body when it is chunked or announces a length above zero. */
function hasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && Number(length) > 0;
}

interface Upload {
  /** The client's body, handed to undici as the upstream body. */
  stream: Transform;
  /** The bytes as they pass, for the recording. Null when the exchange is not sampled. */
  body: CappedBody | null;
  /** Resolves once undici has ended, reset, or failed the stream. */
  done: Promise<void>;
}

/**
 * Pipes the client's request body through a stream that feeds every byte to
 * `body` on the way to the upstream, so the reference receives the body as
 * it arrives and the proxy holds at most the cap. A client that goes away
 * before its body ends fails the stream, which fails the upstream request.
 */
function teeUpload(req: IncomingMessage, body: CappedBody | null): Upload {
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      body?.push(chunk);
      callback(null, chunk);
    },
  });
  // Undici removes its error listener when it is done with the stream. This
  // one keeps a late client failure from surfacing as an unhandled event.
  stream.on('error', () => undefined);
  const done = new Promise<void>((resolve) => stream.once('close', resolve));
  // Once undici or the proxy is done with the stream, the rest of a body the
  // client is still sending is read and discarded, as Node does for a body no
  // handler consumed. The connection is not left paused on unread bytes, so a
  // client that leaves is noticed at once and one that finishes can be reused.
  stream.once('close', () => {
    req.unpipe(stream);
    if (!req.complete && !req.destroyed) req.resume();
  });
  req.on('error', (err) => stream.destroy(err));
  req.on('close', () => {
    if (!req.complete) stream.destroy(new Error('client closed before the request body ended'));
  });
  // The pipe starts when undici first reads, so nothing has ended at dispatch
  // and a chunked body goes upstream chunked instead of gaining a length.
  stream.once('resume', () => req.pipe(stream));
  return { stream, body, done };
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

/**
 * True when `done` resolves within the timeout, false when the timer fires
 * first. A timeout of zero or less waits without a bound, as undici does.
 */
function finishedWithin(done: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (!(timeoutMs > 0)) return done.then(() => true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
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
  private readonly server: Server | HttpsServer;
  private readonly pool: Pool;
  private readonly output: CaptureOutput;
  private readonly sink: OrderedSink<PendingExchange>;
  private readonly tagRules: readonly TagRule[];
  private readonly sample: number;
  private readonly sampler: SessionSampler | null;
  private readonly redactor: Redactor;
  private readonly maxBodyBytes: number;
  private readonly upstreamTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly nextId: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly seed: number | null;
  private readonly maxExchanges: number | undefined;
  private readonly durationMs: number | undefined;
  private durationTimer: NodeJS.Timeout | null = null;
  private endWith: (reason: CaptureEndReason) => void = () => undefined;
  /**
   * Resolves when the capture reaches `maxExchanges` or `durationMs` on its
   * own. The owner then calls `close`, as it does on a signal. Never
   * resolves when neither limit is set.
   */
  readonly ended: Promise<CaptureEndReason>;
  private firstTs: number | null = null;
  private inflight = 0;
  private drainWaiters: (() => void)[] = [];
  private closing = false;
  private readonly counts: CaptureStats = { seen: 0, recorded: 0, failed: 0 };

  private constructor(
    options: CaptureOptions,
    output: CaptureOutput,
    seed: number | null,
    redactor: Redactor,
  ) {
    this.output = output;
    this.maxExchanges = options.maxExchanges;
    this.durationMs = options.durationMs;
    this.ended = new Promise((resolve) => {
      this.endWith = resolve;
    });
    this.tagRules = options.tagRules ?? [];
    this.sample = options.sample ?? 1;
    if (!(this.sample > 0 && this.sample <= 1)) {
      throw new RangeError(`sample must be greater than 0 and at most 1, got ${this.sample}`);
    }
    this.random = options.random ?? Math.random;
    this.sampler =
      options.sampleBy === undefined || seed === null
        ? null
        : new SessionSampler({
            fraction: this.sample,
            seed,
            selector: parseSessionSelector(options.sampleBy),
            random: this.random,
          });
    this.seed = seed;
    this.redactor = redactor;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.now = options.now ?? Date.now;
    this.nextId = options.ulid ?? defaultUlid;
    this.onError = options.onError ?? (() => undefined);
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
    const connect: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(options.upstream ?? {})) {
      if (value !== undefined) connect[name] = value;
    }
    this.pool = new Pool(options.target, {
      connect,
      headersTimeout: this.upstreamTimeoutMs,
      bodyTimeout: this.upstreamTimeoutMs,
    });
    this.sink = new OrderedSink<PendingExchange>(
      (item) => this.persist(item),
      (err) => this.onError(err, 'recording write'),
    );
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      void this.handle(req, res);
    };
    this.server =
      options.tls === undefined
        ? createServer(onRequest)
        : createHttpsServer({ ...options.tls }, onRequest);
  }

  static async create(options: CaptureOptions): Promise<CaptureServer> {
    const sample = options.sample ?? 1;
    if (!(sample > 0 && sample <= 1)) {
      throw new RangeError(`sample must be greater than 0 and at most 1, got ${sample}`);
    }
    const selector =
      options.sampleBy === undefined ? undefined : parseSessionSelector(options.sampleBy);
    if (
      options.sampleSeed !== undefined &&
      !(Number.isInteger(options.sampleSeed) && options.sampleSeed >= 0)
    ) {
      throw new RangeError(`sampleSeed must be a non negative integer, got ${options.sampleSeed}`);
    }
    const seed = selector === undefined ? null : (options.sampleSeed ?? randomInt(2 ** 31));
    // Built before the file is opened, so a hash rule without a key fails before anything is written.
    const redactor = new Redactor({
      headers: options.redactHeaders ?? DEFAULT_REDACTED_HEADERS,
      query: options.redactQuery ?? DEFAULT_REDACTED_QUERY,
      rules: options.captureRules,
      key: options.redactionKey,
    });
    const manifest =
      options.toolVersion === undefined
        ? undefined
        : buildManifest({
            tool_version: options.toolVersion,
            created_at: new Date((options.now ?? Date.now)()).toISOString(),
            target: options.target,
            tag_rules: (options.tagRules ?? []).map(formatTagRule),
            headers: options.redactHeaders ?? DEFAULT_REDACTED_HEADERS,
            query: options.redactQuery ?? DEFAULT_REDACTED_QUERY,
            rules: redactor.manifestRules,
            fraction: sample,
            seed,
            session_key: selector?.text ?? null,
          });
    for (const [name, value] of [
      ['maxExchanges', options.maxExchanges],
      ['durationMs', options.durationMs],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
        throw new RangeError(`${name} must be a positive integer, got ${value}`);
      }
    }
    const output = await CaptureOutput.open({
      out: options.out,
      append: options.append ?? true,
      manifest,
      rotateBytes: options.rotateBytes,
      rotateIntervalMs: options.rotateIntervalMs,
      gzip: options.gzip,
      now: options.now ?? Date.now,
    });
    try {
      return new CaptureServer(options, output, seed, redactor);
    } catch (err) {
      await output.close();
      throw err;
    }
  }

  /** The seed of the session hash, or null without `sampleBy`. */
  get sampleSeed(): number | null {
    return this.seed;
  }

  /** The recording files written so far: the `out` file, or every part in order. */
  get files(): string[] {
    return this.output.paths;
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
    if (this.durationMs !== undefined && this.durationTimer === null) {
      this.durationTimer = setTimeout(() => this.endWith('duration'), this.durationMs);
    }
    return this.address as AddressInfo;
  }

  /** Stops accepting requests, lets in flight requests finish, then flushes and closes the recording. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.durationTimer !== null) clearTimeout(this.durationTimer);
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    if (this.inflight > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    this.server.closeIdleConnections();
    await closed;
    await this.sink.idle();
    await this.output.close();
    await this.pool.close();
  }

  private async persist(item: PendingExchange): Promise<void> {
    // Requests already in flight when the limit is reached are answered but not recorded.
    if (this.maxExchanges !== undefined && this.counts.recorded >= this.maxExchanges) return;
    this.firstTs ??= item.tsMs;
    await this.output.write({ ...item.exchange, offset_ms: item.tsMs - this.firstTs }, item.tsMs);
    this.counts.recorded += 1;
    if (this.counts.recorded === this.maxExchanges) this.endWith('max-exchanges');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.counts.seen += 1;
    this.inflight += 1;
    const seq = this.sink.reserve();
    const tsMs = this.now();
    const decision: SessionDecision =
      this.sampler === null
        ? this.random() < this.sample
        : this.sampler.fromHeaders(normalizeHeaders(req.headers));
    let pending: PendingExchange | null = null;
    try {
      pending = await this.forward(req, res, tsMs, decision);
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
    decision: SessionDecision,
  ): Promise<PendingExchange | null> {
    // A body selector cannot decide before the request body is in, so both
    // bodies are kept up to the cap until it can.
    const sampled = decision !== false;
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const requestHeaders = normalizeHeaders(req.headers);
    const upload = hasBody(req)
      ? teeUpload(req, sampled ? new CappedBody(this.maxBodyBytes) : null)
      : null;
    // The client's framing is kept: its content-length goes upstream as is,
    // and a chunked body is sent chunked by undici.
    const upstreamHeaders = forwardableRequestHeaders(req.headers);
    const contentLength = requestHeaders['content-length'];
    if (upload !== null && contentLength !== undefined) {
      upstreamHeaders['content-length'] = contentLength;
    }

    const startedAt = performance.now();
    let upstream: Dispatcher.ResponseData;
    try {
      upstream = await this.pool.request({
        method,
        path: `${url.pathname}${url.search}`,
        headers: upstreamHeaders,
        body: upload?.stream ?? null,
      });
    } catch (err) {
      upload?.stream.destroy();
      this.counts.failed += 1;
      this.onError(err, `${method} ${url.pathname}`);
      sendError(res, isTimeout(err) ? 504 : 502, 'upstream_unavailable');
      return null;
    }

    const responseBody = sampled ? new CappedBody(this.maxBodyBytes) : null;
    let lastByteAt = performance.now();
    try {
      res.writeHead(upstream.statusCode, forwardableResponseHeaders(upstream.headers));
      for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
        lastByteAt = performance.now();
        responseBody?.push(chunk);
        if (!res.write(chunk) && !res.destroyed) {
          await waitForDrainOrClose(res);
        }
      }
    } catch (err) {
      // A response that fails mid body fails the exchange. Undici has reset
      // the upload with the socket by then, and destroying it again is a no
      // op that frees the client stream in any case it has not.
      upload?.stream.destroy();
      throw err;
    }
    res.end();
    // Undici ends the upload once it is sent, resets it when the upstream
    // answered before reading all of it, and fails it on a socket error. The
    // wait is bounded by the upstream timeout all the same, so a stream undici
    // never finishes with cannot hold the exchange and the client connection
    // open. On timeout the exchange is recorded with the bytes the tee saw, so
    // its hash and size describe what was sent.
    if (upload !== null && !(await finishedWithin(upload.done, this.upstreamTimeoutMs))) {
      upload.stream.destroy();
      this.onError(
        new Error(
          `the upstream did not finish with the request body within ${this.upstreamTimeoutMs} ms of the response`,
        ),
        `${method} ${url.pathname} upload wait`,
      );
    }
    if (responseBody === null) return null;
    const requestFields = upload?.body?.fields(
      requestHeaders['content-type'],
      requestHeaders['content-encoding'],
    );
    if (decision === 'body' && !(this.sampler as SessionSampler).fromBody(requestFields?.body)) {
      return null;
    }

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
      request: this.redactor.request({
        method,
        path: url.pathname,
        query: parseQuery(url.searchParams),
        headers: recordedRequestHeaders,
        ...requestFields,
      }),
      response: this.redactor.response({
        status: upstream.statusCode,
        headers: responseHeaders,
        latency_ms: Math.round(latencyMs * 1000) / 1000,
        ...responseBody.fields(
          responseHeaders['content-type'],
          responseHeaders['content-encoding'],
        ),
      }),
      tags: tagsFor(this.tagRules, method, url.pathname),
    };
    return { tsMs, exchange };
  }
}
