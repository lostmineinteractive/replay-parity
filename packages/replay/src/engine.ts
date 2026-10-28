import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
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
  readRecording,
  ulid,
  type Diff,
  type DiffRules,
  type ThresholdMeasurements,
  type Exchange,
  type ExchangeResult,
  type HeaderMap,
  type InconclusiveCondition,
  type PacingMode,
  type Query,
  type RecordedRequest,
  type RecordedResponse,
  type Run,
  type SubstitutionRule,
  type Thresholds,
} from '@replay-parity/core';
import { evaluateInvariants } from '@replay-parity/invariants';
import { describeSendError, type Adapter } from './adapter.js';
import { candidateExchanges, writeExchanges, type SentExchange } from './candidate-recording.js';
import { HttpAdapter } from './http-adapter.js';
import { buildSchedule, requestedRps, round3, summarizeSlip } from './pacing.js';
import { DependencyIndex, SubstitutionTable } from './substitutions.js';

/**
 * The replay engine. It selects exchanges from a recording, sends them to
 * the candidate on a schedule, diffs every response against the recorded
 * one, aggregates statistics, evaluates the thresholds, and returns the run.
 *
 * Ordering rules:
 * - Sends start in recording order. A bounded pool limits how many are in flight.
 * - The recorded happens-before order is kept: an exchange that began after an
 *   earlier exchange's response in the recording waits for that exchange to be
 *   acknowledged. Exchanges that overlapped in the recording may overlap again.
 * - A request that needs a value captured from an earlier exchange waits for
 *   that exchange to complete, under every pacing mode.
 * - An exchange with a barrier tag waits until every earlier exchange has a
 *   response or an error, is sent alone, and is acknowledged before anything
 *   later is sent. A wait longer than the barrier timeout is recorded as
 *   `barrier_timeout` and the run is inconclusive.
 * - An exchange with a control tag is a barrier too. It is diffed on status
 *   only, excluded from statistics and thresholds, and marked `control: true`.
 *   A control that fails or returns a different status makes the run
 *   inconclusive with `control_failed`.
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
  /** Default 10000. */
  barrierTimeoutMs?: number | undefined;
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
  onProgress?: ((progress: ReplayProgress) => void) | undefined;
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
  last: ExchangeResult;
}

export const DEFAULT_BARRIER_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_GAP_MS = 30_000;

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
  const maxGap = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  if (!(Number.isFinite(maxGap) && maxGap >= 0)) {
    throw new ConfigError(`max gap must be a non negative number of milliseconds, got ${maxGap}`);
  }
}

/** Waits for every promise or for the timeout, whichever comes first. Returns true on timeout. */
async function waitWithTimeout(promises: Promise<void>[], timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = sleep(timeoutMs, true, { signal: controller.signal }).catch(() => false);
  const done = Promise.all(promises).then(() => false);
  const timedOut = await Promise.race([done, timer]);
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
  const now = options.now ?? (() => new Date());
  const signal = options.signal;

  const { selected, dependency } = selectExchanges(
    all,
    filterTag,
    limit,
    includeDependencies,
    rules.substitutions,
  );
  const n = selected.length;
  const schedule = buildSchedule(
    selected.map((e) => e.offset_ms),
    pace,
    rps,
    maxGapMs,
  );
  const dependencies = new DependencyIndex(selected, rules.substitutions);
  const table = new SubstitutionTable(rules.substitutions);
  const differ = createDiffer(rules);

  const ownAdapter = options.adapter === undefined;
  const adapter: Adapter =
    options.adapter ??
    new HttpAdapter(options.target, {
      timeoutMs: options.timeoutMs,
      connections: concurrency,
      maxBodyBytes: options.maxBodyBytes,
    });

  const results: ExchangeResult[] = new Array<ExchangeResult>(n);
  const sent: (SentExchange | null)[] = new Array<SentExchange | null>(n).fill(null);
  const conditions: InconclusiveCondition[] = [];
  const resolvers: (() => void)[] = [];
  const completion: Promise<void>[] = selected.map(
    (_, i) =>
      new Promise<void>((resolve) => {
        resolvers[i] = resolve;
      }),
  );
  const pending = new Set<number>();
  const slotWaiters: (() => void)[] = [];
  let inflight = 0;
  let completed = 0;
  let dispatched = 0;
  let barrierWaits = 0;
  const shutdown = new AbortController();
  // A stop request aborts the sends in flight at once. The scheduler loop sees it at its
  // next step and sends nothing more.
  const onAbort = (): void => shutdown.abort();
  if (signal?.aborted) shutdown.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const stopped = (): boolean => signal?.aborted === true;

  const started = performance.now();
  const rel = (): number => performance.now() - started;

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

  const prepare = (req: RecordedRequest): RecordedRequest => {
    const substituted = table.apply(req);
    return {
      ...substituted,
      query: { ...dropRedactedQuery(substituted.query), ...queryOverrides },
      headers: mergeHeaders(dropRedactedHeaders(substituted.headers), overrides),
    };
  };

  const dispatch = async (i: number, e: Exchange, scheduledAt: number): Promise<void> => {
    const control = isControl(e);
    const request = prepare(e.request);
    const sentAt = rel();
    const sentWall = Date.now();
    let candidate: RecordedResponse | null = null;
    let error: string | null = null;
    try {
      candidate = await adapter.send(request, {
        id: e.id,
        index: i,
        tags: e.tags,
        signal: shutdown.signal,
      });
    } catch (err) {
      error = describeSendError(err);
    }
    const ackedAt = candidate === null ? null : rel();
    let diff: Diff | null = null;
    if (candidate !== null) {
      table.capture(e.tags, e.response, candidate);
      diff = control
        ? differ.diffStatus(e.response, candidate)
        : differ.diff(e.response, candidate, table.equivalences);
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
      dependency: dependency[i] === true,
      scheduled_at_ms: round3(scheduledAt),
      sent_at_ms: round3(sentAt),
      acked_at_ms: ackedAt === null ? null : round3(ackedAt),
      reference: { status: e.response.status, latency_ms: e.response.latency_ms },
      candidate:
        candidate === null ? null : { status: candidate.status, latency_ms: candidate.latency_ms },
      error,
      diff,
    };
    results[i] = result;
    sent[i] = { exchange: e, request, response: candidate, sentAtMs: sentAt, sentWallMs: sentWall };
    completed += 1;
    options.onProgress?.({ completed, total: n, last: result });
  };

  const tasks: Promise<void>[] = [];
  try {
    for (let i = 0; i < n; i += 1) {
      if (stopped()) break;
      const e = selected[i] as Exchange;
      const barrier = isBarrier(e);
      await acquire();
      if (barrier && pending.size > 0) {
        barrierWaits += 1;
        const earlier = [...pending];
        const timedOut = await waitWithTimeout(
          earlier.map((k) => completion[k] as Promise<void>),
          barrierTimeoutMs,
        );
        if (timedOut) {
          const still = earlier.filter((k) => pending.has(k));
          conditions.push({
            kind: 'barrier_timeout',
            detail: `${e.request.method} ${e.request.path} (${e.id}) waited ${barrierTimeoutMs} ms for ${still.length} earlier exchange${still.length === 1 ? '' : 's'}: ${still
              .map((k) => (selected[k] as Exchange).id)
              .join(', ')}`,
          });
        }
      }
      const deps = dependencies.dependenciesOf(i, e.request);
      if (deps.length > 0) await Promise.all(deps.map((k) => completion[k] as Promise<void>));
      // Recorded happens-before. An exchange whose recorded request began after an earlier
      // exchange's recorded response is never sent before that exchange is acknowledged, so
      // the replay never introduces an ordering the recording did not have.
      const precursors = [...pending].filter((k) => {
        const earlier = selected[k] as Exchange;
        return earlier.offset_ms + earlier.response.latency_ms <= e.offset_ms;
      });
      if (precursors.length > 0) {
        await Promise.all(precursors.map((k) => completion[k] as Promise<void>));
      }
      const scheduledAt = pace === 'max' ? rel() : (schedule.times[i] as number);
      const wait = scheduledAt - rel();
      // The wait ends early on a stop request, so a long capped gap does not delay the stop.
      if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
      if (stopped()) {
        release();
        break;
      }
      dispatched += 1;
      pending.add(i);
      const task = dispatch(i, e, scheduledAt).finally(() => {
        pending.delete(i);
        release();
        (resolvers[i] as () => void)();
      });
      tasks.push(task);
      if (barrier) await completion[i];
    }
    await Promise.all(tasks);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    shutdown.abort();
    if (ownAdapter && adapter.close) await adapter.close();
  }
  const durationMs = rel();
  if (stopped()) {
    conditions.push({
      kind: 'aborted',
      detail: `stopped by signal after ${dispatched} of ${n} exchanges`,
    });
  }
  // The exchanges that were sent, in recording order. After a stop the rest are left out.
  const replayed = results.filter((r): r is ExchangeResult => r !== undefined);

  const collector = new StatsCollector();
  const slips: number[] = [];
  for (const r of replayed) {
    if (r.control) continue;
    slips.push(r.sent_at_ms - r.scheduled_at_ms);
    if (r.warmup || r.dependency) continue;
    collector.record({
      tags: r.tags,
      verdict: r.diff?.verdict ?? null,
      candidateLatencyMs: r.candidate?.latency_ms ?? null,
      referenceLatencyMs: r.reference.latency_ms,
    });
  }
  const stats = collector.finish();
  const slip = summarizeSlip(slips);

  const candidateLog = candidateExchanges({
    sent: sent.filter((s): s is SentExchange => s !== null),
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
    adapter: adapter.name,
    pacing: {
      mode: pace,
      rps,
      concurrency,
      requested_rps: requestedRps(schedule.times, pace, rps),
      achieved_rps: durationMs > 0 ? round3((replayed.length * 1000) / durationMs) : 0,
      slip_p50_ms: slip.p50_ms,
      slip_max_ms: slip.max_ms,
      barrier_tags: [...barrierTags].sort(),
      barrier_timeout_ms: barrierTimeoutMs,
      barrier_waits: barrierWaits,
      max_gap_ms: maxGapMs,
      gaps_capped: schedule.gapsCapped,
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
