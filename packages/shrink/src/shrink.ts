import { performance } from 'node:perf_hooks';
import {
  ConfigError,
  RUN_LEVEL_INCONCLUSIVE_KINDS,
  renderPath,
  select,
  type Segment,
  emptyRules,
  emptyThresholds,
  hashRecordingFile,
  type Exchange,
  type JsonValue,
  type Reproduction,
  type ValueChange,
  type ReproductionStep,
  type Run,
  type Thresholds,
} from '@replay-parity/core';
import {
  replayExchanges,
  type Adapter,
  writeExchanges,
  type ReplayExchangesOptions,
} from '@replay-parity/replay';
import { attemptKey, cacheSalt, MemoryAttemptCache, type AttemptCache } from './cache.js';
import { AttemptBudgetExceeded, ddmin } from './ddmin.js';
import { minimalValue, setAt, valueAt } from './lowering.js';
import { Pool } from './pool.js';
import { Prerequisites } from './prerequisites.js';
import {
  formatRule,
  latencyBreached,
  latencySamples,
  reproduces,
  witnessOf,
  type ShrinkRule,
} from './rule.js';

/**
 * Shrinking. Given a failing rule, find a shorter subsequence of the
 * recording that still trips it, then lower quantities toward one. Every
 * candidate is replayed against a freshly reset candidate system and judged
 * by the same rule. The result is a reduced reproduction, not a minimal one.
 */
/** One candidate system an attempt can run against. */
export interface ShrinkTarget {
  target: string;
  /** Returns this candidate to its initial state. Called before every attempt on it. */
  reset: () => Promise<void>;
  /** The adapter for this target. Default: the HTTP adapter for `target`. */
  adapter?: Adapter | undefined;
}

export interface ShrinkOptions {
  exchanges: readonly Exchange[];
  target: string;
  /** Returns the candidate to its initial state. Called before every attempt. */
  reset: () => Promise<void>;
  /**
   * More candidates, each with its own reset. When given, the chunks of one
   * removal round run against `target` and these at once. The first chunk in
   * order that reproduces is taken, so the reduction equals the sequential one.
   */
  extraTargets?: readonly ShrinkTarget[] | undefined;
  rule: ShrinkRule;
  /** Replay settings shared by every attempt. Pacing is always `max` with one in flight. */
  replay?:
    | Partial<
        Pick<
          ReplayExchangesOptions,
          | 'rules'
          | 'headers'
          | 'queryOverrides'
          | 'barrierTags'
          | 'barrierTimeoutMs'
          | 'adapter'
          | 'timeoutMs'
          | 'maxBodyBytes'
          | 'redactHeaders'
          | 'invariantsModule'
        >
      >
    | undefined;
  /**
   * JSONPaths in the request bodies whose integer values are lowered toward one.
   * Default `$.qty` and `$.quantity`, and only for a candidate invariant rule.
   */
  lower?: readonly string[] | undefined;
  /** JSONPaths in the request bodies whose values become "", [], or {} when the rule still reproduces. */
  simplify?: readonly string[] | undefined;
  /**
   * Verdicts of attempts already judged, keyed by a hash of the exact subset
   * and its lowered values. A subset in the cache is answered without a
   * replay and does not count as an attempt. Default: a cache that lives for
   * this call. `openAttemptCache` gives one that persists in a file.
   */
  cache?: AttemptCache | undefined;
  /** The run's thresholds, which give a latency rule its limit. Required for a latency rule. */
  thresholds?: Thresholds | undefined;
  /** For a latency rule, how many times each attempt replays its subset. Default 20. */
  repeat?: number | undefined;
  /** Default 64. */
  maxAttempts?: number | undefined;
  /** Default 120000. */
  timeBudgetMs?: number | undefined;
  /** Where to write the reduced recording. */
  out?: string | null | undefined;
  onAttempt?: ((event: AttemptEvent) => void) | undefined;
  now?: (() => number) | undefined;
  /**
   * Aborting stops the attempts, like the attempt budget running out. The best
   * reduction found so far is kept and `aborted` is set on the result.
   */
  signal?: AbortSignal | undefined;
}

export type AttemptPhase = 'confirm' | 'remove' | 'lower';

export interface AttemptEvent {
  /** The number of replays spent so far, this one included. Unchanged for a cached verdict. */
  attempt: number;
  /** True when the verdict came from the cache and nothing was replayed. */
  cached?: boolean;
  phase: AttemptPhase;
  steps: number;
  reproduced: boolean;
}

export interface ShrinkResult {
  reproduction: Reproduction;
  exchanges: Exchange[];
  /** True when `signal` stopped the attempts before the reduction was done. */
  aborted: boolean;
  /**
   * Replays that ran ahead of the chunk that was accepted and were not needed.
   * They are not counted in `reproduction.attempts`, which equals the
   * sequential count. Zero with one target.
   */
  speculative: number;
}

export const DEFAULT_MAX_ATTEMPTS = 64;
export const DEFAULT_LATENCY_REPEAT = 20;
export const DEFAULT_TIME_BUDGET_MS = 120_000;

export interface RecordingHashCheck {
  /** The hash the run recorded, or null when it has none. */
  expected: string | null;
  /** The hash of the file given. */
  actual: string;
  /** True when the run has a hash and it differs from the file's. */
  mismatch: boolean;
}

export interface RecordingHashOptions {
  run: Run;
  /** Path of the recording the shrink will replay. */
  recording: string;
  /** Report a mismatch instead of refusing. Default false. */
  allowMismatch?: boolean | undefined;
}

/**
 * Compares the hash the run recorded with the hash of the recording file,
 * so a shrink never replays a different file than the run did. A run with
 * no hash, from an in memory replay or an older rp, is accepted. A mismatch
 * is a `ConfigError` naming both hashes unless `allowMismatch` is set, in
 * which case the check is returned for the caller to report.
 */
export async function verifyRecordingHash(
  options: RecordingHashOptions,
): Promise<RecordingHashCheck> {
  const expected = options.run.recording.recording_sha256 ?? null;
  const { sha256: actual } = await hashRecordingFile(options.recording);
  const mismatch = expected !== null && expected !== actual;
  if (mismatch && options.allowMismatch !== true) {
    throw new ConfigError(
      `${options.recording} is not the recording the run replayed: the run recorded sha256 ${expected} and the file has ${actual}. Pass --allow-recording-mismatch to shrink it anyway.`,
    );
  }
  return { expected, actual, mismatch };
}

/** The fields lowered when the rules file gives no `shrink.lower`. */
export const DEFAULT_LOWER_PATHS: readonly string[] = ['$.qty', '$.quantity'];

interface Step {
  /** Index in the original list. */
  index: number;
  exchange: Exchange;
  quantityReduced: boolean;
  /** The values changed from the recording, by path, with the recorded value as `from`. */
  changed: Map<string, ValueChange>;
}

function toStep(step: Step): ReproductionStep {
  const out: ReproductionStep = {
    id: step.exchange.id,
    method: step.exchange.request.method,
    path: step.exchange.request.path,
    tags: [...step.exchange.tags],
    quantity_reduced: step.quantityReduced,
  };
  if (step.exchange.request.body !== undefined) out.body = step.exchange.request.body;
  if (step.changed.size > 0) out.changed = [...step.changed.values()];
  return out;
}

/** Fills a latency rule's limit and minimum sample count from the run's thresholds. */
function resolveLatencyRule(options: ShrinkOptions): ShrinkRule {
  const rule = options.rule;
  if (rule.kind !== 'latency') return rule;
  const latency = options.thresholds?.latency;
  if (latency === undefined) {
    throw new ConfigError(`rule ${formatRule(rule)} needs the thresholds of the run for its limit`);
  }
  const block = latency.by_tag[rule.tag];
  const limitMs = block?.[`${rule.metric}_ms`];
  if (limitMs === undefined) {
    throw new ConfigError(
      `rule ${formatRule(rule)}: the run's thresholds set no ${rule.metric}_ms limit under latency.by_tag.${rule.tag}`,
    );
  }
  return { ...rule, limitMs, minSamples: block?.min_samples ?? latency.min_samples };
}

export async function shrink(options: ShrinkOptions): Promise<ShrinkResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  if (!(maxAttempts >= 1))
    throw new ConfigError(`max attempts must be at least 1, got ${maxAttempts}`);
  if (!(timeBudgetMs > 0))
    throw new ConfigError(`time budget must be positive, got ${timeBudgetMs}`);
  const rules = options.replay?.rules ?? emptyRules();
  const rule = resolveLatencyRule(options);
  const repeat = rule.kind === 'latency' ? (options.repeat ?? DEFAULT_LATENCY_REPEAT) : 1;
  if (!(Number.isInteger(repeat) && repeat >= 1))
    throw new ConfigError(`repeat must be a positive integer, got ${repeat}`);
  const original = options.exchanges;
  if (original.length === 0) throw new ConfigError('nothing to shrink: the recording is empty');

  const witnessId = witnessOf(rule);
  let witnessIndex = witnessId === undefined ? -1 : original.findIndex((e) => e.id === witnessId);
  if (witnessId !== undefined && witnessIndex < 0) {
    throw new ConfigError(`exchange ${witnessId} named by the rule is not in the recording`);
  }
  // Steps after the witness cannot affect it, so they go first.
  const scope = witnessIndex < 0 ? original : original.slice(0, witnessIndex + 1);
  if (witnessIndex < 0) witnessIndex = -1;
  const prerequisites = new Prerequisites(scope, rules);
  const always = witnessIndex < 0 ? [] : [witnessIndex];

  let attempts = 0;
  const steps = new Map<number, Step>();
  scope.forEach((exchange, index) =>
    steps.set(index, { index, exchange, quantityReduced: false, changed: new Map() }),
  );
  const listOf = (indices: readonly number[]): Exchange[] =>
    indices.map((i) => (steps.get(i) as Step).exchange);

  const signal = options.signal;
  const stopped = (): boolean => signal?.aborted === true;

  const { adapter: primaryAdapter, ...sharedReplay } = options.replay ?? {};
  const slots = new Pool<ShrinkTarget>([
    { target: options.target, reset: options.reset, adapter: primaryAdapter },
    ...(options.extraTargets ?? []),
  ]);
  const width = 1 + (options.extraTargets?.length ?? 0);
  let speculative = 0;
  let cacheHits = 0;
  const cache = options.cache ?? new MemoryAttemptCache();
  const salt = cacheSalt([
    formatRule(rule),
    rule.kind === 'latency' ? [rule.limitMs, rule.minSamples, repeat] : null,
    rules,
    sharedReplay.headers ?? null,
    sharedReplay.queryOverrides ?? null,
    sharedReplay.barrierTags ?? null,
    // A verdict about one module's rule says nothing about another's, so the module is part of the key.
    ...(sharedReplay.invariantsModule === undefined
      ? []
      : [
          [
            sharedReplay.invariantsModule.name,
            sharedReplay.invariantsModule.version,
            sharedReplay.invariantsModule.sha256 ?? null,
          ],
        ]),
  ]);
  // The subsets whose replay counted as an attempt, so a discarded one can be taken back.
  const replayed = new WeakSet<readonly number[]>();

  const judge = async (indices: readonly number[], phase: AttemptPhase): Promise<boolean> => {
    if (stopped()) throw new AttemptBudgetExceeded('stopped by signal');
    const key = attemptKey(salt, listOf(indices));
    const known = cache.get(key);
    if (known !== undefined) {
      cacheHits += 1;
      options.onAttempt?.({
        attempt: attempts,
        cached: true,
        phase,
        steps: indices.length,
        reproduced: known,
      });
      return known;
    }
    if (attempts >= maxAttempts || now() - started > timeBudgetMs)
      throw new AttemptBudgetExceeded();
    attempts += 1;
    replayed.add(indices);
    const attempt = attempts;
    const verdict = await slots.use((slot) => replayOn(slot, indices, phase, attempt));
    // An attempt the harness could not complete says nothing about the candidate, so it is not kept.
    if (verdict.conclusive) await cache.set(key, verdict.reproduced);
    return verdict.reproduced;
  };

  const replayOn = async (
    slot: ShrinkTarget,
    indices: readonly number[],
    phase: AttemptPhase,
    attempt: number,
  ): Promise<{ reproduced: boolean; conclusive: boolean }> => {
    // A latency rule is judged over the samples of `repeat` replays pooled, every other rule over one.
    const samples: number[] = [];
    let reproduced = false;
    for (let round = 0; round < repeat; round += 1) {
      await slot.reset();
      const run = await replayExchanges(listOf(indices), {
        ...sharedReplay,
        ...(slot.adapter === undefined ? {} : { adapter: slot.adapter }),
        recording: 'shrink attempt',
        target: slot.target,
        pace: 'max',
        concurrency: 1,
        rules,
        thresholds: emptyThresholds(),
        invariants: rule.kind === 'invariant',
        signal,
      });
      // An attempt cut short by the signal is spent but not judged.
      if (stopped()) throw new AttemptBudgetExceeded('stopped by signal');
      if (run.inconclusive.some((c) => RUN_LEVEL_INCONCLUSIVE_KINDS.has(c.kind))) {
        options.onAttempt?.({ attempt, phase, steps: indices.length, reproduced: false });
        return { reproduced: false, conclusive: false };
      }
      if (rule.kind === 'latency') samples.push(...latencySamples(run, rule.tag));
      else reproduced = reproduces(run, rule);
    }
    if (rule.kind === 'latency') reproduced = latencyBreached(samples, rule);
    options.onAttempt?.({ attempt, phase, steps: indices.length, reproduced });
    return { reproduced, conclusive: true };
  };

  const all = scope.map((_, i) => i);
  let current: number[] = all;
  let confirmed = false;
  try {
    confirmed = await judge(all, 'confirm');
    if (confirmed) {
      current = await ddmin(all, {
        closure: (subset) => prerequisites.closure(subset, always),
        test: (subset) => judge(subset, 'remove'),
        parallel: width,
        limit: () => maxAttempts - attempts,
        onDiscard: (discarded) => {
          for (const subset of discarded) {
            if (!replayed.has(subset)) continue;
            attempts -= 1;
            speculative += 1;
          }
        },
      });
      const lowerPaths =
        options.lower ??
        (rule.kind === 'invariant' && rule.system === 'candidate' ? DEFAULT_LOWER_PATHS : []);
      await lowerValues(current, steps, judge, lowerPaths, options.simplify ?? []);
    }
  } catch (err) {
    if (!(err instanceof AttemptBudgetExceeded)) throw err;
  }

  const kept: Step[] = confirmed ? current.map((i) => steps.get(i) as Step) : [];
  const finalExchanges = confirmed ? kept.map((s) => s.exchange) : [...original];
  const reducedSteps = finalExchanges.length;
  const valuesChanged = kept.some((s) => s.changed.size > 0);
  const successful = confirmed && (reducedSteps < original.length || valuesChanged);
  let recordingPath: string | null = null;
  if (options.out !== undefined && options.out !== null) {
    await writeExchanges(options.out, finalExchanges);
    recordingPath = options.out;
  }
  const reproduction: Reproduction = {
    rule: formatRule(rule),
    original_steps: original.length,
    reduced_steps: reducedSteps,
    attempts,
    successful,
    label: !successful
      ? 'reduction unsuccessful'
      : rule.kind === 'latency'
        ? 'reduced reproduction (statistical)'
        : 'reduced reproduction',
    ...(rule.kind === 'latency' ? { repeat } : {}),
    duration_ms: Math.round((now() - started) * 1000) / 1000,
    recording: recordingPath,
    ...(cacheHits > 0 ? { cache_hits: cacheHits } : {}),
    steps: confirmed
      ? kept.map(toStep)
      : original.map((exchange, index) =>
          toStep({ index, exchange, quantityReduced: false, changed: new Map() }),
        ),
  };
  return { reproduction, exchanges: finalExchanges, aborted: stopped(), speculative };
}

type Judge = (indices: readonly number[], phase: AttemptPhase) => Promise<boolean>;

/**
 * Lowers the integers at the `lower` paths toward one, then replaces the
 * values at the `simplify` paths with their minimal form, keeping each change
 * that still reproduces. Every change is recorded on its step.
 */
async function lowerValues(
  current: readonly number[],
  steps: Map<number, Step>,
  judge: Judge,
  lower: readonly string[],
  simplify: readonly string[],
): Promise<void> {
  for (const index of current) {
    const step = steps.get(index) as Step;
    for (const path of lower) await lowerPath(step, path, current, judge);
    for (const path of simplify) await simplifyPath(step, path, current, judge);
  }
}

/** Tries `value` at `segments` of the step's body. Keeps it when the rule still reproduces. */
async function tryValue(
  step: Step,
  segments: readonly Segment[],
  value: JsonValue,
  current: readonly number[],
  judge: Judge,
): Promise<boolean> {
  const before = step.exchange;
  const body = before.request.body;
  if (body === undefined) return false;
  step.exchange = {
    ...before,
    request: { ...before.request, body: setAt(body, segments, value) },
  };
  const ok = await judge(current, 'lower');
  if (!ok) step.exchange = before;
  return ok;
}

/** Records the final value at `segments` as a change when it differs from the recorded one. */
function recordChange(step: Step, segments: readonly Segment[], recorded: JsonValue): void {
  const now = valueAt(step.exchange.request.body, segments);
  const path = renderPath(segments);
  if (now === undefined || JSON.stringify(now) === JSON.stringify(recorded)) return;
  const known = step.changed.get(path);
  step.changed.set(path, { path, from: known?.from ?? recorded, to: now });
}

async function lowerPath(
  step: Step,
  path: string,
  current: readonly number[],
  judge: Judge,
): Promise<void> {
  const matches = select(step.exchange.request.body, path).filter(
    (m) => typeof m.value === 'number' && Number.isInteger(m.value) && m.value > 1,
  );
  for (const match of matches) {
    const recorded = match.value as number;
    const attempt = (value: number): Promise<boolean> =>
      tryValue(step, match.segments, value, current, judge);
    if (await attempt(1)) {
      step.quantityReduced = true;
      recordChange(step, match.segments, recorded);
      continue;
    }
    // Binary search between the largest failing value and the smallest working one.
    let low = 1;
    let high = recorded;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (await attempt(mid)) {
        high = mid;
        step.quantityReduced = true;
      } else {
        low = mid;
      }
    }
    recordChange(step, match.segments, recorded);
  }
}

async function simplifyPath(
  step: Step,
  path: string,
  current: readonly number[],
  judge: Judge,
): Promise<void> {
  for (const match of select(step.exchange.request.body, path)) {
    const minimal = minimalValue(match.value);
    if (minimal === undefined) continue;
    // An earlier change may have replaced this value already.
    const now = valueAt(step.exchange.request.body, match.segments);
    if (JSON.stringify(now) !== JSON.stringify(match.value)) continue;
    if (await tryValue(step, match.segments, minimal, current, judge)) {
      recordChange(step, match.segments, match.value);
    }
  }
}
