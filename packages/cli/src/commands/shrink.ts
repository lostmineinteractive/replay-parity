import {
  ConfigError,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PROGRESS_EVERY,
  EXIT_CODES,
  formatDuration,
  loadDiffRules,
  readRecording,
  readRun,
  writeRun,
} from '@replay-parity/core';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIME_BUDGET_MS,
  defaultRule,
  parseRule,
  shrink,
  verifyRecordingHash,
} from '@replay-parity/shrink';
import { HttpAdapter, upstreamFetch, type Adapter } from '@replay-parity/replay';
import { Command, Option } from 'commander';
import { displayText, type CliContext } from '../config/index.js';
import { endProgress, logger, out, startProgress, type CliStreams } from '../io.js';
import {
  collect,
  collectQuery,
  nonNegativeInt,
  positiveInt,
  resolveHeaders,
  resolveQuery,
} from '../options.js';
import {
  addAdapterModuleOptions,
  loadAdapterFromFlags,
  type AdapterModuleFlags,
} from '../adapter-module.js';
import { formatCheck, hasError, preflight } from '../preflight.js';
import {
  addUpstreamOptions,
  customUpstream,
  resolveUpstream,
  type UpstreamFlags,
} from '../upstream.js';

export interface ShrinkCommandOptions extends UpstreamFlags, AdapterModuleFlags {
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
  query: string[];
  barrierTag: string[];
  timeoutMs: number;
  allowRecordingMismatch: boolean;
  /** Run the preflight checks before the first attempt. Default true, `--no-preflight` turns it off. */
  preflight?: boolean;
  /** Probe the target and the reset URL in the preflight. Default false. */
  preflightProbe?: boolean;
  config?: string;
  profile?: string;
  /** The URLs as they should be printed, which is the unresolved text when one held a secret. */
  targetLabel?: string;
  resetLabel?: string;
  /** Print a progress line to stderr. Default false. */
  progress?: boolean;
  /** Attempts between progress lines, besides one every second. Default 100. */
  progressEvery?: number;
  /** With `--progress`, print the line again after this long without one. 0 disables. Default 60000. */
  heartbeatMs?: number;
}

/** What the progress line of a shrink reports. */
export interface ShrinkProgressState {
  attempts: number;
  /** The fewest steps that reproduced so far, null before the first reproduction. */
  bestSteps: number | null;
}

export function formatShrinkProgress(state: ShrinkProgressState, elapsedMs: number): string {
  return `shrink ${state.attempts} attempt${state.attempts === 1 ? '' : 's'}, best ${state.bestSteps ?? '?'} steps, elapsed ${formatDuration(elapsedMs)}`;
}

export async function runShrink(
  options: ShrinkCommandOptions,
  streams: CliStreams,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const log = logger(streams);
  const run = await readRun(options.run);
  // The run names the file it replayed by hash. A different file is refused unless asked.
  const check = await verifyRecordingHash({
    run,
    recording: options.recording,
    allowMismatch: options.allowRecordingMismatch,
  });
  if (check.mismatch) {
    log.warn(
      `warning: ${options.recording} has sha256 ${check.actual}, the run recorded ${check.expected}; shrinking it anyway`,
      { actual: check.actual, expected: check.expected },
    );
  }
  const exchanges = await readRecording(options.recording);
  const rules = options.rules === undefined ? run.rules : await loadDiffRules(options.rules);
  const rule = options.rule === undefined ? defaultRule(run) : parseRule(options.rule);
  if (rule === null) {
    throw new ConfigError(
      `${options.run} has no violated invariant and no mismatched exchange to reproduce`,
    );
  }
  const upstream = await resolveUpstream(options);
  if (options.preflight !== false) {
    const probe = options.preflightProbe === true;
    const checks = await preflight({
      recording: options.recording,
      exchanges,
      rules,
      barrierTags: options.barrierTag,
      target:
        probe && options.adapterModule === undefined
          ? { url: options.target, label: options.targetLabel ?? options.target, upstream }
          : undefined,
      reset: probe
        ? { url: options.reset, label: options.resetLabel ?? options.reset, upstream }
        : undefined,
    });
    for (const check of checks) {
      if (check.level === 'warn') log.warn(`preflight: ${formatCheck(check)}`);
      else if (check.level === 'error') log.error(`preflight: ${formatCheck(check)}`);
    }
    if (hasError(checks)) {
      log.error(
        'preflight failed, nothing was sent. rp validate prints every check, --no-preflight skips them.',
      );
      return EXIT_CODES.error;
    }
  }
  const headers = await resolveHeaders(options.header, options.headersFile, env);
  const queryOverrides = resolveQuery(options.query);
  const resetUrl = options.reset;
  const reset = async (): Promise<void> => {
    const res = customUpstream(upstream)
      ? await upstreamFetch(resetUrl, { method: 'POST' }, upstream)
      : await fetch(resetUrl, { method: 'POST' });
    if (!res.ok) {
      throw new ConfigError(`reset ${options.resetLabel ?? resetUrl} answered ${res.status}`);
    }
  };
  const startedAt = Date.now();
  const state: ShrinkProgressState = { attempts: 0, bestSteps: null };
  const progress =
    options.progress === true
      ? startProgress(streams, {
          every: options.progressEvery ?? DEFAULT_PROGRESS_EVERY,
          heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
          render: () => formatShrinkProgress(state, Date.now() - startedAt),
          fields: () => ({
            attempts: state.attempts,
            best_steps: state.bestSteps,
            elapsed_ms: Date.now() - startedAt,
          }),
        })
      : undefined;
  // One adapter serves every attempt, so the connection settings are applied once.
  const adapter: Adapter | undefined =
    (await loadAdapterFromFlags(options, {
      target: options.target,
      timeoutMs: options.timeoutMs,
      connections: 1,
    })) ??
    (customUpstream(upstream)
      ? new HttpAdapter(options.target, {
          ...upstream,
          timeoutMs: options.timeoutMs,
          connections: 1,
        })
      : undefined);
  let result: Awaited<ReturnType<typeof shrink>>;
  try {
    result = await shrink({
      exchanges,
      target: options.target,
      reset,
      rule,
      replay: {
        rules,
        headers,
        queryOverrides,
        barrierTags: options.barrierTag,
        timeoutMs: options.timeoutMs,
        ...(adapter === undefined ? {} : { adapter }),
      },
      maxAttempts: options.maxAttempts,
      timeBudgetMs: options.timeBudgetMs,
      out: options.out,
      onAttempt: (e) => {
        state.attempts = e.attempt;
        if (e.reproduced && (state.bestSteps === null || e.steps < state.bestSteps)) {
          state.bestSteps = e.steps;
        }
        log.info(
          `attempt ${e.attempt} (${e.phase}, ${e.steps} steps): ${e.reproduced ? 'reproduced' : 'did not reproduce'}`,
          { attempt: e.attempt, phase: e.phase, steps: e.steps, reproduced: e.reproduced },
        );
        progress?.update();
      },
      signal,
    });
  } finally {
    if (progress !== undefined) endProgress(streams, progress);
    await adapter?.close?.();
  }
  const { reproduction, aborted } = result;
  await writeRun(options.run, { ...run, reproduction });
  if (aborted) {
    log.warn(
      `shrink stopped by signal after ${reproduction.attempts} attempt${reproduction.attempts === 1 ? '' : 's'}, keeping the best reduction so far`,
      { attempts: reproduction.attempts },
    );
  }
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
  log.info(`wrote ${options.out} and updated ${options.run}`, {
    out: options.out,
    run: options.run,
    reduced_steps: reproduction.reduced_steps,
    attempts: reproduction.attempts,
  });
  return aborted ? EXIT_CODES.inconclusive : 0;
}

export function shrinkCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
  context?: CliContext,
): Command {
  const command = new Command('shrink')
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
    .option(
      '--query <name=value>',
      'query parameter applied to every request over the recorded value, repeatable',
      collectQuery,
      [],
    )
    .option('--barrier-tag <tag>', 'barrier tag kept for every attempt, repeatable', collect, [])
    .addOption(
      new Option('--timeout-ms <n>', 'request timeout').default(30_000).argParser(positiveInt),
    )
    .option(
      '--allow-recording-mismatch',
      'shrink even when the recording hash differs from the one the run recorded',
      false,
    )
    .option(
      '--no-preflight',
      'skip the checks of the rules and barrier tags against the recording before the first attempt',
    )
    .option('--preflight-probe', 'also probe the target and the reset URL first', false)
    .option(
      '--progress',
      'print a progress line to stderr every second or every --progress-every attempts',
      false,
    )
    .addOption(
      new Option('--progress-every <n>', 'attempts between progress lines')
        .default(DEFAULT_PROGRESS_EVERY)
        .argParser(positiveInt),
    )
    .addOption(
      new Option(
        '--heartbeat-ms <n>',
        'with --progress, print the line again after this long without one; 0 disables',
      )
        .default(DEFAULT_HEARTBEAT_MS)
        .argParser(nonNegativeInt),
    );
  addUpstreamOptions(command);
  addAdapterModuleOptions(command);
  return command.action(async (opts: ShrinkCommandOptions, command: Command) => {
    exit(
      await runShrink(
        {
          ...opts,
          targetLabel: displayText(command, 'target', opts.target),
          resetLabel: displayText(command, 'reset', opts.reset),
        },
        streams,
        signal,
        context?.env,
      ),
    );
  });
}
