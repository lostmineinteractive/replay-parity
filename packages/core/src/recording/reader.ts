import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ExchangeSchema, type Exchange } from './types.js';
import { isManifestRecord, parseManifestRecord, type RecordingManifest } from './manifest.js';
import { formatZodError } from '../yaml.js';

export class RecordingParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`recording line ${line}: ${message}`);
    this.name = 'RecordingParseError';
    this.line = line;
  }
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new RecordingParseError(lineNumber, `invalid JSON (${(err as Error).message})`);
  }
}

function toExchange(raw: unknown, lineNumber: number): Exchange {
  const result = ExchangeSchema.safeParse(raw);
  if (!result.success) {
    throw new RecordingParseError(lineNumber, formatZodError(result.error));
  }
  return result.data;
}

function toManifest(raw: unknown, lineNumber: number): RecordingManifest {
  try {
    return parseManifestRecord(raw);
  } catch (err) {
    throw new RecordingParseError(lineNumber, (err as Error).message);
  }
}

/** Parses one JSON Lines row. `lineNumber` is 1 based and used in error messages. */
export function parseExchangeLine(line: string, lineNumber: number): Exchange {
  return toExchange(parseJsonLine(line, lineNumber), lineNumber);
}

/** One row of a recording: the manifest or an exchange. */
export type RecordingRecord =
  { kind: 'manifest'; manifest: RecordingManifest } | { kind: 'exchange'; exchange: Exchange };

/**
 * Parses one row that may be the manifest. `first` is true for the first
 * row that is not blank, the only place a manifest may stand.
 */
export function parseRecordingLine(
  line: string,
  lineNumber: number,
  first: boolean,
): RecordingRecord {
  const raw = parseJsonLine(line, lineNumber);
  if (isManifestRecord(raw)) {
    if (!first) {
      throw new RecordingParseError(lineNumber, 'a manifest may only be the first line');
    }
    return { kind: 'manifest', manifest: toManifest(raw, lineNumber) };
  }
  return { kind: 'exchange', exchange: toExchange(raw, lineNumber) };
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

/** Parses a whole recording held in memory. Blank lines and a leading manifest are skipped. */
export function parseRecordingText(text: string): Exchange[] {
  const guard = new OffsetGuard();
  const out: Exchange[] = [];
  const lines = text.split(/\r?\n/);
  let first = true;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim().length === 0) continue;
    const record = parseRecordingLine(line, i + 1, first);
    first = false;
    if (record.kind === 'manifest') continue;
    guard.check(record.exchange, i + 1);
    out.push(record.exchange);
  }
  return out;
}

/**
 * The text lines of a recording file, with the stream closed when the
 * consumer stops early.
 */
export async function* readRecordingTextLines(
  path: string,
): AsyncGenerator<string, void, undefined> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}

/** An exchange with its 1 based line number in the file. */
export interface NumberedExchange {
  /** 1 based line number in the file. */
  line: number;
  exchange: Exchange;
}

/**
 * Streams the exchanges of a recording with their line numbers. Blank
 * lines are skipped and counted. The manifest, when the file has one, is
 * handed to `onManifest` before the first exchange and is not yielded.
 */
export async function* iterateNumbered(
  path: string,
  onManifest: (manifest: RecordingManifest | null) => void = () => undefined,
): AsyncGenerator<NumberedExchange, void, undefined> {
  const guard = new OffsetGuard();
  let lineNumber = 0;
  let first = true;
  for await (const text of readRecordingTextLines(path)) {
    lineNumber += 1;
    if (text.trim().length === 0) continue;
    const record = parseRecordingLine(text, lineNumber, first);
    if (first) onManifest(record.kind === 'manifest' ? record.manifest : null);
    first = false;
    if (record.kind === 'manifest') continue;
    guard.check(record.exchange, lineNumber);
    yield { line: lineNumber, exchange: record.exchange };
  }
  if (first) onManifest(null);
}

/**
 * The exchanges of a recording, one at a time, with the file's manifest on
 * the side. `manifest` is `undefined` until the first line has been read,
 * then the manifest or `null` for a file without one. The exchanges are the
 * same whether or not the file has a manifest.
 */
export interface RecordingIterator extends AsyncGenerator<Exchange, void, undefined> {
  readonly manifest: RecordingManifest | null | undefined;
}

/**
 * Streams a recording file one exchange at a time. A consumer that stops
 * early closes the file: the stream is destroyed when the generator returns.
 */
export function iterateRecording(path: string): RecordingIterator {
  let manifest: RecordingManifest | null | undefined;
  const exchanges = async function* (): AsyncGenerator<Exchange, void, undefined> {
    for await (const { exchange } of iterateNumbered(path, (m) => {
      manifest = m;
    })) {
      yield exchange;
    }
  };
  const iterator = exchanges();
  Object.defineProperty(iterator, 'manifest', { get: () => manifest, enumerable: true });
  return iterator as RecordingIterator;
}

/**
 * Reads the manifest of a recording: the first line that is not blank when
 * it is a manifest, otherwise null. Reads no further than that line.
 */
export async function readRecordingManifest(path: string): Promise<RecordingManifest | null> {
  let lineNumber = 0;
  for await (const text of readRecordingTextLines(path)) {
    lineNumber += 1;
    if (text.trim().length === 0) continue;
    const raw = parseJsonLine(text, lineNumber);
    return isManifestRecord(raw) ? toManifest(raw, lineNumber) : null;
  }
  return null;
}

export async function readRecording(path: string): Promise<Exchange[]> {
  const out: Exchange[] = [];
  for await (const exchange of iterateRecording(path)) out.push(exchange);
  return out;
}
