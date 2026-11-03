import {
  ConfigError,
  compilePattern,
  get,
  parseInvariantSource,
  parsePath,
  type Exchange,
  type InvariantSource,
  type JsonValue,
} from '@replay-parity/core';
import type { BaseCommand } from '../module.js';

/** One exchange as the declarative rules see it. */
export interface ExchangeCommand extends BaseCommand {
  kind: 'reset' | 'write' | 'read';
  index: number;
  exchange: Exchange;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Maps an exchange to a command: `reset` for the reset tag, `read` for a safe method, `write` otherwise. */
export function parseExchangeCommand(
  exchange: Exchange,
  index: number,
  resetTag: string | undefined,
): ExchangeCommand {
  const { response } = exchange;
  const kind =
    resetTag !== undefined && exchange.tags.includes(resetTag)
      ? 'reset'
      : READ_METHODS.has(exchange.request.method.toUpperCase())
        ? 'read'
        : 'write';
  return {
    kind,
    index,
    id: exchange.id,
    sentMs: exchange.offset_ms,
    ackedMs: exchange.offset_ms + response.latency_ms,
    accepted: response.status >= 200 && response.status < 300,
    exchange,
  };
}

/** A parsed source, ready to read. */
export interface Source {
  text: string;
  source: InvariantSource;
}

export function compileSource(text: string): Source {
  const source = parseInvariantSource(text);
  if (typeof source === 'string') throw new ConfigError(`invariant source ${text}: ${source}`);
  if (source.type === 'body') parsePath(source.path);
  return { text, source };
}

/** The value a source reads from one exchange, or undefined when it is absent. */
export function readSource(src: Source, exchange: Exchange): JsonValue | undefined {
  const s = src.source;
  switch (s.type) {
    case 'body': {
      const side = s.from === 'request' ? exchange.request : exchange.response;
      if (side.encoding === 'base64' || side.truncated) return undefined;
      return get(side.body, s.path);
    }
    case 'header': {
      const side = s.from === 'request' ? exchange.request : exchange.response;
      return side.headers[s.name];
    }
    case 'query': {
      const value = exchange.request.query[s.name];
      return Array.isArray(value) ? value[0] : value;
    }
    case 'path': {
      const m = compilePattern(s.pattern).exec(exchange.request.path.split('?')[0] ?? '');
      if (m === null) return undefined;
      return m[1] ?? m[0];
    }
  }
}

/** The value as a key: a string, or a number in its text form. Anything else is no key. */
export function readKey(src: Source, exchange: Exchange): string | undefined {
  const value = readSource(src, exchange);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** A finite number, or the number a numeric string spells. */
export function asNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** True when `a` was acknowledged before `b` was sent, so `b` saw the effect of `a`. */
export function before(a: BaseCommand, b: BaseCommand): boolean {
  return a.ackedMs <= b.sentMs;
}

/** True when the command carries the tag, or when no tag is required. */
export function tagged(command: ExchangeCommand, tag: string | undefined): boolean {
  return tag === undefined || command.exchange.tags.includes(tag);
}

/** Two numbers equal within rounding of a decimal sum. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
