import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_MAX_BODY_BYTES,
  REDACTED,
  encodeBody,
  normalizeHeaders,
  wireBody,
  type HeaderMap,
  type Query,
  type RecordedRequest,
  type RecordedResponse,
} from '@replay-parity/core';
import { ProxyAgent, Pool, fetch as undiciFetch, type Dispatcher } from 'undici';
import { toSendError, type Adapter, type ReplayContext } from './adapter.js';

/** TLS settings for the connection to the target. Values are PEM text or buffers. */
export interface UpstreamTls {
  /** Certificate authorities that sign the target's certificate, in place of the default roots. */
  ca?: string | Buffer | readonly (string | Buffer)[] | undefined;
  /** Client certificate presented when the target asks for one. */
  cert?: string | Buffer | undefined;
  key?: string | Buffer | undefined;
  passphrase?: string | undefined;
  /** False accepts any certificate the target presents. Default true. */
  rejectUnauthorized?: boolean | undefined;
  /** The name sent in SNI and checked against the certificate. */
  servername?: string | undefined;
}

export interface HttpAdapterOptions {
  tls?: UpstreamTls | undefined;
  /** HTTP proxy URL the connection goes through. */
  proxy?: string | undefined;
  /** Headers and body timeout in milliseconds. Default 30000. */
  timeoutMs?: number | undefined;
  /** Connections kept to the target. Default 8. */
  connections?: number | undefined;
  /** Response bodies over this size are stored as a hash. Default 1 MiB. */
  maxBodyBytes?: number | undefined;
}

interface DispatcherOptions {
  tls?: UpstreamTls | undefined;
  proxy?: string | undefined;
  connections?: number | undefined;
  timeoutMs: number;
}

function connectOptions(tls: UpstreamTls | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (tls === undefined) return out;
  for (const [key, value] of Object.entries(tls)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A dispatcher for the target. Without a proxy it is a pool on the origin with
 * the given connection count. With a proxy it is a proxy agent, which tunnels
 * https targets with CONNECT and applies the TLS settings to the target.
 */
export function createDispatcher(origin: string, options: DispatcherOptions): Dispatcher {
  const timeouts = { headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs };
  const tls = connectOptions(options.tls);
  if (options.proxy !== undefined) {
    return new ProxyAgent({
      uri: options.proxy,
      requestTls: tls,
      ...(options.connections === undefined ? {} : { connections: options.connections }),
      ...timeouts,
    });
  }
  return new Pool(origin, { connections: options.connections ?? 8, connect: tls, ...timeouts });
}

/** True when the options change how a connection is made. */
export function hasUpstreamOptions(options: {
  tls?: UpstreamTls | undefined;
  proxy?: string | undefined;
}): boolean {
  return (
    options.proxy !== undefined || Object.values(options.tls ?? {}).some((v) => v !== undefined)
  );
}

/** One request with the TLS and proxy settings, for probes and resets. The dispatcher is closed afterwards. */
export async function upstreamFetch(
  url: string,
  init: { method: string; signal?: AbortSignal | undefined },
  options: { tls?: UpstreamTls | undefined; proxy?: string | undefined },
): Promise<{ status: number; ok: boolean }> {
  const dispatcher = createDispatcher(new URL(url).origin, {
    ...options,
    connections: 1,
    timeoutMs: 30_000,
  });
  try {
    const res = await undiciFetch(url, {
      method: init.method,
      redirect: 'manual',
      dispatcher,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    await res.body?.cancel();
    return { status: res.status, ok: res.ok };
  } finally {
    await dispatcher.close();
  }
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
  'host',
  'content-length',
]);

/** Appends the recorded query to a path. The recorded path is sent as recorded. */
export function pathWithQuery(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.append(key, value);
    }
  }
  const text = params.toString();
  if (text.length === 0) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${text}`;
}

/** Drops hop by hop headers, the host, the content length, and redacted values. */
export function outgoingHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || value === REDACTED) continue;
    out[key] = value;
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Sends recorded requests over HTTP with a connection pool. Latency is the
 * time from dispatch to the last body byte. A request body stored decoded
 * from a content coding goes out with that coding applied again, and a
 * response body with a `content-encoding` of gzip, deflate, or br is decoded
 * before it is stored, with the coding noted on the response.
 */
export class HttpAdapter implements Adapter {
  readonly name = 'http';
  private readonly pool: Dispatcher;
  private readonly prefix: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(target: string, options: HttpAdapterOptions = {}) {
    const url = new URL(target);
    this.origin = url.origin;
    this.prefix = url.pathname.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.pool = createDispatcher(url.origin, {
      tls: options.tls,
      proxy: options.proxy,
      connections: options.connections ?? 8,
      timeoutMs: this.timeoutMs,
    });
  }

  async send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse> {
    const body = wireBody(req);
    const started = performance.now();
    try {
      const res = await this.pool.request({
        origin: this.origin,
        method: req.method,
        path: this.prefix + pathWithQuery(req.path, req.query),
        // The trace header goes out over a recorded one, so the exchange maps to this run.
        headers:
          ctx.traceparent === undefined
            ? outgoingHeaders(req.headers)
            : { ...outgoingHeaders(req.headers), traceparent: ctx.traceparent },
        body,
        // undici's own timeouts tick once a second, so the exact deadline comes from a signal.
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
      const bytes = Buffer.from(await res.body.arrayBuffer());
      const latency = performance.now() - started;
      const headers = normalizeHeaders(res.headers);
      return {
        status: res.statusCode,
        headers,
        latency_ms: round3(latency),
        ...encodeBody(
          bytes,
          headers['content-type'],
          this.maxBodyBytes,
          headers['content-encoding'],
        ),
      };
    } catch (err) {
      throw toSendError(err);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
