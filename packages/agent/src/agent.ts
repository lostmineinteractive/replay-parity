import {
  DEFAULT_REDACTED_HEADERS,
  createDiffer,
  type AgentReport,
  type AgentStopReason,
  type DiffRules,
  type Exchange,
  type HeaderMap,
  type KeptCase,
  type Run,
  type Thresholds,
} from '@replay-parity/core';
import type { Adapter } from '@replay-parity/replay';
import type { ModelClient, ModelUsage } from './client.js';
import { executeCase } from './execute.js';
import { costUsd, estimateCostUsd, priceFor } from './pricing.js';
import { cachePrefixLength, loadPrompts, renderTemplate, type Prompts } from './prompts.js';
import { describeKept, describeShapes, summarizeRun, tagsOf } from './summary.js';
import { validateCases, type Dropped } from './validate.js';

/**
 * The loop. Each round summarizes the run, asks the model for cases,
 * validates them, runs each against both systems, keeps the ones that
 * reveal something no kept case already reveals, and stops when a round
 * adds nothing, the budget is spent, or the round limit is reached.
 */
export interface AgentOptions {
  run: Run;
  recording: readonly Exchange[];
  rules: DiffRules;
  thresholds: Thresholds;
  adapters: { reference: Adapter; candidate: Adapter };
  client: ModelClient;
  budgetUsd: number;
  maxRounds: number;
  casesPerRound: number;
  /** Caller supplied headers applied to every request. */
  headers?: HeaderMap | undefined;
  prompts?: Prompts | undefined;
  maxTokens?: number | undefined;
  transcriptPath: string;
  casesPath: string;
  log?: ((line: string) => void) | undefined;
  /** Aborting stops the loop at the next case boundary with the stop reason `aborted`. */
  signal?: AbortSignal | undefined;
}

export interface TranscriptRound {
  round: number;
  user_prompt: string;
  response_text: string;
  stop_reason: string;
  refusal?: string | undefined;
  usage: ModelUsage;
  cost_usd: number;
  proposed: number;
  valid: number;
  dropped: Dropped[];
  parse_error?: string | undefined;
  executed: number;
  kept: string[];
  not_kept: { id: string; reason: string }[];
}

export interface Transcript {
  model: string;
  pricing_assumed: boolean;
  prompt_versions: Record<string, string>;
  system_prompt: string;
  rounds: TranscriptRound[];
  totals: { usage: ModelUsage; cost_usd: number; budget_usd: number };
  stop_reason: AgentStopReason;
}

export interface AgentOutcome {
  report: AgentReport;
  transcript: Transcript;
  cases: KeptCase[];
}

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
  };
}

export function buildUserPrompt(
  prompts: Prompts,
  options: Pick<AgentOptions, 'run' | 'recording' | 'maxRounds' | 'casesPerRound'>,
  round: number,
  kept: readonly KeptCase[],
): string {
  return renderTemplate(prompts.round.text, {
    round: String(round),
    max_rounds: String(options.maxRounds),
    count: String(options.casesPerRound),
    summary: summarizeRun(options.run),
    shapes: describeShapes(options.recording),
    redacted: DEFAULT_REDACTED_HEADERS.join(', '),
    kept: describeKept(kept),
  });
}

export async function runAgent(options: AgentOptions): Promise<AgentOutcome> {
  const prompts = options.prompts ?? loadPrompts();
  const log = options.log ?? (() => undefined);
  const maxTokens = options.maxTokens ?? 8192;
  const differ = createDiffer(options.rules);
  const tags = tagsOf(options.recording);
  const headers = options.headers ?? {};
  const model = options.client.model;
  const { assumed } = priceFor(model);

  const kept: KeptCase[] = [];
  const keys = new Set<string>();
  const rounds: TranscriptRound[] = [];
  let usage: ModelUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  let cost = 0;
  let proposed = 0;
  let valid = 0;
  let executed = 0;
  let stop: AgentStopReason = 'max_rounds';
  let round = 0;
  const stopped = (): boolean => options.signal?.aborted === true;

  while (round < options.maxRounds) {
    if (stopped()) {
      log('stopped by signal before the next round');
      stop = 'aborted';
      break;
    }
    round += 1;
    const user = buildUserPrompt(prompts, options, round, kept);
    const estimate = estimateCostUsd(model, prompts.system.text.length + user.length, maxTokens);
    if (cost + estimate > options.budgetUsd) {
      log(
        `round ${round}: a call could cost $${estimate.toFixed(3)} and $${cost.toFixed(3)} of $${options.budgetUsd} is spent, stopping`,
      );
      round -= 1;
      stop = 'budget';
      break;
    }
    log(`round ${round}: asking ${model} for up to ${options.casesPerRound} cases`);
    let response;
    try {
      response = await options.client.complete({
        system: prompts.system.text,
        user,
        cachePrefixLength: cachePrefixLength(user),
        maxTokens,
      });
    } catch (err) {
      log(`round ${round}: model call failed: ${(err as Error).message}`);
      stop = 'error';
      rounds.push({
        round,
        user_prompt: user,
        response_text: '',
        stop_reason: 'error',
        refusal: (err as Error).message,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        cost_usd: 0,
        proposed: 0,
        valid: 0,
        dropped: [],
        executed: 0,
        kept: [],
        not_kept: [],
      });
      break;
    }
    const callCost = costUsd(model, response.usage);
    usage = addUsage(usage, response.usage);
    cost = Math.round((cost + callCost) * 1_000_000) / 1_000_000;
    const entry: TranscriptRound = {
      round,
      user_prompt: user,
      response_text: response.text,
      stop_reason: response.stop_reason,
      refusal: response.refusal,
      usage: response.usage,
      cost_usd: callCost,
      proposed: 0,
      valid: 0,
      dropped: [],
      executed: 0,
      kept: [],
      not_kept: [],
    };
    rounds.push(entry);
    log(
      `round ${round}: ${response.usage.input_tokens} in, ${response.usage.cache_read_tokens} read from cache, ${response.usage.cache_write_tokens} written to cache, ${response.usage.output_tokens} out, $${callCost.toFixed(4)}, total $${cost.toFixed(4)}`,
    );

    if (response.stop_reason === 'refusal') {
      log(`round ${round}: the model declined: ${response.refusal ?? ''}`);
      stop = 'model_refusal';
      break;
    }
    const validation = validateCases(response.text, tags);
    entry.proposed = validation.proposed;
    entry.valid = validation.cases.length;
    entry.dropped = validation.dropped;
    entry.parse_error = validation.parse_error;
    proposed += validation.proposed;
    valid += validation.cases.length;
    if (validation.parse_error !== undefined) log(`round ${round}: ${validation.parse_error}`);
    for (const d of validation.dropped)
      log(`round ${round}: dropped case ${d.index + 1}: ${d.reason}`);
    if (validation.cases.length === 0) {
      stop = 'no_valid_cases';
      break;
    }

    let keptThisRound = 0;
    for (let i = 0; i < validation.cases.length; i += 1) {
      if (stopped()) {
        log(
          `round ${round}: stopped by signal after ${entry.executed} of ${validation.cases.length} cases`,
        );
        stop = 'aborted';
        break;
      }
      const c = validation.cases[i]!;
      const id = `case-${round}-${i + 1}`;
      const result = await executeCase(
        c,
        id,
        options.adapters,
        differ,
        options.thresholds,
        headers,
      );
      executed += 1;
      entry.executed += 1;
      if (result.dedupe_key === null) {
        entry.not_kept.push({ id, reason: result.error ?? 'no difference and no latency breach' });
        continue;
      }
      if (keys.has(result.dedupe_key)) {
        entry.not_kept.push({ id, reason: `same as a kept case (${result.dedupe_key})` });
        continue;
      }
      keys.add(result.dedupe_key);
      keptThisRound += 1;
      entry.kept.push(id);
      const last = (side: typeof result.reference) =>
        side.responses.length === 0
          ? null
          : {
              status: side.responses[side.responses.length - 1]!.status,
              latency_ms: side.responses[side.responses.length - 1]!.latency_ms,
            };
      kept.push({
        id,
        round,
        hypothesis: c.hypothesis,
        tags: c.tags,
        steps: c.steps,
        repeat: c.repeat,
        dedupe_key: result.dedupe_key,
        reference: last(result.reference),
        candidate: last(result.candidate),
        latency: result.latency,
        error: result.error,
        diff: result.diff,
        latency_breach: result.latency_breach,
        revealed: result.revealed,
      });
      log(`round ${round}: kept ${id}: ${result.revealed}`);
    }
    if (stop === 'aborted') break;
    if (keptThisRound === 0) {
      stop = 'no_new_cases';
      break;
    }
    if (cost >= options.budgetUsd) {
      stop = 'budget';
      break;
    }
    if (round >= options.maxRounds) {
      stop = 'max_rounds';
      break;
    }
  }

  const report: AgentReport = {
    model,
    rounds: round,
    max_rounds: options.maxRounds,
    budget_usd: options.budgetUsd,
    cost_usd: cost,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    proposed,
    valid,
    executed,
    kept: kept.length,
    stop_reason: stop,
    prompt_versions: prompts.versions,
    transcript_path: options.transcriptPath,
    cases_path: options.casesPath,
    cases: kept,
  };
  const transcript: Transcript = {
    model,
    pricing_assumed: assumed,
    prompt_versions: prompts.versions,
    system_prompt: prompts.system.text,
    rounds,
    totals: { usage, cost_usd: cost, budget_usd: options.budgetUsd },
    stop_reason: stop,
  };
  return { report, transcript, cases: kept };
}
