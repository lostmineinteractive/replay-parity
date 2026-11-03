import type { Logger, RecordedRequest, RecordedResponse } from '@replay-parity/core';

/**
 * The transport contract. The engine prepares each request (substitutions,
 * dropped redacted headers, caller supplied headers) and hands it to the
 * adapter, which sends it and returns the candidate's response with the
 * latency it measured from dispatch to the last byte received.
 */
export interface ReplayContext {
  /** The exchange id from the recording. */
  id: string;
  /** Position among the selected exchanges, from 0. */
  index: number;
  tags: readonly string[];
  /** Aborted when the engine shuts down before the send completes. */
  signal: AbortSignal;
  /** Where the adapter writes log lines. Header values never belong in one, only names. */
  log?: Logger | undefined;
  /** The W3C `traceparent` for this exchange when tracing is on. The HTTP adapter sends it. */
  traceparent?: string | undefined;
}

export interface Adapter {
  name: string;
  send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse>;
  /** Releases connections. Called once by the engine when it created the adapter. */
  close?(): Promise<void>;
}

export type SendErrorKind = 'timeout' | 'connection' | 'aborted' | 'protocol' | 'other';

/** A transport failure. The engine records `${kind}: ${message}` on the exchange. */
export class SendError extends Error {
  readonly kind: SendErrorKind;

  constructor(kind: SendErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SendError';
    this.kind = kind;
  }
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
]);

function causeName(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const name = (cause as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : undefined;
}

/** Classifies an arbitrary thrown value as a `SendError`. */
export function toSendError(err: unknown): SendError {
  if (err instanceof SendError) return err;
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return new SendError('timeout', `${code}: ${message}`, { cause: err });
  }
  if (code !== undefined && CONNECTION_CODES.has(code)) {
    return new SendError('connection', `${code}: ${message}`, { cause: err });
  }
  if (name === 'TimeoutError' || causeName(err) === 'TimeoutError') {
    return new SendError('timeout', message, { cause: err });
  }
  if (name === 'AbortError') return new SendError('aborted', message, { cause: err });
  if (code?.startsWith('UND_ERR')) {
    return new SendError('protocol', `${code}: ${message}`, { cause: err });
  }
  return new SendError('other', code === undefined ? message : `${code}: ${message}`, {
    cause: err,
  });
}

/** The string the engine records for a failed exchange. */
export function describeSendError(err: unknown): string {
  const e = toSendError(err);
  return `${e.kind}: ${e.message}`;
}
