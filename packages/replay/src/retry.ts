import { ConfigError } from '@replay-parity/core';
import type { SendErrorKind } from './adapter.js';

/**
 * The retry policy for a send that failed in transport. Only a timeout and a
 * connection failure can be retried, the kinds where the request may never
 * have reached the candidate or its answer was lost on the way back. A
 * protocol error or an answer of any status is the candidate's behavior and
 * is never retried.
 *
 * A method that is not idempotent is not retried unless the caller opts in.
 * A timeout does not say whether the candidate applied the request, so a
 * second POST can create a second order, and every later exchange then runs
 * against a state the recording never had. The diffs after that point would
 * blame the candidate for the harness's own duplicate.
 */
export type RetryKind = Extract<SendErrorKind, 'timeout' | 'connection'>;

export const RETRY_KINDS: readonly RetryKind[] = ['timeout', 'connection'];

export const DEFAULT_RETRY_BASE_MS = 100;

/** Methods RFC 9110 defines as idempotent. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);

export function isIdempotent(method: string): boolean {
  return IDEMPOTENT.has(method.toUpperCase());
}

/** Parses `timeout,connection`. An empty list or an unknown kind is a `ConfigError`. */
export function parseRetryOn(text: string): RetryKind[] {
  const kinds = text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (kinds.length === 0)
    throw new ConfigError('--retry-on needs at least one of timeout, connection');
  for (const k of kinds) {
    if (!(RETRY_KINDS as readonly string[]).includes(k)) {
      throw new ConfigError(`--retry-on ${k}: expected timeout or connection`);
    }
  }
  return [...new Set(kinds as RetryKind[])].sort();
}

/**
 * The wait before retry `attempt`, counted from 1: `base * 2^(attempt - 1)`
 * scaled by a factor drawn uniformly from 0.5 to 1, so sends that failed
 * together do not retry together.
 */
export function backoffMs(attempt: number, baseMs: number, random: () => number): number {
  return baseMs * 2 ** (attempt - 1) * (0.5 + random() * 0.5);
}
