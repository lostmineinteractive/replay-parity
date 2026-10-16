import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ExchangeSchema, type Exchange } from './types.js';
import { formatZodError } from '../yaml.js';

export class RecordingParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`recording line ${line}: ${message}`);
    this.name = 'RecordingParseError';
    this.line = line;
  }
}

/** Parses one JSON Lines row. `lineNumber` is 1 based and used in error messages. */
export function parseExchangeLine(line: string, lineNumber: number): Exchange {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    throw new RecordingParseError(lineNumber, `invalid JSON (${(err as Error).message})`);
  }
  const result = ExchangeSchema.safeParse(raw);
  if (!result.success) {
    throw new RecordingParseError(lineNumber, formatZodError(result.error));
  }
  return result.data;
}

class OffsetGuard {
  private last = -Infinity;
  check(exchange: Exchange, lineNumber: number): void {
    if (exchange.offset_ms < this.last) {
      throw new RecordingParseError(
        lineNumber,
        `offset_ms ${exchange.offset_ms} is lower than the previous offset ${this.last}`,
      );
    }
    this.last = exchange.offset_ms;
  }
}

/** Parses a whole recording held in memory. Blank lines are skipped. */
export function parseRecordingText(text: string): Exchange[] {
  const guard = new OffsetGuard();
  const out: Exchange[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim().length === 0) continue;
    const exchange = parseExchangeLine(line, i + 1);
    guard.check(exchange, i + 1);
    out.push(exchange);
  }
  return out;
}

/** Streams a recording file one exchange at a time. */
export async function* iterateRecording(path: string): AsyncGenerator<Exchange, void, undefined> {
  const guard = new OffsetGuard();
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    const exchange = parseExchangeLine(line, lineNumber);
    guard.check(exchange, lineNumber);
    yield exchange;
  }
}

export async function readRecording(path: string): Promise<Exchange[]> {
  const out: Exchange[] = [];
  for await (const exchange of iterateRecording(path)) out.push(exchange);
  return out;
}
