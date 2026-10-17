import { ConfigError, loadDiffRules, readRecording, readRun, writeRun } from '@replay-parity/core';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIME_BUDGET_MS,
  defaultRule,
  parseRule,
  shrink,
} from '@replay-parity/shrink';
import { Command, Option } from 'commander';
import { err, out, type CliStreams } from '../io.js';
import { collect, positiveInt, resolveHeaders } from '../options.js';

export interface ShrinkCommandOptions {
  run: string;
  recording: string;
  target: string;
  reset: string;
  rule?: string;
  rules?: string;
  maxAttempts: number;
  timeBudgetMs: number;
  out: string;
  header: string[];
  headersFile?: string;
  barrierTag: string[];
  timeoutMs: number;
}

export async function runShrink(
  options: ShrinkCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const run = await readRun(options.run);
  const exchanges = await readRecording(options.recording);
  const rules = options.rules === undefined ? run.rules : await loadDiffRules(options.rules);
  const rule = options.rule === undefined ? defaultRule(run) : parseRule(options.rule);
  if (rule === null) {
    throw new ConfigError(
      `${options.run} has no violated invariant and no mismatched exchange to reproduce`,
    );
  }
  const headers = await resolveHeaders(options.header, options.headersFile);
  const resetUrl = options.reset;
  const reset = async (): Promise<void> => {
    const res = await fetch(resetUrl, { method: 'POST' });
    if (!res.ok) throw new ConfigError(`reset ${resetUrl} answered ${res.status}`);
  };
  const { reproduction } = await shrink({
    exchanges,
    target: options.target,
    reset,
    rule,
    replay: { rules, headers, barrierTags: options.barrierTag, timeoutMs: options.timeoutMs },
    maxAttempts: options.maxAttempts,
    timeBudgetMs: options.timeBudgetMs,
    out: options.out,
    onAttempt: (e) =>
      err(
        streams,
        `attempt ${e.attempt} (${e.phase}, ${e.steps} steps): ${e.reproduced ? 'reproduced' : 'did not reproduce'}`,
      ),
  });
  await writeRun(options.run, { ...run, reproduction });
  out(
    streams,
    `${reproduction.label}: ${reproduction.original_steps} -> ${reproduction.reduced_steps} steps in ${reproduction.attempts} attempt${reproduction.attempts === 1 ? '' : 's'} for ${reproduction.rule}`,
  );
  for (const s of reproduction.steps) {
    out(
      streams,
      `  ${s.method} ${s.path}${s.body === undefined ? '' : ` ${JSON.stringify(s.body)}`}${s.quantity_reduced ? ' (quantity reduced)' : ''}`,
    );
  }
  err(streams, `wrote ${options.out} and updated ${options.run}`);
  return 0;
}

export function shrinkCommand(streams: CliStreams, exit: (code: number) => void): Command {
  return new Command('shrink')
    .description(
      'Reduce a failing run to a reduced reproduction by replaying subsets of the recording against a reset candidate. Updates the run file in place.',
    )
    .requiredOption('--run <path>', 'the failing run file')
    .requiredOption('--recording <path>', 'the recording the run replayed')
    .requiredOption('--target <url>', 'base URL of the candidate system')
    .requiredOption(
      '--reset <url>',
      'URL that receives a POST before every attempt and returns the candidate to its initial state',
    )
    .option(
      '--rule <rule>',
      'rule to reproduce: invariant:<system>:<name> or mismatch:<exchange id>[:<path>]; default: the first violated invariant, else the first mismatch',
    )
    .option('--rules <path>', 'diff rules file; default: the rules embedded in the run')
    .addOption(
      new Option('--max-attempts <n>', 'most replays to spend')
        .default(DEFAULT_MAX_ATTEMPTS)
        .argParser(positiveInt),
    )
    .addOption(
      new Option('--time-budget-ms <n>', 'most time to spend')
        .default(DEFAULT_TIME_BUDGET_MS)
        .argParser(positiveInt),
    )
    .option('--out <path>', 'reduced recording to write', 'reduced-reproduction.jsonl')
    .option('--header <name: value>', 'header applied to every request, repeatable', collect, [])
    .option('--headers-file <path>', 'file with one "name: value" header per line')
    .option('--barrier-tag <tag>', 'barrier tag kept for every attempt, repeatable', collect, [])
    .addOption(
      new Option('--timeout-ms <n>', 'request timeout').default(30_000).argParser(positiveInt),
    )
    .action(async (opts: ShrinkCommandOptions) => {
      exit(await runShrink(opts, streams));
    });
}
