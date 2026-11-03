import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

/**
 * W3C trace context for a replay. A run gets one random trace id, every
 * exchange gets a span id derived from its exchange id, and the HTTP adapter
 * sends the two as a `traceparent` header. A rerun of the same recording
 * therefore maps every exchange to the same span id under a new trace id.
 */

export const TRACEPARENT_HEADER = 'traceparent';

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZEROS = /^0+$/;

/** 32 lower case hex characters, not all zero. */
export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value) && !ZEROS.test(value);
}

/** 16 lower case hex characters, not all zero. */
export function isSpanId(value: string): boolean {
  return SPAN_ID.test(value) && !ZEROS.test(value);
}

/** A hex string that is not all zero, which the specification forbids. */
function nonZero(hex: string): string {
  return ZEROS.test(hex) ? `${hex.slice(0, -1)}1` : hex;
}

/** A new random trace id. `random` is injectable for tests. */
export function generateTraceId(
  random: (bytes: number) => Uint8Array = (bytes) => randomBytes(bytes),
): string {
  return nonZero(Buffer.from(random(16)).toString('hex'));
}

/** The span id of an exchange: the first 16 hex characters of the SHA-256 of its id. */
export function spanIdFor(exchangeId: string): string {
  return nonZero(createHash('sha256').update(exchangeId, 'utf8').digest('hex').slice(0, 16));
}

/** `00-<trace id>-<span id>-01`: version 0, sampled. */
export function traceparent(traceId: string, spanId: string): string {
  if (!isTraceId(traceId)) throw new RangeError(`invalid trace id ${JSON.stringify(traceId)}`);
  if (!isSpanId(spanId)) throw new RangeError(`invalid span id ${JSON.stringify(spanId)}`);
  return `00-${traceId}-${spanId}-01`;
}

export interface TraceParent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

/** The parts of a `traceparent` value, or null when it is not one. */
export function parseTraceparent(value: string): TraceParent | null {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value.trim());
  if (m === null) return null;
  const [, version, traceId, spanId, flags] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === 'ff' || !isTraceId(traceId) || !isSpanId(spanId)) return null;
  return { version, traceId, spanId, flags };
}
