import {
  ConfigError,
  emptyRules,
  emptyThresholds,
  exitCodeFor,
  loadDiffRules,
  loadThresholds,
  writeRun,
  type PacingMode,
} from '@replay-parity/core';
import {
  BusAdapter,
  DEFAULT_BARRIER_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_GAP_MS,
  RedisStreamsBus,
  replay,
  type Adapter,
} from '@replay-parity/replay';
import { renderTerminal } from '@replay-parity/report';
import { Command, Option } from 'commander';
import { err, out, type CliStreams } from '../io.js';
import {
  collect,
  nonNegativeInt,
  parseFilter,
  parseHeaderOption,
  positiveInt,
  positiveNumber,
  resolveHeaders,
} from '../options.js';

export interface ReplayCommandOptions {
  recording: string;
  target: string;
  out: string;
  pace: PacingMode;
  rps?: number;
  concurrency: number;
  warmup: number;
  filter?: string;
  limit?: number;
  includeDependencies: boolean;
  maxGapMs: number;
  rules?: string;
  thresholds?: string;
  adapter: 'http' | 'bus';
  busUrl?: string;
  header: string[];
  headersFile?: string;
  barrierTag: string[];
  barrierTimeoutMs: number;
  candidateRecording?: string;
  invariants: boolean;
  timeoutMs: number;
  maxBodyBytes?: number;
  quiet: boolean;
}

export async function runReplay(
  options: ReplayCommandOptions,
  streams: CliStreams,
  signal?: AbortSignal,
): Promise<number> {
  const rules = options.rules === undefined ? emptyRules() : await loadDiffRules(options.rules);
  const thresholds =
    options.thresholds === undefined ? emptyThresholds() : await loadThresholds(options.thresholds);
  const headers = await resolveHeaders(options.header, options.headersFile);
  let adapter: Adapter | undefined;
  let bus: RedisStreamsBus | undefined;
  if (options.adapter === 'bus') {
    if (options.busUrl === undefined) throw new ConfigError('--adapter bus needs --bus-url');
    bus = await RedisStreamsBus.connect(options.busUrl);
    adapter = await BusAdapter.create(bus, { timeoutMs: options.timeoutMs });
  }
  try {
    const run = await replay({
      recording: options.recording,
      target: options.target,
      adapter,
      pace: options.pace,
      rps: options.rps ?? null,
      concurrency: options.concurrency,
      warmup: options.warmup,
      filterTag: options.filter ?? null,
      limit: options.limit ?? null,
      includeDependencies: options.includeDependencies,
      maxGapMs: options.maxGapMs,
      rules,
      thresholds,
      headers,
      barrierTags: options.barrierTag,
      barrierTimeoutMs: options.barrierTimeoutMs,
      candidateRecording: options.candidateRecording ?? null,
      invariants: options.invariants,
      timeoutMs: options.timeoutMs,
      maxBodyBytes: options.maxBodyBytes,
      signal,
    });
    await writeRun(options.out, run);
    if (run.filter.dependencies > 0) {
      err(
        streams,
        `selected ${run.filter.dependencies} dependency exchange${run.filter.dependencies === 1 ? '' : 's'} that produce values the filtered exchanges use`,
      );
    }
    if (run.pacing.gaps_capped > 0) {
      err(
        streams,
        `capped ${run.pacing.gaps_capped} recorded gap${run.pacing.gaps_capped === 1 ? '' : 's'} at ${run.pacing.max_gap_ms} ms`,
      );
    }
    const aborted = run.inconclusive.find((c) => c.kind === 'aborted');
    if (aborted !== undefined) err(streams, `replay ${aborted.detail}, writing the partial run`);
    if (!options.quiet) out(streams, renderTerminal(run));
    err(streams, `wrote ${options.out}: ${run.verdict.toUpperCase()}`);
    return exitCodeFor(run.verdict);
  } finally {
    if (adapter?.close) await adapter.close();
    if (bus) await bus.close();
  }
}

export function replayCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
): Command {
  return new Command('replay')
    .description(
      'Replay a recording against the candidate, diff every response, evaluate the thresholds, and write run.json. Exits 0 on pass, 2 on fail, 3 on inconclusive, 1 on a tool error.',
    )
    .requiredOption('--recording <path>', 'recording to replay')
    .requiredOption('--target <url>', 'base URL of the candidate system')
    .option('--out <path>', 'run file to write', 'run.json')
    .addOption(
      new Option('--pace <mode>', 'send schedule')
        .choices(['as-recorded', 'fixed-rate', 'max'])
        .default('as-recorded'),
    )
    .addOption(
      new Option('--rps <n>', 'requests per second under fixed-rate pacing').argParser(
        positiveNumber,
      ),
    )
    .addOption(
      new Option('--concurrency <n>', 'most requests in flight at once')
        .default(DEFAULT_CONCURRENCY)
        .argParser(positiveInt),
    )
    .addOption(
      new Option('--warmup <n>', 'leading exchanges that run but do not count')
        .default(0)
        .argParser(nonNegativeInt),
    )
    .addOption(
      new Option('--filter <tag=name>', 'replay only exchanges carrying this tag').argParser(
        parseFilter,
      ),
    )
    .addOption(
      new Option('--limit <n>', 'replay only the first n exchanges after filtering').argParser(
        positiveInt,
      ),
    )
    .option(
      '--no-include-dependencies',
      'with --filter, do not also replay the exchanges that produce the substituted values the filtered exchanges use',
    )
    .addOption(
      new Option(
        '--max-gap-ms <n>',
        'longest recorded gap kept under as-recorded pacing, 0 keeps every gap',
      )
        .default(DEFAULT_MAX_GAP_MS)
        .argParser(nonNegativeInt),
    )
    .option('--rules <path>', 'diff rules file (diff-rules.yaml)')
    .option('--thresholds <path>', 'thresholds file (thresholds.yaml)')
    .addOption(new Option('--adapter <name>', 'transport').choices(['http', 'bus']).default('http'))
    .option('--bus-url <url>', 'Redis URL for the bus adapter')
    .option(
      '--header <name: value>',
      'header applied to every request over the recorded value, repeatable',
      collect,
      [],
    )
    .option('--headers-file <path>', 'file with one "name: value" header per line')
    .option(
      '--barrier-tag <tag>',
      'tag whose exchanges wait for every earlier exchange to be acknowledged, repeatable',
      collect,
      [],
    )
    .addOption(
      new Option(
        '--barrier-timeout-ms <n>',
        'longest wait at a barrier before the run is inconclusive',
      )
        .default(DEFAULT_BARRIER_TIMEOUT_MS)
        .argParser(positiveInt),
    )
    .option(
      '--candidate-recording <path>',
      'write the requests as sent and the candidate responses here',
    )
    .option('--invariants', 'evaluate the independent invariants on both recordings', false)
    .addOption(
      new Option('--timeout-ms <n>', 'request timeout').default(30_000).argParser(positiveInt),
    )
    .addOption(
      new Option(
        '--max-body-bytes <n>',
        'candidate bodies above this size are stored as a hash',
      ).argParser(nonNegativeInt),
    )
    .option('--quiet', 'do not print the terminal summary', false)
    .action(async (opts: ReplayCommandOptions) => {
      exit(await runReplay(opts, streams, signal));
    });
}

export function validateHeaderOptions(values: readonly string[]): void {
  for (const value of values) parseHeaderOption(value);
}
