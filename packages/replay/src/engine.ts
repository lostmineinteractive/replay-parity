import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  exchangeContext,
  ConfigError,
  DEFAULT_REDACTED_HEADERS,
  REDACTED,
  StatsCollector,
  createDiffer,
  decideVerdict,
  dropRedactedHeaders,
  emptyRules,
  emptyThresholds,
  evaluateThresholds,
  hashRecordingFile,
  mergeHeaders,
  noopLogger,
  readRecording,
  spanIdFor,
  traceparent,
  ulid,
  type DiffRules,
  type ThresholdMeasurements,
  type Exchange,
  type ExchangeResult,
  type HeaderMap,
  type InconclusiveCondition,
  type Logger,
  type PacingMode,
  type Query,
  type RecordedRequest,
  type RecordedResponse,
  type Run,
  type RunFileStats,
  type TagCounts,
  type SubstitutionRule,
  type Thresholds,
} from '@replay-parity/core';
import { evaluateInvariants } from '@replay-parity/invariants';
import { toSendError, type Adapter, type ReplayContext } from './adapter.js';
import { candidateExchanges, writeExchanges, type SentExchange } from './candidate-recording.js';
import { HttpAdapter } from './http-adapter.js';
import { ScheduleBuilder, round3, summarizeSlip } from './pacing.js';
import { NO_NOISE, markNoise, noisePaths } from './noise.js';
import { parseSessionKey, sessionOf } from './sessions.js';
import {
  DEFAULT_RETRY_BASE_MS,
  RETRY_KINDS,
  backoffMs,
  isIdempotent,
  type RetryKind,
} from './retry.js';
import { DependencyIndex, SubstitutionTable } from './substitutions.js';

/**
 * The replay engine. It selects exchanges from a recording, sends them to
 * the candidate on a schedule, diffs every response against the recorded
 * one, aggregates statistics, evaluates the thresholds, and returns the run.
 *
 * Ordering rules:
 * - Sends start in recording order within a session. Without a session key the
 *   whole recording is one session, so every send starts in recording order. A
 *   bounded pool limits how many are in flight across every session.
 * - The recorded happens-before order is kept within a session: an exchange
 *   that began after an earlier exchange's response in the recording waits for
 *   that exchange to be acknowledged when both belong to the same session.
 *   Exchanges that overlapped in the recording may overlap again, and
 *   exchanges of different sessions may overlap.
 * - A request that needs a value captured from an earlier exchange waits for
 *   that exchange to complete, under every pacing mode and across sessions.
 * - An exchange with a barrier tag waits until every earlier exchange of every
 *   session has a response or an error, is sent alone, and is acknowledged
 *   before anything later in any session is sent. A wait longer than the
 *   barrier timeout is recorded as `barrier_timeout` and the run is
 *   inconclusive.
 * - An exchange with a control tag is a barrier too. It is diffed on status
 *   only, excluded from statistics and thresholds, and marked `control: true`.
 *   A control that fails or returns a different status makes the run
 *   inconclusive with `control_failed`.
 * - With a reference target, every exchange is sent to the reference at the
 *   same moment as to the candidate, prepared from the reference's own
 *   substitution table. The exchange is acknowledged once both answered, so
 *   every rule above holds for the reference too.
 * - When `signal` aborts, no further exchange is sent, the sends in flight are
 *   aborted, and the run is finished with the results so far plus an
 *   `aborted` condition. Exchanges that were never sent are left out.
 */
export interface ReplayOptions {
  /** Path of the recording. */
  recording: string;
  /** Base URL of the candidate. Used by the default HTTP adapter and recorded in the run. */
  target: string;
  /** Transport. Default: an HTTP adapter on `target`. */
  adapter?: Adapter | undefined;
  pace?: PacingMode | undefined;
  /** Requests per second under `fixed-rate`. */
  rps?: number | null | undefined;
  /** Most exchanges in flight at once. Default 8. */
  concurrency?: number | undefined;
  /** Leading exchanges that run but do not count. Default 0. */
  warmup?: number | undefined;
  /** Keep only exchanges carrying this tag. */
  filterTag?: string | null | undefined;
  /** Keep only the first N exchanges after filtering. */
  limit?: number | null | undefined;
  /**
   * With a filter and substitution rules, also select the exchanges that produce the
   * captured values the filtered exchanges use, transitively. They are replayed for
   * ordering and substitution, marked `dependency: true`, and not counted. Default true.
   */
  includeDependencies?: boolean | undefined;
  /** Longest recorded gap kept under `as-recorded`, in milliseconds. 0 disables. Default 30000. */
  maxGapMs?: number | undefined;
  /**
   * Divides every recorded gap under `as-recorded`, after the cap: 2 replays twice as fast.
   * Default 1. Other modes have no recorded gaps and reject it.
   */
  speed?: number | null | undefined;
  /**
   * Replays the selected exchanges this many times, one iteration after another. Each
   * iteration's exchange ids carry `#k`, k from 1, and its substitutions start empty.
   * Default 1, which leaves the ids as recorded.
   */
  loop?: number | undefined;
  rules?: DiffRules | undefined;
  thresholds?: Thresholds | undefined;
  /** Caller supplied headers. Applied to every request over recorded values. */
  headers?: HeaderMap | undefined;
  /**
   * Caller supplied query parameters. Applied to every request over the recorded
   * query after the parameters the capture redacted are dropped.
   */
  queryOverrides?: Query | undefined;
  barrierTags?: readonly string[] | undefined;
  /**
   * Where a recorded request names its session: `header:<name>`, `cookie:<name>`, or a
   * JSONPath into the request body. The recorded happens-before order is then kept within
   * a session only, and exchanges of different sessions may overlap up to `concurrency`.
   * Default: one session for the whole recording.
   */
  sessionKey?: string | null | undefined;
  /** Default 10000. */
  barrierTimeoutMs?: number | undefined;
  /** Most retries of a send that failed in transport. Default 0. */
  retry?: number | undefined;
  /** The failures that are retried. Default both, timeout and connection. */
  retryOn?: readonly RetryKind[] | undefined;
  /** The first backoff before jitter, doubled on every further retry. Default 100. */
  retryBaseMs?: number | undefined;
  /** Retry methods that are not idempotent too. Default false. See `retry.ts` for why. */
  retryUnsafe?: boolean | undefined;
  /** The jitter source, a number from 0 to 1. Default `Math.random`. */
  random?: (() => number) | undefined;
  /**
   * Base URL of the reference. Every exchange is sent to it as well as to the candidate, at
   * the same moment and in the same order, with its own substitution table. A path where the
   * reference differs from its own recording is noise and cannot fail the candidate.
   */
  referenceTarget?: string | null | undefined;
  /** Transport for the reference re-replay. Default: an HTTP adapter on `referenceTarget`. */
  referenceAdapter?: Adapter | undefined;
  /** Write the requests as sent and the candidate responses here, in recording format. */
  candidateRecording?: string | null | undefined;
  /** Header names redacted in the candidate recording. Default: the capture list. */
  redactHeaders?: readonly string[] | undefined;
  /** Evaluate the independent invariants on the reference and the candidate recordings. Default false. */
  invariants?: boolean | undefined;
  /** Timeout for the default HTTP adapter. Default 30000. */
  timeoutMs?: number | undefined;
  maxBodyBytes?: number | undefined;
  runId?: string | undefined;
  now?: (() => Date) | undefined;
  /** Where the engine and the adapter write log lines. Default: nothing. */
  log?: Logger | undefined;
  /** A 32 hex character trace id. When set, every exchange's context carries a `traceparent`. */
  traceId?: string | undefined;
  onProgress?: ((progress: ReplayProgress) => void) | undefined;
  /** Call `onProgress` with a heartbeat this often while the run is in flight. 0 disables. Default 0. */
  heartbeatMs?: number | undefined;
  /** Aborting stops the run early. See the ordering rules above. */
  signal?: AbortSignal | undefined;
}

/**
 * Drops query parameters whose value, or whose every value, is the redaction
 * marker, the way `dropRedactedHeaders` drops headers. The capture proxy
 * records redacted parameters with the marker, and sending it would be wrong.
 */
export function dropRedactedQuery(query: Query): Query {
  const out: Query = {};
  for (const [name, value] of Object.entries(query)) {
    const redacted = Array.isArray(value) ? value.every((v) => v === REDACTED) : value === REDACTED;
    if (!redacted) out[name] = value;
  }
  return out;
}

export interface ReplayProgress {
  completed: number;
  total: number;
  /** The result that just completed, or null on a heartbeat. */
  last: ExchangeResult | null;
  /** Exchanges sent and not yet acknowledged. */
  inflight: number;
  /** True for the periodic tick that reports nothing new. */
  heartbeat: boolean;
  /** The scheduled send time of the last exchange in milliseconds from the start, 0 under max pacing. */
  schedule_end_ms: number;
}

export const DEFAULT_BARRIER_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_GAP_MS = 30_000;
/** Most exchanges read ahead of the oldest one not yet acknowledged. */
export const DEFAULT_WINDOW = 10_000;

interface Selection {
  selected: Exchange[];
  /** True at the positions of the exchanges pulled in as dependencies. */
  dependency: boolean[];
}

/**
 * Applies the filter and the limit. With a filter, substitution rules, and
 * `includeDependencies`, the producers of every captured value the filtered
 * exchanges use are selected too, transitively, in recording order.
 */
function selectExchanges(
  all: readonly Exchange[],
  filterTag: string | null,
  limit: number | null,
  includeDependencies: boolean,
  rules: readonly SubstitutionRule[],
): Selection {
  if (filterTag === null) {
    const selected = limit === null ? [...all] : all.slice(0, limit);
    return { selected, dependency: selected.map(() => false) };
  }
  let chosen: number[] = [];
  all.forEach((e, i) => {
    if (e.tags.includes(filterTag)) chosen.push(i);
  });
  if (limit !== null) chosen = chosen.slice(0, limit);
  const pulled = new Set<number>();
  if (includeDependencies && rules.length > 0) {
    const index = new DependencyIndex(all, rules);
    const seen = new Set(chosen);
    const queue = [...chosen];
    while (queue.length > 0) {
      const i = queue.pop() as number;
      for (const producer of index.dependenciesOf(i, (all[i] as Exchange).request)) {
        if (seen.has(producer)) continue;
        seen.add(producer);
        pulled.add(producer);
        queue.push(producer);
      }
    }
  }
  const order = [...chosen, ...pulled].sort((a, b) => a - b);
  return {
    selected: order.map((i) => all[i] as Exchange),
    dependency: order.map((i) => pulled.has(i)),
  };
}

function validate(options: ReplayExchangesOptions): void {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ConfigError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const warmup = options.warmup ?? 0;
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new ConfigError(`warmup must be a non negative integer, got ${warmup}`);
  }
  if (options.limit !== undefined && options.limit !== null) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new ConfigError(`limit must be a positive integer, got ${options.limit}`);
    }
  }
  const pace = options.pace ?? 'as-recorded';
  if (
    pace === 'fixed-rate' &&
    !(options.rps !== undefined && options.rps !== null && options.rps > 0)
  ) {
    throw new ConfigError('fixed-rate pacing needs --rps with a positive number');
  }
  if (pace !== 'fixed-rate' && options.rps !== undefined && options.rps !== null) {
    throw new ConfigError(`--rps applies to fixed-rate pacing only, not ${pace}`);
  }
  const barrierTimeout = options.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  if (!(barrierTimeout > 0)) {
    throw new ConfigError(`barrier timeout must be positive, got ${barrierTimeout}`);
  }
  if (options.speed !== undefined && options.speed !== null) {
    if (!(Number.isFinite(options.speed) && options.speed > 0)) {
      throw new ConfigError(`--speed must be a positive number, got ${options.speed}`);
    }
    if (pace !== 'as-recorded') {
      throw new ConfigError(
        `--speed scales recorded gaps under as-recorded pacing only, not ${pace}`,
      );
    }
  }
  const retry = options.retry ?? 0;
  if (!Number.isInteger(retry) || retry < 0) {
    throw new ConfigError(`--retry must be a non negative integer, got ${retry}`);
  }
  const retryBase = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  if (!(Number.isFinite(retryBase) && retryBase >= 0)) {
    throw new ConfigError(`--retry-base-ms must be a non negative number, got ${retryBase}`);
  }
  if (options.retryOn !== undefined) {
    if (options.retryOn.length === 0) {
      throw new ConfigError('--retry-on needs at least one of timeout, connection');
    }
    for (const kind of options.retryOn) {
      if (!RETRY_KINDS.includes(kind)) {
        throw new ConfigError(`--retry-on ${String(kind)}: expected timeout or connection`);
      }
    }
  }
  const loop = options.loop ?? 1;
  if (!Number.isInteger(loop) || loop < 1) {
    throw new ConfigError(`--loop must be a positive integer, got ${loop}`);
  }
  if (loop > 1 && options.invariants === true) {
    // The invariants rebuild one system's state from one pass over the recording.
    throw new ConfigError(
      '--invariants judges one pass over the recording and cannot be combined with --loop',
    );
  }
  const maxGap = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  if (!(Number.isFinite(maxGap) && maxGap >= 0)) {
    throw new ConfigError(`max gap must be a non negative number of milliseconds, got ${maxGap}`);
  }
}

/**
 * Waits until `ready` holds or the timeout passes, whichever comes first.
 * Returns true on timeout. `until` is the scheduler's wait on its own state.
 */
async function waitUntil(
  until: (ready: () => boolean) => Promise<void>,
  ready: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  let expired = false;
  const controller = new AbortController();
  const timer = sleep(timeoutMs, true, { signal: controller.signal }).catch(() => false);
  const done = until(() => expired || ready()).then(() => false);
  const timedOut = await Promise.race([done, timer]);
  expired = true;
  controller.abort();
  return timedOut;
}

/** Options for replaying exchanges that are already in memory. */
export type ReplayExchangesOptions = Omit<ReplayOptions, 'recording'> & {
  /** Label written to `recording.path`. Default empty. */
  recording?: string | undefined;
};

/**
 * Reads the recording and replays it. The file is hashed in a second
 * streaming pass alongside the read, and the hash is recorded in the run as
 * `recording.recording_sha256` so `rp shrink` can tell the file apart from
 * another one.
 */
export async function replay(options: ReplayOptions): Promise<Run> {
  const [all, hash] = await Promise.all([
    readRecording(options.recording),
    hashRecordingFile(options.recording),
  ]);
  const run = await replayExchanges(all, options);
  return { ...run, recording: { ...run.recording, recording_sha256: hash.sha256 } };
}

/** Counts exchanges overall and per tag, each tag of an exchange once. */
class TagCounter {
  private overall = 0;
  private readonly byTag = new Map<string, number>();

  add(tags: readonly string[], n = 1): void {
    this.overall += n;
    for (const tag of new Set(tags)) this.byTag.set(tag, (this.byTag.get(tag) ?? 0) + n);
  }

  finish(): TagCounts {
    const by_tag: Record<string, number> = {};
    for (const tag of [...this.byTag.keys()].sort()) by_tag[tag] = this.byTag.get(tag) as number;
    return { overall: this.overall, by_tag };
  }
}

/** A promise with its resolver. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The exchanges of one session that the scheduler has read and not yet sent or acknowledged. */
interface Session {
  key: string;
  /** Read and not yet sent, in recording order. */
  queue: Slot[];
  /** Sent and not yet acknowledged. */
  pending: Set<Slot>;
  /** True while a worker sends this session's queue. */
  active: boolean;
}

/** One selected exchange inside the window. */
interface Slot {
  index: number;
  exchange: Exchange;
  dependency: boolean;
  session: Session;
  control: boolean;
  barrier: boolean;
  /** Scheduled send time under `as-recorded` and `fixed-rate`. */
  time: number;
  /** Indices of the earlier exchanges that produce a value this request uses. */
  deps: number[];
  dispatched: boolean;
  completed: boolean;
  done: Deferred;
  result: ExchangeResult | null;
  sent: SentExchange | null;
}

/** What the candidate returned for one exchange, after every retry. */
interface CandidateOutcome {
  response: RecordedResponse | null;
  error: string | null;
  firstError: string | null;
  attempts: number;
  ackedAt: number | null;
}

/** The request as sent to the reference re-replay and its answer, null on a failure. */
interface ReferenceOutcome {
  request: RecordedRequest;
  response: RecordedResponse | null;
}

/** Replays exchanges held in memory. Used by `replay` and by shrinking, which replays per attempt. */
export async function replayExchanges(
  all: readonly Exchange[],
  options: ReplayExchangesOptions,
): Promise<Run> {
  validate(options);
  const pace = options.pace ?? 'as-recorded';
  const rps = pace === 'fixed-rate' ? (options.rps as number) : null;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const warmup = options.warmup ?? 0;
  const filterTag = options.filterTag ?? null;
  const limit = options.limit ?? null;
  const rules = options.rules ?? emptyRules();
  const thresholds = options.thresholds ?? emptyThresholds();
  const overrides = options.headers ?? {};
  const queryOverrides = options.queryOverrides ?? {};
  const barrierTags = new Set(options.barrierTags ?? []);
  const controlTags = new Set(rules.controls.tags);
  const barrierTimeoutMs = options.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  const includeDependencies = options.includeDependencies ?? true;
  const maxGapOption = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  // The cap applies to recorded gaps only, so it is in effect under as-recorded alone.
  const maxGapMs = pace === 'as-recorded' && maxGapOption > 0 ? maxGapOption : null;
  const sessionKey =
    options.sessionKey === undefined || options.sessionKey === null
      ? null
      : parseSessionKey(options.sessionKey);
  const windowSize = DEFAULT_WINDOW;
  const speed = pace === 'as-recorded' ? (options.speed ?? 1) : null;
  const retry = options.retry ?? 0;
  const retryOn = new Set<string>(options.retryOn ?? RETRY_KINDS);
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryUnsafe = options.retryUnsafe ?? false;
  const random = options.random ?? Math.random;
  const loop = options.loop ?? 1;
  const now = options.now ?? (() => new Date());
  const signal = options.signal;
  const log = options.log ?? noopLogger;
  const traceId = options.traceId;

  const { selected, dependency } = selectExchanges(
    all,
    filterTag,
    limit,
    includeDependencies,
    rules.substitutions,
  );
  const n = selected.length;
  const total = n * loop;
  // Each iteration has its own schedule, dependency index, and substitution table. The first
  // iteration's schedule gives the requested rate, which every iteration repeats.
  const firstSchedule = new ScheduleBuilder(pace, rps, maxGapMs, speed ?? 1);
  let schedule = firstSchedule;
  let gapsCapped = 0;
  /** When the current iteration's schedule starts, in milliseconds since the run started. */
  let base = 0;
  let dependencies = new DependencyIndex([], rules.substitutions);
  let table = new SubstitutionTable(rules.substitutions);
  /** The reference's own table, built from the responses of the reference re-replay. */
  let refTable = new SubstitutionTable(rules.substitutions);
  const differ = createDiffer(rules);

  const referenceTarget = options.referenceTarget ?? null;
  const ownReference = options.referenceAdapter === undefined && referenceTarget !== null;
  const reference: Adapter | null =
    options.referenceAdapter ??
    (referenceTarget === null
      ? null
      : new HttpAdapter(referenceTarget, {
          timeoutMs: options.timeoutMs,
          connections: concurrency,
          maxBodyBytes: options.maxBodyBytes,
        }));
  const ownAdapter = options.adapter === undefined;
  const adapter: Adapter =
    options.adapter ??
    new HttpAdapter(options.target, {
      timeoutMs: options.timeoutMs,
      connections: concurrency,
      maxBodyBytes: options.maxBodyBytes,
    });

  // Results in recording order, appended as the acknowledged prefix grows.
  const replayed: ExchangeResult[] = [];
  const sent: SentExchange[] = [];
  const conditions: InconclusiveCondition[] = [];
  /** The exchanges read and not yet part of the acknowledged prefix, by index. */
  const window = new Map<number, Slot>();
  const sessions = new Map<string, Session>();
  const sessionKeys = new Set<string>();
  /** Barriers read and not yet acknowledged, in recording order. */
  const openBarriers: Slot[] = [];
  /** Every exchange below this index was acknowledged or failed. */
  let ackFront = 0;
  /** Every exchange below this index was sent. */
  let sendFront = 0;
  const pending = new Set<Slot>();
  const slotWaiters: (() => void)[] = [];
  const workers = new Set<Promise<void>>();
  const tasks = new Set<Promise<void>>();
  let inflight = 0;
  let completed = 0;
  let dispatched = 0;
  let barrierWaits = 0;
  let changed = deferred();
  /** Wakes every wait on the scheduler's state. */
  const notify = (): void => {
    const current = changed;
    changed = deferred();
    current.resolve();
  };
  const until = async (ready: () => boolean): Promise<void> => {
    while (!ready()) await changed.promise;
  };

  const shutdown = new AbortController();
  // A stop request aborts the sends in flight at once. The workers see it at their next
  // step and send nothing more.
  const stop = deferred();
  const onAbort = (): void => {
    shutdown.abort();
    stop.resolve();
    notify();
  };
  if (signal?.aborted) {
    shutdown.abort();
    stop.resolve();
  } else signal?.addEventListener('abort', onAbort, { once: true });
  const stopped = (): boolean => signal?.aborted === true;
  /** Waits for an earlier exchange, or for a stop request that means it may never be sent. */
  const settled = (slots: readonly Slot[]): Promise<unknown> =>
    Promise.race([Promise.all(slots.map((k) => k.done.promise)), stop.promise]);

  const started = performance.now();
  const rel = (): number => performance.now() - started;
  const scheduleEnd = (): number => (pace === 'max' ? 0 : base + schedule.end);
  const heartbeatMs = options.heartbeatMs ?? 0;
  const heartbeat =
    heartbeatMs > 0 && options.onProgress !== undefined
      ? setInterval(() => {
          options.onProgress?.({
            completed,
            total,
            last: null,
            inflight: pending.size,
            heartbeat: true,
            schedule_end_ms: scheduleEnd(),
          });
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  const acquire = async (): Promise<void> => {
    while (inflight >= concurrency) {
      await new Promise<void>((resolve) => slotWaiters.push(resolve));
    }
    inflight += 1;
  };
  const release = (): void => {
    inflight -= 1;
    slotWaiters.shift()?.();
  };

  const isControl = (e: Exchange): boolean => e.tags.some((t) => controlTags.has(t));
  const isBarrier = (e: Exchange): boolean =>
    isControl(e) || e.tags.some((t) => barrierTags.has(t));

  const prepare = (req: RecordedRequest, substitutions: SubstitutionTable): RecordedRequest => {
    const substituted = substitutions.apply(req);
    return {
      ...substituted,
      query: { ...dropRedactedQuery(substituted.query), ...queryOverrides },
      headers: mergeHeaders(dropRedactedHeaders(substituted.headers), overrides),
    };
  };

  const dispatch = async (slot: Slot, scheduledAt: number): Promise<void> => {
    const i = slot.index;
    const e = slot.exchange;
    const control = slot.control;
    const request = prepare(e.request, table);
    const context: ReplayContext = {
      id: e.id,
      index: i,
      tags: e.tags,
      signal: shutdown.signal,
      log,
      traceparent: traceId === undefined ? undefined : traceparent(traceId, spanIdFor(e.id)),
    };
    const sentAt = rel();
    const sentWall = Date.now();
    const sendCandidate = async (): Promise<CandidateOutcome> => {
      let error: string;
      let firstError: string | null = null;
      let attempts = 0;
      const retryable = retry > 0 && (retryUnsafe || isIdempotent(request.method));
      for (;;) {
        attempts += 1;
        try {
          const response = await adapter.send(request, context);
          return { response, error: null, firstError, attempts, ackedAt: rel() };
        } catch (err) {
          const failure = toSendError(err);
          error = `${failure.kind}: ${failure.message}`;
          firstError ??= error;
          if (!retryable || attempts > retry || !retryOn.has(failure.kind)) break;
          if (shutdown.signal.aborted) break;
          await sleep(backoffMs(attempts, retryBaseMs, random), undefined, {
            signal: shutdown.signal,
          }).catch(() => undefined);
          if (shutdown.signal.aborted) break;
        }
      }
      return { response: null, error, firstError, attempts, ackedAt: null };
    };
    // The reference gets the same exchange at the same moment, prepared from its own table.
    const sendReference = async (): Promise<ReferenceOutcome | null> => {
      if (reference === null) return null;
      const refRequest = prepare(e.request, refTable);
      try {
        return { request: refRequest, response: await reference.send(refRequest, context) };
      } catch {
        return { request: refRequest, response: null };
      }
    };
    const [outcome, refNow] = await Promise.all([sendCandidate(), sendReference()]);
    const { response: candidate, error, firstError, attempts, ackedAt } = outcome;
    // Scoped rules apply by this exchange's tags, method, and recorded path, and a request
    // side capture reads the recorded request and the request as sent.
    const scope = exchangeContext(e);
    let noise: ReadonlySet<string> = NO_NOISE;
    const refResponse = refNow?.response ?? null;
    if (refNow !== null && refResponse !== null) {
      refTable.capture(e.tags, e.response, refResponse, {
        recorded: e.request,
        sent: refNow.request,
      });
      if (!control) {
        noise = noisePaths(differ.diff(e.response, refResponse, refTable.equivalences, scope));
      }
    }
    let diff: ExchangeResult['diff'] = null;
    if (candidate !== null) {
      table.capture(e.tags, e.response, candidate, { recorded: e.request, sent: request });
      diff = control
        ? differ.diffStatus(e.response, candidate, scope)
        : differ.diff(e.response, candidate, table.equivalences, scope);
      if (noise.size > 0) diff = markNoise(diff, noise).diff;
    }
    if (control && (error !== null || diff?.verdict === 'mismatch')) {
      const reason =
        error ??
        `candidate answered ${candidate?.status ?? 'nothing'}, reference answered ${e.response.status}`;
      conditions.push({
        kind: 'control_failed',
        detail: `${e.request.method} ${e.request.path} (${e.id}): ${reason}`,
      });
    }
    const result: ExchangeResult = {
      id: e.id,
      tags: [...e.tags],
      method: e.request.method,
      path: e.request.path,
      warmup: i < warmup,
      control,
      dependency: slot.dependency,
      scheduled_at_ms: round3(scheduledAt),
      sent_at_ms: round3(sentAt),
      acked_at_ms: ackedAt === null ? null : round3(ackedAt),
      reference: { status: e.response.status, latency_ms: e.response.latency_ms },
      candidate:
        candidate === null ? null : { status: candidate.status, latency_ms: candidate.latency_ms },
      error,
      diff,
    };
    if (attempts > 1) {
      result.attempts = attempts;
      result.first_error = firstError as string;
    }
    if (reference !== null) {
      result.reference_now =
        refResponse === null
          ? null
          : { status: refResponse.status, latency_ms: refResponse.latency_ms };
    }
    slot.result = result;
    slot.sent = {
      exchange: e,
      request,
      response: candidate,
      sentAtMs: sentAt,
      sentWallMs: sentWall,
    };
    completed += 1;
    options.onProgress?.({
      completed,
      total,
      last: result,
      inflight: pending.size - 1,
      heartbeat: false,
      schedule_end_ms: scheduleEnd(),
    });
  };

  /** Moves a finished result out of the window, in recording order. */
  const finalize = (slot: Slot): void => {
    if (slot.result !== null) replayed.push(slot.result);
    if (slot.sent !== null) sent.push(slot.sent);
  };

  const complete = (slot: Slot): void => {
    slot.completed = true;
    pending.delete(slot);
    const session = slot.session;
    session.pending.delete(slot);
    if (!session.active && session.queue.length === 0 && session.pending.size === 0) {
      if (sessions.get(session.key) === session) sessions.delete(session.key);
    }
    release();
    slot.done.resolve();
    while (openBarriers[0]?.completed === true) openBarriers.shift();
    for (;;) {
      const head = window.get(ackFront);
      if (head?.completed !== true) break;
      finalize(head);
      window.delete(ackFront);
      ackFront += 1;
    }
    if (sendFront < ackFront) sendFront = ackFront;
    notify();
  };

  const markSent = (slot: Slot): void => {
    slot.dispatched = true;
    for (;;) {
      const next = window.get(sendFront);
      if (next?.dispatched !== true) break;
      sendFront += 1;
    }
  };

  /**
   * Waits until one exchange may be sent and sends it. Returns false when the run
   * stopped first. The order of the waits is the order of the rules in the
   * engine's documentation, and every wait is on an earlier exchange, so the
   * oldest exchange that was not acknowledged can always make progress.
   */
  const advance = async (slot: Slot): Promise<boolean> => {
    const e = slot.exchange;
    // A barrier that was read before this exchange is acknowledged before it is sent.
    for (;;) {
      const gate = openBarriers.find((b) => !b.completed && b.index < slot.index);
      if (gate === undefined || stopped()) break;
      await settled([gate]);
    }
    // A barrier holds its slot while it waits, as it always did, but only once every earlier
    // exchange of every session was sent, so the slot it holds is never one they need.
    let holding = false;
    if (slot.barrier) {
      await until(() => sendFront >= slot.index || stopped());
      if (stopped()) return false;
      await acquire();
      holding = true;
      if (ackFront < slot.index && !stopped()) {
        barrierWaits += 1;
        const timedOut = await waitUntil(
          until,
          () => ackFront >= slot.index || stopped(),
          barrierTimeoutMs,
        );
        if (timedOut) {
          const still = [...window.values()]
            .filter((k) => k.index < slot.index && !k.completed)
            .sort((a, b) => a.index - b.index);
          conditions.push({
            kind: 'barrier_timeout',
            detail: `${e.request.method} ${e.request.path} (${e.id}) waited ${barrierTimeoutMs} ms for ${still.length} earlier exchange${still.length === 1 ? '' : 's'}: ${still
              .map((k) => k.exchange.id)
              .join(', ')}`,
          });
        }
      }
    }
    const producers = slot.deps
      .map((k) => window.get(k))
      .filter((k): k is Slot => k !== undefined && !k.completed);
    if (producers.length > 0) await settled(producers);
    // Recorded happens-before, within the session. An exchange whose recorded request began
    // after an earlier exchange's recorded response is never sent before that exchange is
    // acknowledged, so the replay never introduces an ordering the recording did not have.
    const precursors = [...slot.session.pending].filter(
      (k) => k.exchange.offset_ms + k.exchange.response.latency_ms <= e.offset_ms,
    );
    if (precursors.length > 0) await settled(precursors);
    if (pace !== 'max') {
      const wait = slot.time - rel();
      // The wait ends early on a stop request, so a long capped gap does not delay the stop.
      if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
    }
    if (stopped()) {
      if (holding) release();
      return false;
    }
    if (!holding) await acquire();
    if (stopped()) {
      release();
      return false;
    }
    const scheduledAt = pace === 'max' ? rel() : slot.time;
    dispatched += 1;
    pending.add(slot);
    slot.session.pending.add(slot);
    markSent(slot);
    notify();
    const task: Promise<void> = dispatch(slot, scheduledAt).finally(() => {
      tasks.delete(task);
      complete(slot);
    });
    tasks.add(task);
    return true;
  };

  /** Sends one session's exchanges in recording order until its queue is empty. */
  const work = async (session: Session): Promise<void> => {
    while (session.queue.length > 0 && !stopped()) {
      const slot = session.queue.shift() as Slot;
      if (!(await advance(slot))) break;
    }
    session.active = false;
    if (session.queue.length === 0 && session.pending.size === 0) {
      if (sessions.get(session.key) === session) sessions.delete(session.key);
    }
  };

  const startWorker = (session: Session): void => {
    session.active = true;
    const worker: Promise<void> = work(session).finally(() => workers.delete(worker));
    workers.add(worker);
  };

  /**
   * Reads one iteration of the selection into the window, at most `windowSize` past the
   * acknowledged prefix. `k` counts iterations from 1.
   */
  const readAll = async (k: number): Promise<void> => {
    const first = (k - 1) * n;
    for (let local = 0; local < n; local += 1) {
      const i = first + local;
      if (i - ackFront >= windowSize) await until(() => i - ackFront < windowSize || stopped());
      if (stopped()) return;
      const recorded = selected[local] as Exchange;
      const e = loop === 1 ? recorded : { ...recorded, id: `${recorded.id}#${k}` };
      const key = sessionKey === null ? '' : sessionOf(sessionKey, e.request);
      sessionKeys.add(key);
      let session = sessions.get(key);
      if (session === undefined) {
        session = { key, queue: [], pending: new Set(), active: false };
        sessions.set(key, session);
      }
      const control = isControl(e);
      const slot: Slot = {
        index: i,
        exchange: e,
        dependency: dependency[local] === true,
        session,
        control,
        barrier: control || isBarrier(e),
        time: base + schedule.next(e.offset_ms),
        deps: dependencies.empty
          ? []
          : dependencies.dependenciesOf(local, e.request).map((d) => first + d),
        dispatched: false,
        completed: false,
        done: deferred(),
        result: null,
        sent: null,
      };
      if (!dependencies.empty) dependencies.add(e, local);
      window.set(i, slot);
      if (slot.barrier) openBarriers.push(slot);
      session.queue.push(slot);
      if (!session.active) startWorker(session);
    }
  };

  try {
    // Iterations run back to back: the next one starts once every exchange of the previous
    // one was acknowledged, with an empty substitution table and its schedule from that moment.
    for (let k = 1; k <= loop && !stopped(); k += 1) {
      if (k > 1) {
        gapsCapped += schedule.gapsCapped;
        schedule = new ScheduleBuilder(pace, rps, maxGapMs, speed ?? 1);
        dependencies = new DependencyIndex([], rules.substitutions);
        table = new SubstitutionTable(rules.substitutions);
        refTable = new SubstitutionTable(rules.substitutions);
        base = rel();
      }
      await readAll(k);
      while (workers.size > 0) await Promise.all([...workers]);
      while (tasks.size > 0) await Promise.all([...tasks]);
    }
    gapsCapped += schedule.gapsCapped;
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    signal?.removeEventListener('abort', onAbort);
    shutdown.abort();
    if (ownAdapter && adapter.close) await adapter.close();
    if (ownReference && reference?.close) await reference.close();
  }
  const durationMs = rel();
  // After a stop the acknowledged prefix ends at the first exchange that was never sent.
  // The exchanges sent after it are kept, in recording order.
  for (const slot of [...window.values()].sort((a, b) => a.index - b.index)) {
    if (slot.completed) finalize(slot);
  }
  window.clear();
  if (stopped()) {
    conditions.push({
      kind: 'aborted',
      detail: `stopped by signal after ${dispatched} of ${total} exchanges`,
    });
  }

  const collector = new StatsCollector();
  const retried = new TagCounter();
  const noiseFindings = new TagCounter();
  const slips: number[] = [];
  for (const r of replayed) {
    if (r.control) continue;
    slips.push(r.sent_at_ms - r.scheduled_at_ms);
    if (r.warmup || r.dependency) continue;
    if (r.attempts !== undefined) retried.add(r.tags);
    if (r.diff !== null) {
      const marked = r.diff.findings.filter((f) => f.noise === true).length;
      if (marked > 0) noiseFindings.add(r.tags, marked);
    }
    collector.record({
      tags: r.tags,
      verdict: r.diff?.verdict ?? null,
      candidateLatencyMs: r.candidate?.latency_ms ?? null,
      referenceLatencyMs: r.reference.latency_ms,
    });
  }
  const stats: RunFileStats = collector.finish();
  if (retry > 0) stats.retried = retried.finish();
  if (reference !== null) stats.noise_findings = noiseFindings.finish();
  const slip = summarizeSlip(slips);

  const candidateLog = candidateExchanges({
    sent,
    adapter: adapter.name,
    redactHeaders: options.redactHeaders ?? DEFAULT_REDACTED_HEADERS,
  });
  const candidateRecording = options.candidateRecording ?? null;
  if (candidateRecording !== null) await writeExchanges(candidateRecording, candidateLog);

  const measurements: ThresholdMeasurements = { slip_max_ms: slip.max_ms };
  let invariants: Run['invariants'] = { reference: null, candidate: null };
  if (options.invariants) {
    const reference = evaluateInvariants(selected, {
      system: 'reference',
      recording: options.recording ?? '',
    });
    const candidate = evaluateInvariants(candidateLog, {
      system: 'candidate',
      recording: candidateRecording ?? '',
    });
    invariants = { reference, candidate };
    for (const report of [reference, candidate]) {
      for (const c of report.inconclusive) {
        conditions.push({ kind: c.kind, detail: `${report.system}: ${c.detail}` });
      }
    }
    measurements.invariant_violations = {
      reference: reference.violations,
      candidate: candidate.violations,
    };
  }
  const evaluation = evaluateThresholds(thresholds, stats, measurements);
  const inconclusive = [...conditions, ...evaluation.inconclusive];
  const verdict = decideVerdict({ threshold_results: evaluation.results, inconclusive });

  const run: Run = {
    schema_version: 1,
    run_id: options.runId ?? ulid(),
    created_at: now().toISOString(),
    verdict,
    inconclusive,
    recording: {
      path: options.recording ?? '',
      exchanges: all.length,
      selected: n,
      first_ts: all[0]?.ts ?? null,
      last_ts: all[all.length - 1]?.ts ?? null,
    },
    target: options.target,
    reference_target: reference === null ? null : (referenceTarget ?? reference.name),
    adapter: adapter.name,
    pacing: {
      mode: pace,
      rps,
      concurrency,
      requested_rps: firstSchedule.requestedRps(),
      achieved_rps: durationMs > 0 ? round3((replayed.length * 1000) / durationMs) : 0,
      slip_p50_ms: slip.p50_ms,
      slip_max_ms: slip.max_ms,
      barrier_tags: [...barrierTags].sort(),
      barrier_timeout_ms: barrierTimeoutMs,
      barrier_waits: barrierWaits,
      max_gap_ms: maxGapMs,
      gaps_capped: gapsCapped,
      session_key: sessionKey?.spec ?? null,
      sessions: sessionKeys.size,
      speed,
      loop,
      retry:
        retry === 0
          ? null
          : {
              max: retry,
              on: [...retryOn].sort() as RetryKind[],
              base_ms: retryBaseMs,
              unsafe: retryUnsafe,
            },
    },
    warmup,
    filter: {
      tag: filterTag,
      include_dependencies: includeDependencies,
      dependencies: dependency.filter((d) => d).length,
    },
    limit,
    duration_ms: round3(durationMs),
    rules,
    thresholds,
    threshold_results: evaluation.results,
    stats,
    exchanges: replayed,
    candidate_recording: candidateRecording,
    invariants,
    reproduction: null,
  };
  return run;
}
