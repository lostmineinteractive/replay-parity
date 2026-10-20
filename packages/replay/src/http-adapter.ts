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
import { Pool } from 'undici';
import { toSendError, type Adapter, type ReplayContext } from './adapter.js';

export interface HttpAdapterOptions {
  /** Headers and body timeout in milliseconds. Default 30000. */
  timeoutMs?: number | undefined;
  /** Connections kept to the target. Default 8. */
  connections?: number | undefined;
  /** Response bodies over this size are stored as a hash. Default 1 MiB. */
  maxBodyBytes?: number | undefined;
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
  private readonly pool: Pool;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(target: string, options: HttpAdapterOptions = {}) {
    const url = new URL(target);
    this.prefix = url.pathname.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.pool = new Pool(url.origin, {
      connections: options.connections ?? 8,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
  }

  async send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse> {
    const body = wireBody(req);
    const started = performance.now();
    try {
      const res = await this.pool.request({
        method: req.method,
        path: this.prefix + pathWithQuery(req.path, req.query),
        headers: outgoingHeaders(req.headers),
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
