import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ConfigError,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PROGRESS_EVERY,
  EXIT_CODES,
  PROMETHEUS_CONTENT_TYPE,
  emptyRules,
  emptyThresholds,
  exitCodeFor,
  formatDuration,
  generateTraceId,
  loadDiffRules,
  loadThresholds,
  hashRecordingFile,
  readRecording,
  replayMetrics,
  writeRun,
  type MetricsRegistry,
  type PacingMode,
} from '@replay-parity/core';
import {
  BusAdapter,
  DEFAULT_BARRIER_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_GAP_MS,
  HttpAdapter,
  RedisStreamsBus,
  replayExchanges,
  type Adapter,
  type ReplayProgress,
} from '@replay-parity/replay';
import { renderTerminal } from '@replay-parity/report';
import { Command, InvalidArgumentError, Option } from 'commander';
import { displayText, type CliContext } from '../config/index.js';
import { endProgress, logger, out, startProgress, type CliStreams } from '../io.js';
import {
  collect,
  collectQuery,
  nonNegativeInt,
  parseFilter,
  parseHeaderOption,
  positiveInt,
  positiveNumber,
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

export interface ReplayCommandOptions extends UpstreamFlags, AdapterModuleFlags {
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
  busGroup?: string;
  busConsumer?: string;
  header: string[];
  headersFile?: string;
  query: string[];
  barrierTag: string[];
  barrierTimeoutMs: number;
  candidateRecording?: string;
  invariants: boolean;
  timeoutMs: number;
  maxBodyBytes?: number;
  quiet: boolean;
  /** Run the preflight checks before sending. Default true, `--no-preflight` turns it off. */
  preflight?: boolean;
  /** Probe the target in the preflight. Default false. */
  preflightProbe?: boolean;
  config?: string;
  profile?: string;
  /** The target as it should be printed, which is the unresolved text when it held a secret. */
  targetLabel?: string;
  /** Print a progress line to stderr. Default false. */
  progress?: boolean;
  /** Exchanges between progress lines, besides one every second. Default 100. */
  progressEvery?: number;
  /** With `--progress`, print the line again after this long without one. 0 disables. Default 60000. */
  heartbeatMs?: number;
  /** Send a `traceparent` header on every request. Default false; `RP_TRACE=1` turns it on too. */
  trace?: boolean;
  /** Serve Prometheus metrics at `/metrics` on this port until the run ends. 0 picks a free port. */
  metricsPort?: number;
}

/** What the progress line of a replay reports. */
export interface ReplayProgressState {
  completed: number;
  total: number;
  errors: number;
  mismatches: number;
  inflight: number;
  scheduleEndMs: number;
}

/**
 * The remaining time: the later of what the schedule still holds and what
 * the achieved rate predicts, so an idle gap ahead and a slow candidate are
 * both covered. Null before anything completed under max pacing.
 */
export function replayEtaMs(state: ReplayProgressState, elapsedMs: number): number | null {
  const remaining = state.total - state.completed;
  if (remaining <= 0) return 0;
  const bySchedule = state.scheduleEndMs - elapsedMs;
  if (state.completed === 0 || elapsedMs <= 0) return bySchedule > 0 ? bySchedule : null;
  const byRate = (remaining * elapsedMs) / state.completed;
  return Math.max(bySchedule, byRate);
}

export function formatReplayProgress(state: ReplayProgressState, elapsedMs: number): string {
  const rps = elapsedMs > 0 ? (state.completed * 1000) / elapsedMs : 0;
  const eta = replayEtaMs(state, elapsedMs);
  return `replay ${state.completed}/${state.total} errors ${state.errors} mismatches ${state.mismatches} inflight ${state.inflight} ${rps.toFixed(1)} rps elapsed ${formatDuration(elapsedMs)} eta ${eta === null ? '?' : formatDuration(eta)}`;
}

export interface MetricsServer {
  port: number;
  close(): Promise<void>;
}

/** Serves `GET /metrics` from the registry on every interface. Anything else answers 404. */
export async function serveMetrics(
  registry: MetricsRegistry,
  port: number,
): Promise<MetricsServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
      res.end(registry.render());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found, the metrics are at /metrics\n');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    throw new ConfigError(`--metrics-port ${port}: ${(e as Error).message}`);
  }
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e === undefined ? resolve() : reject(e)));
        server.closeAllConnections();
      }),
  };
}

function portNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError('expected a port from 0 to 65535');
  }
  return n;
}

export async function runReplay(
  options: ReplayCommandOptions,
  streams: CliStreams,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const traceId = options.trace === true || env.RP_TRACE === '1' ? generateTraceId() : undefined;
  const log =
    traceId === undefined ? logger(streams) : logger(streams).child({ trace_id: traceId });
  const rules = options.rules === undefined ? emptyRules() : await loadDiffRules(options.rules);
  const thresholds =
    options.thresholds === undefined ? emptyThresholds() : await loadThresholds(options.thresholds);
  const headers = await resolveHeaders(options.header, options.headersFile, env);
  const queryOverrides = resolveQuery(options.query);
  const upstream = await resolveUpstream(options);
  // The file is read once for the preflight and the replay, and hashed in a second
  // streaming pass, so the run carries the recording hash the way replay() records it.
  const [exchanges, recordingHash] = await Promise.all([
    readRecording(options.recording),
    hashRecordingFile(options.recording),
  ]);
  if (options.preflight !== false) {
    const checks = await preflight({
      recording: options.recording,
      exchanges,
      rules,
      thresholds,
      barrierTags: options.barrierTag,
      target:
        options.preflightProbe === true &&
        options.adapter === 'http' &&
        options.adapterModule === undefined
          ? { url: options.target, label: options.targetLabel ?? options.target, upstream }
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
  if (traceId !== undefined) {
    log.info(
      `trace id ${traceId}: every request carries traceparent 00-${traceId}-<span id>-01 with the span id derived from the exchange id`,
    );
  }
  const metrics = options.metricsPort === undefined ? undefined : replayMetrics();
  const metricsServer =
    metrics === undefined
      ? undefined
      : await serveMetrics(metrics.registry, options.metricsPort ?? 0);
  if (metricsServer !== undefined) {
    log.info(
      `serving metrics at http://localhost:${metricsServer.port}/metrics until the run ends`,
      {
        metrics_port: metricsServer.port,
      },
    );
  }
  const startedAt = Date.now();
  const state: ReplayProgressState = {
    completed: 0,
    total: 0,
    errors: 0,
    mismatches: 0,
    inflight: 0,
    scheduleEndMs: 0,
  };
  const progress =
    options.progress === true
      ? startProgress(streams, {
          every: options.progressEvery ?? DEFAULT_PROGRESS_EVERY,
          heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
          render: () => formatReplayProgress(state, Date.now() - startedAt),
          fields: () => ({ ...state, elapsed_ms: Date.now() - startedAt }),
        })
      : undefined;
  const onProgress =
    progress === undefined && metrics === undefined
      ? undefined
      : (p: ReplayProgress): void => {
          state.completed = p.completed;
          state.total = p.total;
          state.inflight = p.inflight;
          state.scheduleEndMs = p.schedule_end_ms;
          metrics?.inflight.set(p.inflight);
          if (p.last === null) return;
          const failed = p.last.error !== null;
          const mismatched = p.last.diff?.verdict === 'mismatch';
          if (failed) state.errors += 1;
          if (mismatched) state.mismatches += 1;
          if (metrics !== undefined) {
            metrics.sent.inc();
            if (p.last.candidate !== null) {
              metrics.acked.inc();
              metrics.latency.observe(p.last.candidate.latency_ms);
            }
            if (failed) metrics.errors.inc();
            if (mismatched) metrics.mismatches.inc();
          }
          progress?.update();
        };
  let adapter: Adapter | undefined;
  let bus: RedisStreamsBus | undefined;
  if (options.adapterModule !== undefined && options.adapter === 'bus') {
    throw new ConfigError('--adapter-module and --adapter bus are separate transports, use one');
  }
  if (options.adapterModule !== undefined || Object.keys(options.adapterSetting ?? []).length > 0) {
    adapter = await loadAdapterFromFlags(options, {
      target: options.target,
      timeoutMs: options.timeoutMs,
      connections: options.concurrency,
    });
  } else if (options.adapter === 'bus') {
    if (options.busUrl === undefined) throw new ConfigError('--adapter bus needs --bus-url');
    bus = await RedisStreamsBus.connect(options.busUrl, {
      group: options.busGroup,
      consumer: options.busConsumer,
    });
    adapter = await BusAdapter.create(bus, { timeoutMs: options.timeoutMs });
  } else if (customUpstream(upstream)) {
    adapter = new HttpAdapter(options.target, {
      ...upstream,
      timeoutMs: options.timeoutMs,
      connections: options.concurrency,
      maxBodyBytes: options.maxBodyBytes,
    });
  }
  try {
    const run = await replayExchanges(exchanges, {
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
      queryOverrides,
      barrierTags: options.barrierTag,
      barrierTimeoutMs: options.barrierTimeoutMs,
      candidateRecording: options.candidateRecording ?? null,
      invariants: options.invariants,
      timeoutMs: options.timeoutMs,
      maxBodyBytes: options.maxBodyBytes,
      log,
      traceId,
      onProgress,
      heartbeatMs: onProgress === undefined ? 0 : (options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS),
      signal,
    });
    if (progress !== undefined) endProgress(streams, progress);
    run.recording.recording_sha256 = recordingHash.sha256;
    await writeRun(options.out, run);
    if (run.filter.dependencies > 0) {
      log.info(
        `selected ${run.filter.dependencies} dependency exchange${run.filter.dependencies === 1 ? '' : 's'} that produce values the filtered exchanges use`,
        { dependencies: run.filter.dependencies },
      );
    }
    if (run.pacing.gaps_capped > 0) {
      log.info(
        `capped ${run.pacing.gaps_capped} recorded gap${run.pacing.gaps_capped === 1 ? '' : 's'} at ${run.pacing.max_gap_ms} ms`,
        { gaps_capped: run.pacing.gaps_capped, max_gap_ms: run.pacing.max_gap_ms },
      );
    }
    const aborted = run.inconclusive.find((c) => c.kind === 'aborted');
    if (aborted !== undefined) {
      log.warn(`replay ${aborted.detail}, writing the partial run`, { aborted: true });
    }
    if (!options.quiet) out(streams, renderTerminal(run));
    log.info(`wrote ${options.out}: ${run.verdict.toUpperCase()}`, {
      out: options.out,
      verdict: run.verdict,
      run_id: run.run_id,
    });
    return exitCodeFor(run.verdict);
  } finally {
    if (progress !== undefined && !progress.finished) endProgress(streams, progress);
    if (metricsServer !== undefined) await metricsServer.close();
    if (adapter?.close) await adapter.close();
    if (bus) await bus.close();
  }
}

export function replayCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
  context?: CliContext,
): Command {
  const command = new Command('replay')
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
    .option('--bus-group <name>', 'Redis consumer group the bus adapter reads replies through')
    .option('--bus-consumer <name>', 'consumer name within --bus-group, default a random name')
    .option(
      '--header <name: value>',
      'header applied to every request over the recorded value, repeatable',
      collect,
      [],
    )
    .option('--headers-file <path>', 'file with one "name: value" header per line')
    .option(
      '--query <name=value>',
      'query parameter applied to every request over the recorded value, repeatable',
      collectQuery,
      [],
    )
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
    .option(
      '--no-preflight',
      'skip the checks of the thresholds, rules, and barrier tags against the recording before sending',
    )
    .option('--preflight-probe', 'also probe the target before sending', false)
    .option(
      '--progress',
      'print a progress line to stderr every second or every --progress-every exchanges',
      false,
    )
    .addOption(
      new Option('--progress-every <n>', 'exchanges between progress lines')
        .default(DEFAULT_PROGRESS_EVERY)
        .argParser(positiveInt),
    )
    .addOption(
      new Option(
        '--heartbeat-ms <n>',
        'with --progress, print the line again after this long without one so a log shows the run is alive; 0 disables',
      )
        .default(DEFAULT_HEARTBEAT_MS)
        .argParser(nonNegativeInt),
    )
    .option(
      '--trace',
      'send a W3C traceparent header on every request, one trace id for the run and a span id per exchange; RP_TRACE=1 does the same',
      false,
    )
    .addOption(
      new Option(
        '--metrics-port <n>',
        'serve Prometheus metrics at /metrics on this port until the run ends; 0 picks a free port',
      ).argParser(portNumber),
    );
  addUpstreamOptions(command);
  addAdapterModuleOptions(command);
  return command.action(async (opts: ReplayCommandOptions, command: Command) => {
    exit(
      await runReplay(
        { ...opts, targetLabel: displayText(command, 'target', opts.target) },
        streams,
        signal,
        context?.env,
      ),
    );
  });
}

export function validateHeaderOptions(values: readonly string[]): void {
  for (const value of values) parseHeaderOption(value);
}
