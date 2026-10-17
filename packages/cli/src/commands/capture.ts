import { once } from 'node:events';
import { CaptureServer, parseTagRule } from '@replay-parity/capture';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_REDACTED_HEADERS } from '@replay-parity/core';
import { Command, Option } from 'commander';
import { err, type CliStreams } from '../io.js';
import {
  collect,
  fraction,
  nonNegativeInt,
  parseListen,
  positiveInt,
  type Listen,
} from '../options.js';

export interface CaptureCommandOptions {
  listen: Listen;
  target: string;
  out: string;
  tagRule: string[];
  sample: number;
  redactHeader: string[];
  maxBodyBytes: number;
  append: boolean;
  upstreamTimeoutMs: number;
}

/** Runs the capture proxy until `signal` aborts, then flushes and returns 0. */
export async function runCapture(
  options: CaptureCommandOptions,
  streams: CliStreams,
  signal: AbortSignal,
): Promise<number> {
  const capture = await CaptureServer.create({
    target: options.target,
    out: options.out,
    append: options.append,
    tagRules: options.tagRule.map(parseTagRule),
    sample: options.sample,
    redactHeaders:
      options.redactHeader.length === 0 ? DEFAULT_REDACTED_HEADERS : options.redactHeader,
    maxBodyBytes: options.maxBodyBytes,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    onError: (error, context) => err(streams, `capture: ${context}: ${String(error)}`),
  });
  const address = await capture.listen({ port: options.listen.port, host: options.listen.host });
  err(
    streams,
    `capturing on ${address.address}:${address.port} -> ${options.target}, writing ${options.out}`,
  );
  if (!signal.aborted) await once(signal, 'abort');
  await capture.close();
  const { seen, recorded, failed } = capture.stats;
  err(
    streams,
    `capture closed: ${seen} requests seen, ${recorded} recorded, ${failed} failed upstream`,
  );
  return 0;
}

export function captureCommand(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
): Command {
  return new Command('capture')
    .description(
      'Run the recording reverse proxy in front of the reference system until SIGINT or SIGTERM.',
    )
    .addOption(
      new Option('--listen <addr>', 'address to listen on, as [host]:port')
        .default({ host: '0.0.0.0', port: 8080 }, ':8080')
        .argParser(parseListen),
    )
    .requiredOption('--target <url>', 'base URL of the reference system to forward to')
    .requiredOption('--out <path>', 'recording file to append to')
    .option(
      '--tag-rule <rule>',
      'tag rule "[METHOD ]<glob>=<tag>", first match wins, repeatable',
      collect,
      [],
    )
    .addOption(
      new Option('--sample <fraction>', 'fraction of exchanges to record')
        .default(1)
        .argParser(fraction),
    )
    .option(
      '--redact-header <name>',
      'header to redact, repeatable, replaces the default list',
      collect,
      [],
    )
    .addOption(
      new Option('--max-body-bytes <n>', 'bodies above this size are stored as a hash')
        .default(DEFAULT_MAX_BODY_BYTES)
        .argParser(nonNegativeInt),
    )
    .option('--no-append', 'start a new recording file instead of appending')
    .addOption(
      new Option('--upstream-timeout-ms <n>', 'upstream headers and body timeout')
        .default(30_000)
        .argParser(positiveInt),
    )
    .action(async (opts: CaptureCommandOptions) => {
      exit(await runCapture(opts, streams, signal));
    });
}
