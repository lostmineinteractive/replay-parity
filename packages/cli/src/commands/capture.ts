import { once } from 'node:events';
import {
  CaptureServer,
  parseTagRule,
  type CaptureEndReason,
  type CaptureStats,
} from '@replay-parity/capture';
import {
  DEFAULT_HEARTBEAT_MS,
  ConfigError,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PROGRESS_EVERY,
  DEFAULT_REDACTED_HEADERS,
  DEFAULT_REDACTED_QUERY,
  REDACTION_KEY_ENV,
  formatDuration,
  loadCaptureRules,
} from '@replay-parity/core';
import { Command, Option } from 'commander';
import { endProgress, logger, startProgress, type CliStreams } from '../io.js';
import { addUpstreamOptions, readPem, resolveUpstream, type UpstreamFlags } from '../upstream.js';
import {
  collect,
  fraction,
  nonNegativeInt,
  parseListen,
  positiveInt,
  type Listen,
} from '../options.js';

export interface CaptureCommandOptions extends UpstreamFlags {
  tlsCert?: string;
  tlsKey?: string;
  listen: Listen;
  target: string;
  out: string;
  tagRule: string[];
  sample: number;
  sampleBy?: string;
  sampleSeed?: number;
  redactHeader: string[];
  redactQuery: string[];
  maxBodyBytes: number;
  append: boolean;
  upstreamTimeoutMs: number;
  /** Print a progress line to stderr. Default false. */
  progress?: boolean;
  /** Requests between progress lines, besides one every second. Default 100. */
  progressEvery?: number;
  /** With `--progress`, print the line again after this long without one. 0 disables. Default 60000. */
  heartbeatMs?: number;
  rotateBytes?: number;
  rotateInterval?: number;
  gzip?: boolean;
  maxExchanges?: number;
  duration?: number;
  /** The version written in the manifest of a new file. Default 0.0.0. */
  toolVersion?: string;
  captureRules?: string;
  /** The environment `RP_REDACTION_KEY` is read from. Default: the process environment. */
  env?: NodeJS.ProcessEnv;
}

/** How often the progress reads the server's counters. */
export const CAPTURE_POLL_MS = 250;

export function formatCaptureProgress(stats: CaptureStats, elapsedMs: number): string {
  return `capture seen ${stats.seen} recorded ${stats.recorded} failed ${stats.failed} elapsed ${formatDuration(elapsedMs)}`;
}

/**
 * Runs the capture proxy until `signal` aborts or the capture reaches
 * `--max-exchanges` or `--duration`, then flushes and returns 0.
 */
export async function runCapture(
  options: CaptureCommandOptions,
  streams: CliStreams,
  signal: AbortSignal,
): Promise<number> {
  const log = logger(streams);
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw new ConfigError('--tls-cert and --tls-key are used together');
  }
  const { tls: upstream } = await resolveUpstream(options);
  const captureRules =
    options.captureRules === undefined ? undefined : await loadCaptureRules(options.captureRules);
  const listenTls =
    options.tlsCert === undefined || options.tlsKey === undefined
      ? undefined
      : {
          cert: await readPem('--tls-cert', options.tlsCert),
          key: await readPem('--tls-key', options.tlsKey),
        };
  const capture = await CaptureServer.create({
    tls: listenTls,
    upstream,
    target: options.target,
    out: options.out,
    append: options.append,
    tagRules: options.tagRule.map(parseTagRule),
    sample: options.sample,
    sampleBy: options.sampleBy,
    sampleSeed: options.sampleSeed,
    redactHeaders:
      options.redactHeader.length === 0 ? DEFAULT_REDACTED_HEADERS : options.redactHeader,
    redactQuery: options.redactQuery.length === 0 ? DEFAULT_REDACTED_QUERY : options.redactQuery,
    maxBodyBytes: options.maxBodyBytes,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    toolVersion: options.toolVersion ?? '0.0.0',
    captureRules,
    redactionKey: (options.env ?? process.env)[REDACTION_KEY_ENV],
    rotateBytes: options.rotateBytes,
    rotateIntervalMs: options.rotateInterval,
    gzip: options.gzip === true ? true : undefined,
    maxExchanges: options.maxExchanges,
    durationMs: options.duration,
    onError: (error, context) =>
      log.error(`capture: ${context}: ${String(error)}`, { context, error: String(error) }),
  });
  if (options.sample < 1 && options.sampleBy === undefined) {
    log.warn(
      `warning: --sample ${options.sample} without --sample-by samples each request on its own, so a create can be kept while the reads that use its id are dropped and substitution chains may break`,
      { sample: options.sample },
    );
  }
  if (capture.sampleSeed !== null) {
    log.info(
      `sampling sessions by ${options.sampleBy ?? ''} at ${options.sample} with seed ${capture.sampleSeed}`,
      { sample_by: options.sampleBy, sample: options.sample, seed: capture.sampleSeed },
    );
  }
  const address = await capture.listen({ port: options.listen.port, host: options.listen.host });
  log.info(
    `capturing on ${address.address}:${address.port} -> ${options.target}, writing ${options.out}`,
    { address: address.address, port: address.port, out: options.out },
  );
  const startedAt = Date.now();
  const progress =
    options.progress === true
      ? startProgress(streams, {
          every: options.progressEvery ?? DEFAULT_PROGRESS_EVERY,
          heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
          render: () => formatCaptureProgress(capture.stats, Date.now() - startedAt),
          fields: () => ({ ...capture.stats, elapsed_ms: Date.now() - startedAt }),
        })
      : undefined;
  // The server has no per request hook, so the progress reads its counters on a timer.
  let polled = 0;
  const sync = (): void => {
    const { seen } = capture.stats;
    if (seen > polled) {
      progress?.advance(seen - polled);
      polled = seen;
    }
  };
  const poll = progress === undefined ? undefined : setInterval(sync, CAPTURE_POLL_MS);
  poll?.unref();
  let reason: CaptureEndReason | 'signal' = 'signal';
  if (!signal.aborted) {
    const aborted = once(signal, 'abort').then(() => 'signal' as const);
    reason = await Promise.race([aborted, capture.ended]);
  }
  if (reason === 'max-exchanges') {
    log.info(`capture reached --max-exchanges ${options.maxExchanges ?? ''}, closing`, { reason });
  } else if (reason === 'duration') {
    log.info(`capture reached --duration ${options.duration ?? ''} ms, closing`, { reason });
  }
  if (poll !== undefined) clearInterval(poll);
  await capture.close();
  if (progress !== undefined) {
    sync();
    endProgress(streams, progress);
  }
  const { seen, recorded, failed } = capture.stats;
  const files = capture.files;
  if (files.length > 1 || files[0] !== options.out) {
    log.info(`wrote ${files.length} part${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, {
      files,
    });
  }
  log.info(
    `capture closed: ${seen} requests seen, ${recorded} recorded, ${failed} failed upstream`,
    { seen, recorded, failed },
  );
  return 0;
}

export function captureCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
  version = '0.0.0',
  env: NodeJS.ProcessEnv = process.env,
): Command {
  const command = new Command('capture')
    .description(
      'Run the recording reverse proxy in front of the reference system until SIGINT, SIGTERM, --max-exchanges, or --duration.',
    )
    .addOption(
      new Option('--listen <addr>', 'address to listen on, as [host]:port')
        .default({ host: '0.0.0.0', port: 8080 }, ':8080')
        .argParser(parseListen),
    )
    .requiredOption('--target <url>', 'base URL of the reference system to forward to')
    .requiredOption(
      '--out <path>',
      'recording file to append to; with rotation or --gzip, the stem of the numbered parts',
    )
    .option(
      '--tag-rule <rule>',
      'tag rule "[METHOD ]<glob>=<tag>", first match wins, repeatable',
      collect,
      [],
    )
    .addOption(
      new Option(
        '--sample <fraction>',
        'fraction of exchanges, or of sessions with --sample-by, to record',
      )
        .default(1)
        .argParser(fraction),
    )
    .option(
      '--sample-by <selector>',
      'keep or drop whole sessions by header:<name>, cookie:<name>, or a request body JSONPath; requests without a session value are sampled one by one',
    )
    .addOption(
      new Option(
        '--sample-seed <n>',
        'seed of the session hash for a repeatable sample; default: random, logged and written in the manifest',
      ).argParser(nonNegativeInt),
    )
    .option(
      '--redact-header <name>',
      'header to redact, repeatable, replaces the default list',
      collect,
      [],
    )
    .option(
      '--redact-query <name>',
      'query parameter to redact, repeatable, replaces the default list',
      collect,
      [],
    )
    .addOption(
      new Option('--max-body-bytes <n>', 'bodies above this size are stored as a hash')
        .default(DEFAULT_MAX_BODY_BYTES)
        .argParser(nonNegativeInt),
    )
    .option(
      '--capture-rules <path>',
      'YAML capture rules with redact.body, redact.query, and redact.headers, each in drop or hash mode; hash needs RP_REDACTION_KEY',
    )
    .option('--no-append', 'start a new recording file instead of appending')
    .addOption(
      new Option(
        '--rotate-bytes <n>',
        'write numbered parts, starting a new one once a part holds this many bytes before compression',
      ).argParser(positiveInt),
    )
    .addOption(
      new Option(
        '--rotate-interval <ms>',
        'write numbered parts, starting a new one once an exchange arrives this long after the first of its part',
      ).argParser(positiveInt),
    )
    .option('--gzip', 'write numbered gzip parts, <stem>.0001.jsonl.gz')
    .addOption(
      new Option(
        '--max-exchanges <n>',
        'end the capture after recording this many exchanges, closing as on a signal',
      ).argParser(positiveInt),
    )
    .addOption(
      new Option(
        '--duration <ms>',
        'end the capture this long after it starts listening, closing as on a signal',
      ).argParser(positiveInt),
    )
    .addOption(
      new Option('--upstream-timeout-ms <n>', 'upstream headers and body timeout')
        .default(30_000)
        .argParser(positiveInt),
    )
    .option(
      '--progress',
      'print a progress line to stderr every second or every --progress-every requests',
      false,
    )
    .addOption(
      new Option('--progress-every <n>', 'requests between progress lines')
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
    )
    .option('--tls-cert <path>', 'PEM certificate to listen over HTTPS with')
    .option('--tls-key <path>', 'PEM private key for --tls-cert');
  addUpstreamOptions(command, false);
  return command.action(async (opts: CaptureCommandOptions) => {
    exit(await runCapture({ ...opts, toolVersion: version, env }, streams, signal));
  });
}
