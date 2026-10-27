import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AnthropicModelClient,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  loadPricingFile,
  pricingStaleness,
  resetByPost,
  resolvePrices,
  runAgent,
  writeCaseRecording,
  type ModelClient,
  type ResetHooks,
} from '@replay-parity/agent';
import {
  EXIT_CODES,
  emptyRules,
  emptyThresholds,
  loadDiffRules,
  loadThresholds,
  readRecording,
  readRun,
  writeRun,
} from '@replay-parity/core';
import { HttpAdapter } from '@replay-parity/replay';
import { Command, Option } from 'commander';
import { loadDotEnv } from '../env.js';
import { err, out, type CliStreams } from '../io.js';
import { collect, positiveInt, positiveNumber, resolveHeaders } from '../options.js';

export interface AgentCommandOptions {
  run: string;
  recording: string;
  target: string;
  reference: string;
  rules?: string;
  thresholds?: string;
  out: string;
  casesPerRound: number;
  model: string;
  budgetUsd: number;
  maxRounds: number;
  header: string[];
  headersFile?: string;
  timeoutMs: number;
  env: string;
  /** A JSON table of model id to prices, applied over the built in one. */
  pricing?: string;
  /** Retry a declined round on a fallback model inside the same call. `--no-fallbacks` clears it. Default true. */
  fallbacks?: boolean;
  /** Write the kept cases as a recording here. */
  exportRecording?: string;
  /** URL on the candidate that receives a POST before every case. */
  resetBetweenCases?: string;
  /** The same for the reference. */
  resetReference?: string;
  /** Cases in flight at once. Applies only without resets. Default 1. */
  caseConcurrency?: number;
}

export interface ClientFactoryOptions {
  fallbacks: boolean;
  timeoutMs: number;
}

export interface AgentCommandHooks {
  /** Builds the model client. Tests pass a mock. Default: the Anthropic client on the key. */
  clientFactory?:
    ((apiKey: string, model: string, options: ClientFactoryOptions) => ModelClient) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** The clock the pricing staleness warning is judged on. Tests pass a fixed date. */
  now?: (() => Date) | undefined;
}

export const NO_KEY_MESSAGE =
  'rp agent: ANTHROPIC_API_KEY is not set, so the agent did not run. Set it in the shell or in a .env file at the repository root to generate cases.';

/** The no key message with every `.env` path that was looked at. */
export function noKeyMessage(tried: readonly string[]): string {
  return `${NO_KEY_MESSAGE} Looked for a .env file at ${tried.join(' and then at ')}.`;
}

export async function runAgentCommand(
  options: AgentCommandOptions,
  streams: CliStreams,
  hooks: AgentCommandHooks = {},
  signal?: AbortSignal,
): Promise<number> {
  const env = hooks.env ?? process.env;
  const dotEnv = loadDotEnv(options.env, env);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    out(streams, noKeyMessage(dotEnv.tried));
    return 0;
  }
  const staleness = pricingStaleness(hooks.now?.());
  if (staleness !== null) err(streams, `agent: ${staleness}`);
  const prices = resolvePrices(
    options.pricing === undefined ? undefined : await loadPricingFile(options.pricing),
  );
  const run = await readRun(options.run);
  const recording = await readRecording(options.recording);
  const rules = options.rules === undefined ? run.rules : await loadDiffRules(options.rules);
  const thresholds =
    options.thresholds === undefined ? run.thresholds : await loadThresholds(options.thresholds);
  const headers = await resolveHeaders(options.header, options.headersFile);
  const clientOptions: ClientFactoryOptions = {
    fallbacks: options.fallbacks ?? true,
    timeoutMs: options.timeoutMs,
  };
  const client =
    hooks.clientFactory === undefined
      ? new AnthropicModelClient({
          apiKey,
          model: options.model,
          timeoutMs: options.timeoutMs,
          fallbacks: clientOptions.fallbacks,
        })
      : hooks.clientFactory(apiKey, options.model, clientOptions);
  const reference = new HttpAdapter(options.reference, { timeoutMs: options.timeoutMs });
  const candidate = new HttpAdapter(options.target, { timeoutMs: options.timeoutMs });
  const resets: ResetHooks = {};
  if (options.resetBetweenCases !== undefined) {
    resets.candidate = resetByPost(options.resetBetweenCases);
  }
  if (options.resetReference !== undefined) resets.reference = resetByPost(options.resetReference);
  const transcriptPath = join(dirname(options.out), 'agent-transcript.json');
  try {
    const outcome = await runAgent({
      run,
      recording,
      rules: rules ?? emptyRules(),
      thresholds: thresholds ?? emptyThresholds(),
      adapters: { reference, candidate },
      client,
      budgetUsd: options.budgetUsd,
      maxRounds: options.maxRounds,
      casesPerRound: options.casesPerRound,
      headers,
      maxTokens: DEFAULT_MAX_TOKENS,
      transcriptPath,
      casesPath: options.out,
      prices,
      pricingPath: options.pricing,
      resets,
      caseConcurrency: options.caseConcurrency ?? 1,
      log: (line) => err(streams, `agent: ${line}`),
      signal,
    });
    await writeFile(
      options.out,
      outcome.cases.map((c) => JSON.stringify(c)).join('\n') +
        (outcome.cases.length > 0 ? '\n' : ''),
      'utf8',
    );
    await writeFile(transcriptPath, `${JSON.stringify(outcome.transcript, null, 2)}\n`, 'utf8');
    await writeRun(options.run, { ...run, agent: outcome.report });
    const lines: string[] = [];
    if (options.exportRecording !== undefined) {
      const n = await writeCaseRecording(options.exportRecording, outcome.exchanges);
      lines.push(
        `  wrote ${options.exportRecording} with ${n} exchange${n === 1 ? '' : 's'} from the kept cases`,
      );
    }
    const r = outcome.report;
    const t = outcome.transcript;
    const fallbacks = t.rounds.filter((round) => round.fallback_ran);
    out(
      streams,
      [
        `agent: ${r.model}, ${r.rounds} of ${r.max_rounds} rounds, stopped on ${r.stop_reason}`,
        `  proposed ${r.proposed}, valid ${r.valid}, executed ${r.executed}, kept ${r.kept}`,
        `  tokens: ${r.input_tokens} in, ${r.output_tokens} out, ${r.cache_read_tokens} cache read, ${r.cache_write_tokens} cache write`,
        `  cost: $${r.cost_usd.toFixed(4)} of a $${r.budget_usd.toFixed(2)} budget`,
        ...fallbacks.map(
          (round) =>
            `  round ${round.round} was answered by ${round.answered_by ?? 'a fallback model'}`,
        ),
        `  isolation: ${t.isolation.reset_between_cases ? 'reset before every case' : 'no reset'}, ${t.isolation.case_concurrency} case${t.isolation.case_concurrency === 1 ? '' : 's'} at a time`,
        ...r.cases.map((c) => `  ${c.id} [${c.tags.join(', ')}] ${c.hypothesis}: ${c.revealed}`),
        `  wrote ${options.out}, ${transcriptPath}, and the agent section of ${options.run}`,
        ...lines,
      ].join('\n'),
    );
    if (r.stop_reason === 'aborted') {
      err(streams, 'agent stopped by signal at a case boundary');
      return EXIT_CODES.inconclusive;
    }
    return 0;
  } finally {
    await reference.close();
    await candidate.close();
  }
}

export function agentCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
  hooks: AgentCommandHooks = {},
): Command {
  return new Command('agent')
    .description(
      'Ask a model for new cases that sharpen the differences a run found, send each to both systems, keep the ones that reveal something new, and add an agent section to the run. Without ANTHROPIC_API_KEY it prints a message and exits 0.',
    )
    .requiredOption('--run <path>', 'run file from rp replay, updated in place')
    .requiredOption('--recording <path>', 'the recording the run replayed')
    .requiredOption('--target <url>', 'base URL of the candidate system')
    .requiredOption('--reference <url>', 'base URL of the reference system')
    .option('--rules <path>', 'diff rules file; default: the rules embedded in the run')
    .option('--thresholds <path>', 'thresholds file; default: the thresholds embedded in the run')
    .option(
      '--out <path>',
      'kept cases file; the transcript lands next to it',
      'generated-cases.jsonl',
    )
    .addOption(
      new Option('--cases-per-round <n>', 'cases to ask for per round')
        .default(8)
        .argParser(positiveInt),
    )
    .option('--model <id>', 'model id', DEFAULT_MODEL)
    .addOption(
      new Option('--budget-usd <n>', 'spending limit in US dollars')
        .default(2)
        .argParser(positiveNumber),
    )
    .addOption(new Option('--max-rounds <n>', 'round limit').default(3).argParser(positiveInt))
    .option(
      '--pricing <path>',
      'JSON file of model id to prices per million tokens, applied over the built in table',
    )
    .option(
      '--no-fallbacks',
      'do not retry a declined round on a fallback model inside the same call',
    )
    .option(
      '--export-recording <path>',
      'write the kept cases as a recording that rp replay can take',
    )
    .option(
      '--reset-between-cases <url>',
      'URL on the candidate that receives a POST before every case and returns it to its initial state',
    )
    .option('--reset-reference <url>', 'URL on the reference that receives the same POST')
    .addOption(
      new Option('--case-concurrency <n>', 'cases in flight at once; applies only without resets')
        .default(1)
        .argParser(positiveInt),
    )
    .option('--header <name: value>', 'header applied to every request, repeatable', collect, [])
    .option('--headers-file <path>', 'file with one "name: value" header per line')
    .addOption(
      new Option('--timeout-ms <n>', 'request timeout for both systems and the model')
        .default(120_000)
        .argParser(positiveInt),
    )
    .option(
      '--env <path>',
      '.env file read for ANTHROPIC_API_KEY when the variable is not set',
      '.env',
    )
    .action(async (opts: AgentCommandOptions) => {
      exit(await runAgentCommand(opts, streams, hooks, signal));
    });
}
