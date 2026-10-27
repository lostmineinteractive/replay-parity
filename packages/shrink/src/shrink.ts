import { performance } from 'node:perf_hooks';
import {
  ConfigError,
  emptyRules,
  emptyThresholds,
  hashRecordingFile,
  isJsonObject,
  type Exchange,
  type JsonValue,
  type Reproduction,
  type ReproductionStep,
  type Run,
} from '@replay-parity/core';
import {
  replayExchanges,
  writeExchanges,
  type ReplayExchangesOptions,
} from '@replay-parity/replay';
import { AttemptBudgetExceeded, ddmin } from './ddmin.js';
import { Prerequisites } from './prerequisites.js';
import { formatRule, reproduces, witnessOf, type ShrinkRule } from './rule.js';

/**
 * Shrinking. Given a failing rule, find a shorter subsequence of the
 * recording that still trips it, then lower quantities toward one. Every
 * candidate is replayed against a freshly reset candidate system and judged
 * by the same rule. The result is a reduced reproduction, not a minimal one.
 */
export interface ShrinkOptions {
  exchanges: readonly Exchange[];
  target: string;
  /** Returns the candidate to its initial state. Called before every attempt. */
  reset: () => Promise<void>;
  rule: ShrinkRule;
  /** Replay settings shared by every attempt. Pacing is always `max` with one in flight. */
  replay?:
    | Partial<
        Pick<
          ReplayExchangesOptions,
          | 'rules'
          | 'headers'
          | 'barrierTags'
          | 'barrierTimeoutMs'
          | 'adapter'
          | 'timeoutMs'
          | 'maxBodyBytes'
          | 'redactHeaders'
        >
      >
    | undefined;
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
  attempt: number;
  phase: AttemptPhase;
  steps: number;
  reproduced: boolean;
}

export interface ShrinkResult {
  reproduction: Reproduction;
  exchanges: Exchange[];
  /** True when `signal` stopped the attempts before the reduction was done. */
  aborted: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 64;
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

const QUANTITY_FIELDS = ['qty', 'quantity'] as const;

interface Step {
  /** Index in the original list. */
  index: number;
  exchange: Exchange;
  quantityReduced: boolean;
}

function quantityFields(exchange: Exchange): (typeof QUANTITY_FIELDS)[number][] {
  const body = exchange.request.body;
  if (!isJsonObject(body)) return [];
  return QUANTITY_FIELDS.filter((f) => {
    const v = body[f];
    return typeof v === 'number' && Number.isInteger(v) && v > 1;
  });
}

function withQuantity(exchange: Exchange, field: string, value: number): Exchange {
  const body = exchange.request.body as Record<string, JsonValue>;
  return { ...exchange, request: { ...exchange.request, body: { ...body, [field]: value } } };
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
  return out;
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
  const original = options.exchanges;
  if (original.length === 0) throw new ConfigError('nothing to shrink: the recording is empty');

  const witnessId = witnessOf(options.rule);
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
  scope.forEach((exchange, index) => steps.set(index, { index, exchange, quantityReduced: false }));
  const listOf = (indices: readonly number[]): Exchange[] =>
    indices.map((i) => (steps.get(i) as Step).exchange);

  const signal = options.signal;
  const stopped = (): boolean => signal?.aborted === true;

  const judge = async (indices: readonly number[], phase: AttemptPhase): Promise<boolean> => {
    if (stopped()) throw new AttemptBudgetExceeded('stopped by signal');
    if (attempts >= maxAttempts || now() - started > timeBudgetMs)
      throw new AttemptBudgetExceeded();
    attempts += 1;
    await options.reset();
    const run = await replayExchanges(listOf(indices), {
      ...options.replay,
      recording: 'shrink attempt',
      target: options.target,
      pace: 'max',
      concurrency: 1,
      rules,
      thresholds: emptyThresholds(),
      invariants: options.rule.kind === 'invariant',
      signal,
    });
    // An attempt cut short by the signal is spent but not judged.
    if (stopped()) throw new AttemptBudgetExceeded('stopped by signal');
    const reproduced = reproduces(run, options.rule);
    options.onAttempt?.({ attempt: attempts, phase, steps: indices.length, reproduced });
    return reproduced;
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
      });
      if (options.rule.kind === 'invariant' && options.rule.system === 'candidate') {
        await lowerQuantities(current, steps, judge);
      }
    }
  } catch (err) {
    if (!(err instanceof AttemptBudgetExceeded)) throw err;
  }

  const kept: Step[] = confirmed ? current.map((i) => steps.get(i) as Step) : [];
  const finalExchanges = confirmed ? kept.map((s) => s.exchange) : [...original];
  const reducedSteps = finalExchanges.length;
  const quantityLowered = kept.some((s) => s.quantityReduced);
  const successful = confirmed && (reducedSteps < original.length || quantityLowered);
  let recordingPath: string | null = null;
  if (options.out !== undefined && options.out !== null) {
    await writeExchanges(options.out, finalExchanges);
    recordingPath = options.out;
  }
  const reproduction: Reproduction = {
    rule: formatRule(options.rule),
    original_steps: original.length,
    reduced_steps: reducedSteps,
    attempts,
    successful,
    label: successful ? 'reduced reproduction' : 'reduction unsuccessful',
    duration_ms: Math.round((now() - started) * 1000) / 1000,
    recording: recordingPath,
    steps: confirmed
      ? kept.map(toStep)
      : original.map((exchange, index) => toStep({ index, exchange, quantityReduced: false })),
  };
  return { reproduction, exchanges: finalExchanges, aborted: stopped() };
}

/** Lowers `qty` and `quantity` fields toward one, keeping each change that still reproduces. */
async function lowerQuantities(
  current: readonly number[],
  steps: Map<number, Step>,
  judge: (indices: readonly number[], phase: AttemptPhase) => Promise<boolean>,
): Promise<void> {
  for (const index of current) {
    const step = steps.get(index) as Step;
    for (const field of quantityFields(step.exchange)) {
      const body = step.exchange.request.body as Record<string, JsonValue>;
      const recorded = body[field] as number;
      const tryValue = async (value: number): Promise<boolean> => {
        const before = step.exchange;
        step.exchange = withQuantity(before, field, value);
        const ok = await judge(current, 'lower');
        if (ok) {
          step.quantityReduced = true;
        } else {
          step.exchange = before;
        }
        return ok;
      };
      if (await tryValue(1)) continue;
      // Binary search between the largest failing value and the smallest working one.
      let low = 1;
      let high = recorded;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (await tryValue(mid)) high = mid;
        else low = mid;
      }
    }
  }
}
