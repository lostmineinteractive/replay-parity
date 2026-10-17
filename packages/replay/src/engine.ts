import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ConfigError,
  DEFAULT_REDACTED_HEADERS,
  StatsCollector,
  createDiffer,
  decideVerdict,
  dropRedactedHeaders,
  emptyRules,
  emptyThresholds,
  evaluateThresholds,
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
  type RecordedRequest,
  type RecordedResponse,
  type Run,
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
  rules?: DiffRules | undefined;
  thresholds?: Thresholds | undefined;
  /** Caller supplied headers. Applied to every request over recorded values. */
  headers?: HeaderMap | undefined;
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
}

export interface ReplayProgress {
  completed: number;
  total: number;
  last: ExchangeResult;
}

export const DEFAULT_BARRIER_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 8;

function selectExchanges(
  all: readonly Exchange[],
  filterTag: string | null,
  limit: number | null,
): Exchange[] {
  let selected = filterTag === null ? [...all] : all.filter((e) => e.tags.includes(filterTag));
  if (limit !== null) selected = selected.slice(0, limit);
  return selected;
}

function validate(options: ReplayOptions): void {
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

export async function replay(options: ReplayOptions): Promise<Run> {
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
  const barrierTags = new Set(options.barrierTags ?? []);
  const controlTags = new Set(rules.controls.tags);
  const barrierTimeoutMs = options.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  const all = await readRecording(options.recording);
  const selected = selectExchanges(all, filterTag, limit);
  const n = selected.length;
  const schedule = buildSchedule(
    selected.map((e) => e.offset_ms),
    pace,
    rps,
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
  let barrierWaits = 0;
  const shutdown = new AbortController();

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
      const scheduledAt = pace === 'max' ? rel() : (schedule[i] as number);
      const wait = scheduledAt - rel();
      if (wait > 0) await sleep(wait);
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
    shutdown.abort();
    if (ownAdapter && adapter.close) await adapter.close();
  }
  const durationMs = rel();

  const collector = new StatsCollector();
  const slips: number[] = [];
  for (const r of results) {
    if (r.control) continue;
    slips.push(r.sent_at_ms - r.scheduled_at_ms);
    if (r.warmup) continue;
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
      recording: options.recording,
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
      path: options.recording,
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
      requested_rps: requestedRps(
        selected.map((e) => e.offset_ms),
        pace,
        rps,
      ),
      achieved_rps: durationMs > 0 ? round3((n * 1000) / durationMs) : 0,
      slip_p50_ms: slip.p50_ms,
      slip_max_ms: slip.max_ms,
      barrier_tags: [...barrierTags].sort(),
      barrier_timeout_ms: barrierTimeoutMs,
      barrier_waits: barrierWaits,
    },
    warmup,
    filter: { tag: filterTag },
    limit,
    duration_ms: round3(durationMs),
    rules,
    thresholds,
    threshold_results: evaluation.results,
    stats,
    exchanges: results,
    candidate_recording: candidateRecording,
    invariants,
  };
  return run;
}
