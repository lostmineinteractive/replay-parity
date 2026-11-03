import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { matchGlob } from '../glob.js';
import { canonicalJson, isJsonObject, type JsonValue } from '../json.js';
import { get, isPlainPath, parsePath, renderPath, type Segment } from '../jsonpath/index.js';
import { captureSource, captureValue } from '../rules/capture.js';
import type { SubstitutionRule } from '../rules/schema.js';
import { ConfigError } from '../yaml.js';
import { bodyKind, type BodyFields } from './body.js';
import {
  iterateNumbered,
  iterateRecording,
  RecordingParseError,
  type NumberedExchange,
} from './reader.js';
import { REDACTED } from './redact.js';
import type { RecordingManifest } from './manifest.js';
import type { Exchange } from './types.js';
import { RecordingWriter, isGzipPath } from './writer.js';

/**
 * Operations over recording files: validate, stats, filter, sample, split,
 * merge, and scan. Every operation reads its input one line at a time, so a
 * recording larger than memory is handled, with two stated exceptions:
 * a filter that pulls in dependencies needs the whole list (the caller
 * reads it and passes an index), and merge keeps one exchange per input in
 * memory plus the set of ids. No operation alters its input.
 */

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/** Runs `fn` and turns a file system error into a `ConfigError` naming the path. */
async function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isErrno(err)) throw new ConfigError(`${path}: ${err.message}`);
    throw err;
  }
}

// Validate

/**
 * Streams a recording like `iterateRecording` and yields the line number of
 * each exchange with it. Blank lines and a leading manifest are skipped and
 * counted.
 */
export function iterateRecordingLines(
  path: string,
): AsyncGenerator<NumberedExchange, void, undefined> {
  return iterateNumbered(path);
}

export interface ValidationProblem {
  /** 1 based line number of the first problem. */
  line: number;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Exchanges parsed before the first problem, or all of them. */
  exchanges: number;
  problem: ValidationProblem | null;
  first_offset_ms: number | null;
  last_offset_ms: number | null;
  by_tag: Record<string, number>;
  /** The manifest on the first line, or null when the file has none. */
  manifest: RecordingManifest | null;
}

/**
 * Parses every line, checks that `offset_ms` never decreases and that no id
 * repeats, and reports the first problem with its line number. Counts cover
 * the exchanges before the problem.
 */
export async function validateRecording(path: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    ok: true,
    exchanges: 0,
    problem: null,
    first_offset_ms: null,
    last_offset_ms: null,
    by_tag: {},
    manifest: null,
  };
  const seen = new Map<string, number>();
  await withPath(path, async () => {
    try {
      const numbered = iterateNumbered(path, (manifest) => {
        result.manifest = manifest;
      });
      for await (const { line, exchange } of numbered) {
        const first = seen.get(exchange.id);
        if (first !== undefined) {
          throw new RecordingParseError(
            line,
            `id ${exchange.id} repeats; it was first seen on line ${first}`,
          );
        }
        seen.set(exchange.id, line);
        result.exchanges += 1;
        result.first_offset_ms ??= exchange.offset_ms;
        result.last_offset_ms = exchange.offset_ms;
        for (const tag of exchange.tags) result.by_tag[tag] = (result.by_tag[tag] ?? 0) + 1;
      }
    } catch (err) {
      if (!(err instanceof RecordingParseError)) throw err;
      result.ok = false;
      result.problem = { line: err.line, message: err.message };
    }
  });
  return result;
}

// Stats

export interface SizeSummary {
  /** Exchanges with a body on this side. */
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface ProducerStats {
  name: string;
  tag: string;
  path: string;
  /** Exchanges carrying the tag whose response has a leaf at the path. */
  producers: number;
  distinct_values: number;
}

export interface LargestGap {
  ms: number;
  from_offset_ms: number;
  to_offset_ms: number;
  /** The exchange the gap follows. */
  after_id: string;
}

export interface RecordingStats {
  exchanges: number;
  untagged: number;
  first_ts: string | null;
  last_ts: string | null;
  first_offset_ms: number | null;
  last_offset_ms: number | null;
  span_ms: number;
  /** Null with fewer than two exchanges. */
  largest_gap: LargestGap | null;
  by_tag: Record<string, number>;
  by_method: Record<string, number>;
  by_status_class: Record<string, number>;
  body_bytes: { request: SizeSummary; response: SizeSummary };
  /** One entry per substitution rule given. Empty without rules. */
  producers: ProducerStats[];
}

/** Bytes of the stored body: the decoded size, the hash size for a truncated body, null when absent. */
export function storedBodyBytes(fields: BodyFields): number | null {
  switch (bodyKind(fields)) {
    case 'absent':
      return null;
    case 'truncated':
      return fields.body_size as number;
    case 'base64': {
      const text = fields.body as string;
      const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
      return Math.floor((text.length * 3) / 4) - padding;
    }
    case 'json':
      return Buffer.byteLength(JSON.stringify(fields.body), 'utf8');
  }
}

/** Nearest rank percentiles. One value is its own every percentile. */
export function summarizeSizes(values: readonly number[]): SizeSummary {
  if (values.length === 0) return { count: 0, p50: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const at = (pct: number): number =>
    sorted[Math.min(n - 1, Math.max(0, Math.ceil((pct / 100) * n) - 1))] as number;
  return { count: n, p50: at(50), p90: at(90), p99: at(99), max: sorted[n - 1] as number };
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function bump(table: Record<string, number>, key: string): void {
  table[key] = (table[key] ?? 0) + 1;
}

interface ProducerCounter {
  rule: SubstitutionRule;
  producers: number;
  values: Set<string>;
}

/** Accumulates `RecordingStats` one exchange at a time. */
export class RecordingStatsCollector {
  private readonly counters: ProducerCounter[];
  private readonly requestSizes: number[] = [];
  private readonly responseSizes: number[] = [];
  private readonly stats: RecordingStats = {
    exchanges: 0,
    untagged: 0,
    first_ts: null,
    last_ts: null,
    first_offset_ms: null,
    last_offset_ms: null,
    span_ms: 0,
    largest_gap: null,
    by_tag: {},
    by_method: {},
    by_status_class: {},
    body_bytes: { request: summarizeSizes([]), response: summarizeSizes([]) },
    producers: [],
  };
  private previous: Exchange | null = null;

  constructor(rules: readonly SubstitutionRule[] = []) {
    this.counters = rules.map((rule) => ({
      rule,
      producers: 0,
      values: new Set<string>(),
    }));
  }

  add(e: Exchange): void {
    const s = this.stats;
    s.exchanges += 1;
    s.first_ts ??= e.ts;
    s.last_ts = e.ts;
    s.first_offset_ms ??= e.offset_ms;
    s.last_offset_ms = e.offset_ms;
    if (this.previous !== null) {
      const gap = e.offset_ms - this.previous.offset_ms;
      if (s.largest_gap === null || gap > s.largest_gap.ms) {
        s.largest_gap = {
          ms: gap,
          from_offset_ms: this.previous.offset_ms,
          to_offset_ms: e.offset_ms,
          after_id: this.previous.id,
        };
      }
    }
    this.previous = e;
    if (e.tags.length === 0) s.untagged += 1;
    for (const tag of e.tags) bump(s.by_tag, tag);
    bump(s.by_method, e.request.method.toUpperCase());
    bump(s.by_status_class, statusClass(e.response.status));
    const requestBytes = storedBodyBytes(e.request);
    if (requestBytes !== null) this.requestSizes.push(requestBytes);
    const responseBytes = storedBodyBytes(e.response);
    if (responseBytes !== null) this.responseSizes.push(responseBytes);
    for (const counter of this.counters) {
      if (!e.tags.includes(counter.rule.capture.tag)) continue;
      const value = captureValue(counter.rule.capture, e.response, e.request);
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      counter.producers += 1;
      counter.values.add(canonicalJson(value));
    }
  }

  finish(): RecordingStats {
    const s = this.stats;
    s.span_ms =
      s.first_offset_ms === null || s.last_offset_ms === null
        ? 0
        : s.last_offset_ms - s.first_offset_ms;
    s.body_bytes = {
      request: summarizeSizes(this.requestSizes),
      response: summarizeSizes(this.responseSizes),
    };
    s.producers = this.counters.map((c) => ({
      name: c.rule.name,
      tag: c.rule.capture.tag,
      path: captureSource(c.rule.capture),
      producers: c.producers,
      distinct_values: c.values.size,
    }));
    return s;
  }
}

export interface StatsOptions {
  /** Substitution rules whose producers are counted. */
  rules?: readonly SubstitutionRule[] | undefined;
}

export async function recordingStats(
  path: string,
  options: StatsOptions = {},
): Promise<RecordingStats> {
  const collector = new RecordingStatsCollector(options.rules ?? []);
  await withPath(path, async () => {
    for await (const e of iterateRecording(path)) collector.add(e);
  });
  return collector.finish();
}

// Filter

export interface FilterCriteria {
  /** Keep exchanges carrying any of these tags. */
  tags?: readonly string[] | undefined;
  /** Keep exchanges with any of these methods, compared without case. */
  methods?: readonly string[] | undefined;
  /** Keep exchanges whose path matches any of these globs. */
  paths?: readonly string[] | undefined;
  /** Keep exchanges whose status matches any of these, as `2xx` or `404`. */
  statuses?: readonly string[] | undefined;
  /** Keep exchanges with `offset_ms` at or above this. */
  fromMs?: number | null | undefined;
  /** Keep exchanges with `offset_ms` at or below this. */
  toMs?: number | null | undefined;
}

/** Parses `2xx` or an exact code such as `404` into a predicate. */
export function parseStatusSelector(text: string): (status: number) => boolean {
  const cls = /^([1-5])xx$/i.exec(text.trim());
  if (cls !== null) {
    const hundreds = Number(cls[1]);
    return (status) => Math.floor(status / 100) === hundreds;
  }
  if (/^[1-5]\d\d$/.test(text.trim())) {
    const code = Number(text.trim());
    return (status) => status === code;
  }
  throw new ConfigError(`status ${JSON.stringify(text)}: expected a class such as 2xx or a code`);
}

/** Compiles the criteria into one predicate. Each list matches any of its entries; the lists are combined with and. */
export function compileFilter(criteria: FilterCriteria): (e: Exchange) => boolean {
  const tags = criteria.tags === undefined ? null : new Set(criteria.tags);
  const methods =
    criteria.methods === undefined ? null : new Set(criteria.methods.map((m) => m.toUpperCase()));
  const paths = criteria.paths ?? null;
  const statuses =
    criteria.statuses === undefined ? null : criteria.statuses.map(parseStatusSelector);
  const fromMs = criteria.fromMs ?? null;
  const toMs = criteria.toMs ?? null;
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new ConfigError(`the window is empty: from ${fromMs} ms is after to ${toMs} ms`);
  }
  return (e) => {
    if (tags !== null && tags.size > 0 && !e.tags.some((t) => tags.has(t))) return false;
    if (methods !== null && methods.size > 0 && !methods.has(e.request.method.toUpperCase())) {
      return false;
    }
    if (paths !== null && paths.length > 0 && !paths.some((g) => matchGlob(g, e.request.path))) {
      return false;
    }
    if (statuses !== null && statuses.length > 0 && !statuses.some((s) => s(e.response.status))) {
      return false;
    }
    if (fromMs !== null && e.offset_ms < fromMs) return false;
    if (toMs !== null && e.offset_ms > toMs) return false;
    return true;
  };
}

/**
 * Closes a chosen set of indices over the producers they depend on,
 * transitively. `dependenciesOf(i)` returns the indices of earlier exchanges
 * that produce a value the exchange at `i` uses. Returns the indices pulled
 * in, not counting the chosen ones.
 */
export function closeOverProducers(
  chosen: readonly number[],
  dependenciesOf: (index: number) => readonly number[],
): Set<number> {
  const pulled = new Set<number>();
  const seen = new Set(chosen);
  const queue = [...chosen];
  while (queue.length > 0) {
    const i = queue.pop() as number;
    for (const producer of dependenciesOf(i)) {
      if (seen.has(producer)) continue;
      seen.add(producer);
      pulled.add(producer);
      queue.push(producer);
    }
  }
  return pulled;
}

export interface Selection {
  /** The kept exchanges in recording order. */
  kept: Exchange[];
  /** How many of them were pulled in as producers. */
  dependencies: number;
}

/**
 * Applies the predicate to a list held in memory and, when `dependenciesOf`
 * is given, keeps the producers the kept exchanges need as well.
 */
export function filterExchanges(
  all: readonly Exchange[],
  keep: (e: Exchange) => boolean,
  dependenciesOf?: (index: number) => readonly number[],
): Selection {
  const chosen: number[] = [];
  all.forEach((e, i) => {
    if (keep(e)) chosen.push(i);
  });
  const pulled =
    dependenciesOf === undefined ? new Set<number>() : closeOverProducers(chosen, dependenciesOf);
  const order = [...chosen, ...pulled].sort((a, b) => a - b);
  return { kept: order.map((i) => all[i] as Exchange), dependencies: pulled.size };
}

/** Opens a writer that truncates the file, naming the path when that fails. */
async function openOutput(path: string): Promise<RecordingWriter> {
  try {
    return await RecordingWriter.open(path, { append: false });
  } catch (err) {
    if (isErrno(err)) throw new ConfigError(`${path}: ${err.message}`);
    throw err;
  }
}

/**
 * Writes exchanges with `offset_ms` rebased so the first is at 0 and every
 * gap is kept. The file is truncated first. Returns how many were written.
 */
export async function writeRebased(
  path: string,
  exchanges: Iterable<Exchange> | AsyncIterable<Exchange>,
): Promise<number> {
  const writer = await openOutput(path);
  let base: number | null = null;
  try {
    for await (const e of exchanges) {
      base ??= e.offset_ms;
      await writer.write({ ...e, offset_ms: e.offset_ms - base });
    }
  } finally {
    await writer.close();
  }
  return writer.count;
}

export interface FilterResult {
  read: number;
  kept: number;
}

/** Streams the input through the predicate into a rebased output. */
export async function filterRecording(
  inPath: string,
  outPath: string,
  criteria: FilterCriteria,
): Promise<FilterResult> {
  const keep = compileFilter(criteria);
  let read = 0;
  const matching = async function* (): AsyncGenerator<Exchange> {
    for await (const e of iterateRecording(inPath)) {
      read += 1;
      if (keep(e)) yield e;
    }
  };
  const kept = await withPath(inPath, () => writeRebased(outPath, matching()));
  return { read, kept };
}

// Sample

/** A small deterministic generator (mulberry32) for sampling with a seed. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [0, 1) that depends only on the seed and the key. */
export function bucketOf(seed: number, key: string): number {
  const digest = createHash('sha256').update(`${seed}\n${key}`).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/**
 * The session key of an exchange: the value of the request header named by
 * `selector`, or the leaf at `selector` in the request body when it starts
 * with `$`. Null when the exchange has none.
 */
export function sessionKeyOf(e: Exchange, selector: string): string | null {
  if (selector.startsWith('$')) {
    const value = get(e.request.body, selector);
    if (typeof value === 'string' || typeof value === 'number') return canonicalJson(value);
    return null;
  }
  return e.request.headers[selector.toLowerCase()] ?? null;
}

export interface SampleOptions {
  /** Fraction to keep, above 0 and at most 1. */
  fraction: number;
  seed: number;
  /** A request header name or a request body JSONPath. Whole sessions are kept or dropped. */
  bySession?: string | undefined;
}

export interface SampleResult {
  read: number;
  kept: number;
  /** Distinct session keys seen, when sampling by session. */
  sessions: number | null;
  /** Exchanges without a session key, always kept, when sampling by session. */
  keyless: number | null;
}

/**
 * Keeps a random fraction of the exchanges, or whole sessions when
 * `bySession` is given. The same seed gives the same output. An exchange
 * with no session key is kept, so controls and health checks stay.
 */
export async function sampleRecording(
  inPath: string,
  outPath: string,
  options: SampleOptions,
): Promise<SampleResult> {
  if (!(options.fraction > 0 && options.fraction <= 1)) {
    throw new ConfigError(`fraction must be above 0 and at most 1, got ${options.fraction}`);
  }
  if (options.bySession?.startsWith('$')) {
    let plain: boolean;
    try {
      plain = isPlainPath(parsePath(options.bySession));
    } catch (err) {
      throw new ConfigError(`session selector: ${(err as Error).message}`);
    }
    if (!plain) {
      throw new ConfigError(
        'session selector: filters and recursive descent apply to diff rules only',
      );
    }
  }
  const random = createRandom(options.seed);
  const sessions = new Set<string>();
  const result: SampleResult = {
    read: 0,
    kept: 0,
    sessions: options.bySession === undefined ? null : 0,
    keyless: options.bySession === undefined ? null : 0,
  };
  const chosen = async function* (): AsyncGenerator<Exchange> {
    for await (const e of iterateRecording(inPath)) {
      result.read += 1;
      let keep: boolean;
      if (options.bySession === undefined) {
        keep = random() < options.fraction;
      } else {
        const key = sessionKeyOf(e, options.bySession);
        if (key === null) {
          result.keyless = (result.keyless ?? 0) + 1;
          keep = true;
        } else {
          sessions.add(key);
          keep = bucketOf(options.seed, key) < options.fraction;
        }
      }
      if (keep) yield e;
    }
  };
  result.kept = await withPath(inPath, () => writeRebased(outPath, chosen()));
  if (options.bySession !== undefined) result.sessions = sessions.size;
  return result;
}

// Split

export interface SplitOptions {
  /** Exchanges per part. */
  every?: number | undefined;
  /** Milliseconds of recorded time per part, from the first exchange. */
  everyMs?: number | undefined;
}

export interface SplitPart {
  path: string;
  exchanges: number;
  first_offset_ms: number;
  last_offset_ms: number;
}

export interface SplitResult {
  read: number;
  parts: SplitPart[];
}

/** `recording.jsonl` and 3 give `recording-0003.jsonl`; a gzip input gives gzip parts, `recording-0003.jsonl.gz`. */
export function partFileName(inPath: string, index: number): string {
  const gzip = isGzipPath(inPath);
  const stem = basename(inPath).replace(/(\.jsonl)?(\.gz)?$/i, '');
  return `${stem}-${String(index).padStart(4, '0')}.jsonl${gzip ? '.gz' : ''}`;
}

/**
 * Writes consecutive parts of the input into `outDir`, each rebased so its
 * first exchange is at 0. By count, every part but the last has `every`
 * exchanges. By time, a part holds the exchanges of one window of `everyMs`
 * from the first exchange's offset, and a window with no exchange gets no
 * file. Parts are numbered from 1 in order.
 */
export async function splitRecording(
  inPath: string,
  outDir: string,
  options: SplitOptions,
): Promise<SplitResult> {
  const byCount = options.every !== undefined;
  const byTime = options.everyMs !== undefined;
  if (byCount === byTime) throw new ConfigError('split needs exactly one of every and everyMs');
  if (byCount && !(Number.isInteger(options.every) && (options.every as number) >= 1)) {
    throw new ConfigError(`every must be a positive integer, got ${options.every}`);
  }
  if (byTime && !((options.everyMs as number) > 0)) {
    throw new ConfigError(`everyMs must be positive, got ${options.everyMs}`);
  }
  await mkdir(outDir, { recursive: true });
  const result: SplitResult = { read: 0, parts: [] };
  interface OpenPart {
    writer: RecordingWriter;
    part: SplitPart;
    /** The recorded offset of the part's first exchange. */
    base: number;
  }
  let current: OpenPart | null = null;
  let window = -1;
  let firstOffset: number | null = null;
  const finish = async (open: OpenPart): Promise<void> => {
    await open.writer.close();
    result.parts.push(open.part);
  };
  await withPath(inPath, async () => {
    try {
      for await (const e of iterateRecording(inPath)) {
        result.read += 1;
        firstOffset ??= e.offset_ms;
        const next = byCount
          ? Math.floor((result.read - 1) / (options.every as number))
          : Math.floor((e.offset_ms - firstOffset) / (options.everyMs as number));
        if (current === null || next !== window) {
          if (current !== null) {
            await finish(current);
            current = null;
          }
          window = next;
          const path = join(outDir, partFileName(inPath, result.parts.length + 1));
          current = {
            writer: await RecordingWriter.open(path, { append: false }),
            part: { path, exchanges: 0, first_offset_ms: e.offset_ms, last_offset_ms: e.offset_ms },
            base: e.offset_ms,
          };
        }
        await current.writer.write({ ...e, offset_ms: e.offset_ms - current.base });
        current.part.exchanges += 1;
        current.part.last_offset_ms = e.offset_ms;
      }
      if (current !== null) {
        await finish(current);
        current = null;
      }
    } finally {
      // Closing twice is harmless, so a part left open by an error is closed here.
      if (current !== null) await current.writer.close();
    }
  });
  return result;
}

// Merge

export interface MergeResult {
  exchanges: number;
  inputs: number;
  first_ts: string | null;
  last_ts: string | null;
}

/**
 * Merges recordings by `ts` into one file with `offset_ms` recomputed from
 * the first merged exchange. Every input must be ordered by `ts`, which a
 * capture always is, and no id may appear twice across the inputs. The
 * inputs are checked in a first pass, so nothing is written when one fails.
 */
export async function mergeRecordings(
  inputs: readonly string[],
  outPath: string,
): Promise<MergeResult> {
  if (inputs.length === 0) throw new ConfigError('merge needs at least one input');
  const owners = new Map<string, string>();
  for (const path of inputs) {
    await withPath(path, async () => {
      let lastTs = -Infinity;
      let ordinal = 0;
      for await (const e of iterateRecording(path)) {
        ordinal += 1;
        const owner = owners.get(e.id);
        if (owner !== undefined) {
          throw new ConfigError(
            `id ${e.id} appears in both ${owner} and ${path}; merge needs distinct ids`,
          );
        }
        owners.set(e.id, path);
        const ts = Date.parse(e.ts);
        if (ts < lastTs) {
          throw new ConfigError(
            `${path}: exchange ${ordinal} (${e.id}) has a ts earlier than the one before it; merge needs each input ordered by ts`,
          );
        }
        lastTs = ts;
      }
    });
  }
  interface Head {
    iterator: AsyncGenerator<Exchange, void, undefined>;
    exchange: Exchange;
    ts: number;
    index: number;
  }
  const heads: Head[] = [];
  const advance = async (head: Head): Promise<void> => {
    const next = await head.iterator.next();
    if (next.done === true) {
      heads.splice(heads.indexOf(head), 1);
      return;
    }
    head.exchange = next.value;
    head.ts = Date.parse(next.value.ts);
  };
  for (const [index, path] of inputs.entries()) {
    const iterator = iterateRecording(path);
    const first = await iterator.next();
    if (first.done === true) continue;
    heads.push({ iterator, exchange: first.value, ts: Date.parse(first.value.ts), index });
  }
  const merged = async function* (): AsyncGenerator<Exchange> {
    let base: number | null = null;
    while (heads.length > 0) {
      let pick = heads[0] as Head;
      for (const head of heads) {
        if (head.ts < pick.ts || (head.ts === pick.ts && head.index < pick.index)) pick = head;
      }
      base ??= pick.ts;
      yield { ...pick.exchange, offset_ms: pick.ts - base };
      await advance(pick);
    }
  };
  const result: MergeResult = {
    exchanges: 0,
    inputs: inputs.length,
    first_ts: null,
    last_ts: null,
  };
  const writer = await openOutput(outPath);
  try {
    for await (const e of merged()) {
      await writer.write(e);
      result.first_ts ??= e.ts;
      result.last_ts = e.ts;
    }
  } finally {
    await writer.close();
    for (const head of heads) await head.iterator.return();
  }
  result.exchanges = writer.count;
  return result;
}

// Scan

export type ScanKind =
  'email' | 'phone' | 'luhn-number' | 'ipv4' | 'date-of-birth' | 'high-entropy' | 'hex-token';

export interface ScanFinding {
  /** Where the value sits, such as `request.body:$.customer.email` or `request.headers:x-api-key`. */
  location: string;
  kind: ScanKind;
  count: number;
  /** One value seen there, masked. */
  example: string;
}

export interface RedactedCount {
  location: string;
  count: number;
}

export interface ScanReport {
  exchanges: number;
  /** Header and query values already replaced by the redaction marker. */
  redacted: RedactedCount[];
  findings: ScanFinding[];
}

/** Bits per character over the distribution of characters in the text. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** The Luhn check over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Keeps the first and last two characters and hides the rest. Short values are hidden whole. */
export function maskValue(text: string): string {
  if (text.length <= 4) return '*'.repeat(text.length);
  const hidden = Math.min(text.length - 4, 36);
  return `${text.slice(0, 2)}${'*'.repeat(hidden)}${text.slice(-2)}`;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const DIGIT_RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.])`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const BIRTH_KEY = /birth|dob/i;
const HEX_TOKEN = /^[0-9a-f]{32,}$/i;

/** Entropy at or above this, over a run longer than 20 characters, is reported. */
export const HIGH_ENTROPY_BITS = 4;
export const HIGH_ENTROPY_MIN_LENGTH = 21;

/** Transport headers whose values are never a secret and are skipped by the entropy check. */
export const SCAN_SKIPPED_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'age',
  'allow',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-type',
  'date',
  'etag',
  'expires',
  'host',
  'keep-alive',
  'last-modified',
  'pragma',
  'server',
  'strict-transport-security',
  'transfer-encoding',
  'user-agent',
  'vary',
  'via',
  'x-powered-by',
];

/** The kinds a body or query leaf matches. `key` is the last path segment, for the date of birth rule. */
export function detectPatterns(value: JsonValue, key: string | null): ScanKind[] {
  const out: ScanKind[] = [];
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      const digits = String(Math.abs(value));
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) out.push('luhn-number');
    }
    return out;
  }
  if (typeof value !== 'string') return out;
  if (EMAIL.test(value)) out.push('email');
  if (PHONE.test(value.trim())) out.push('phone');
  for (const run of value.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      out.push('luhn-number');
      break;
    }
  }
  if (IPV4.test(value)) out.push('ipv4');
  if (key !== null && BIRTH_KEY.test(key) && ISO_DATE.test(value)) out.push('date-of-birth');
  return out;
}

/** The kind a header or query value matches by its shape, or null. The redaction marker is skipped. */
export function detectToken(value: string): 'high-entropy' | 'hex-token' | null {
  if (value === REDACTED) return null;
  const longest = value.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length >= HIGH_ENTROPY_MIN_LENGTH && shannonEntropy(longest) >= HIGH_ENTROPY_BITS) {
    return 'high-entropy';
  }
  if (HEX_TOKEN.test(longest)) return 'hex-token';
  return null;
}

function generalize(segments: readonly Segment[]): string {
  return renderPath(segments.map((s) => (s.type === 'index' ? { type: 'wildcard' } : s)));
}

function* leaves(
  value: JsonValue,
  segments: Segment[],
): Generator<{ segments: Segment[]; key: string | null; value: JsonValue }> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      yield* leaves(item, [...segments, { type: 'index', index }]);
    }
  } else if (isJsonObject(value)) {
    for (const [name, item] of Object.entries(value)) {
      yield* leaves(item, [...segments, { type: 'key', name }]);
    }
  } else {
    const last = segments[segments.length - 1];
    yield { segments, key: last?.type === 'key' ? last.name : null, value };
  }
}

/** Accumulates a `ScanReport` one exchange at a time. */
export class RecordingScanner {
  private exchanges = 0;
  private readonly redacted = new Map<string, number>();
  private readonly findings = new Map<string, ScanFinding>();

  private note(location: string, kind: ScanKind, value: string): void {
    const id = `${location}\n${kind}`;
    const found = this.findings.get(id);
    if (found !== undefined) {
      found.count += 1;
      return;
    }
    this.findings.set(id, { location, kind, count: 1, example: maskValue(value) });
  }

  private scanBody(
    location: string,
    body: JsonValue | undefined,
    encoding: string | undefined,
  ): void {
    // A base64 body is bytes, not fields, and is not scanned.
    if (body === undefined || encoding !== undefined) return;
    for (const leaf of leaves(body, [])) {
      const kinds = detectPatterns(leaf.value, leaf.key);
      if (kinds.length === 0) continue;
      const where = `${location}:${generalize(leaf.segments)}`;
      const text = typeof leaf.value === 'string' ? leaf.value : JSON.stringify(leaf.value);
      for (const kind of kinds) this.note(where, kind, text);
    }
  }

  private scanHeaders(location: string, headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) {
      const where = `${location}:${name.toLowerCase()}`;
      if (value === REDACTED) {
        this.redacted.set(where, (this.redacted.get(where) ?? 0) + 1);
        continue;
      }
      if (SCAN_SKIPPED_HEADERS.includes(name.toLowerCase())) continue;
      const kind = detectToken(value);
      if (kind !== null) this.note(where, kind, value);
    }
  }

  private scanQuery(query: Record<string, string | string[]>): void {
    for (const [name, raw] of Object.entries(query)) {
      const where = `request.query:${name}`;
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (value === REDACTED) {
          this.redacted.set(where, (this.redacted.get(where) ?? 0) + 1);
          continue;
        }
        for (const kind of detectPatterns(value, name)) this.note(where, kind, value);
        const token = detectToken(value);
        if (token !== null) this.note(where, token, value);
      }
    }
  }

  add(e: Exchange): void {
    this.exchanges += 1;
    this.scanHeaders('request.headers', e.request.headers);
    this.scanHeaders('response.headers', e.response.headers);
    this.scanQuery(e.request.query);
    this.scanBody('request.body', e.request.body, e.request.encoding);
    this.scanBody('response.body', e.response.body, e.response.encoding);
  }

  finish(): ScanReport {
    const byLocation = (a: { location: string }, b: { location: string }): number =>
      a.location.localeCompare(b.location);
    return {
      exchanges: this.exchanges,
      redacted: [...this.redacted.entries()]
        .map(([location, count]) => ({ location, count }))
        .sort(byLocation),
      findings: [...this.findings.values()].sort(
        (a, b) => byLocation(a, b) || a.kind.localeCompare(b.kind),
      ),
    };
  }
}

export async function scanRecording(path: string): Promise<ScanReport> {
  const scanner = new RecordingScanner();
  await withPath(path, async () => {
    for await (const e of iterateRecording(path)) scanner.add(e);
  });
  return scanner.finish();
}
