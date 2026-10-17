import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  mergeHeaders,
  parseHeaderLine,
  parseHeadersText,
  type HeaderMap,
} from '@replay-parity/core';
import { InvalidArgumentError } from 'commander';

/** Option parsers shared by the commands. Each throws a message commander prints with usage. */

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

export function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('expected a non negative integer');
  }
  return n;
}

export function positiveNumber(value: string): number {
  const n = Number(value);
  if (!(n > 0)) throw new InvalidArgumentError('expected a positive number');
  return n;
}

export function fraction(value: string): number {
  const n = Number(value);
  if (!(n > 0 && n <= 1)) throw new InvalidArgumentError('expected a number above 0 and at most 1');
  return n;
}

export interface Listen {
  host: string;
  port: number;
}

/** `:8080`, `8080`, or `127.0.0.1:8080`. */
export function parseListen(value: string): Listen {
  const m = /^(?:([^:]*):)?(\d{1,5})$/.exec(value.trim());
  const port = m === null ? NaN : Number(m[2]);
  if (m === null || !(port >= 1 && port <= 65535)) {
    throw new InvalidArgumentError('expected [host]:port');
  }
  const host = m[1];
  return { host: host === undefined || host.length === 0 ? '0.0.0.0' : host, port };
}

/** `tag=<name>` is the only filter form. */
export function parseFilter(value: string): string {
  const m = /^tag=(.+)$/.exec(value.trim());
  if (!m) throw new InvalidArgumentError('expected tag=<name>');
  return m[1] as string;
}

export function parseHeaderOption(value: string): [string, string] {
  try {
    return parseHeaderLine(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

/** Headers from `--headers-file`, then `--header` entries on top. */
export async function resolveHeaders(
  headerOptions: readonly string[],
  headersFile: string | undefined,
): Promise<HeaderMap> {
  let headers: HeaderMap = {};
  if (headersFile !== undefined) {
    let text: string;
    try {
      text = await readFile(headersFile, 'utf8');
    } catch (err) {
      throw new ConfigError(`${headersFile}: ${(err as Error).message}`);
    }
    try {
      headers = parseHeadersText(text);
    } catch (err) {
      throw new ConfigError(`${headersFile}: ${(err as Error).message}`);
    }
  }
  const extra: HeaderMap = {};
  for (const line of headerOptions) {
    const [name, value] = parseHeaderLine(line);
    extra[name] = value;
  }
  return mergeHeaders(headers, extra);
}
