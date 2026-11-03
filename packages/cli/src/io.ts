import type { Writable } from 'node:stream';
import {
  ConfigError,
  DEFAULT_LOG_FORMAT,
  DEFAULT_LOG_LEVEL,
  LOG_FORMATS,
  LOG_LEVELS,
  createLogger,
  createProgress,
  isLogFormat,
  isLogLevel,
  type LogFields,
  type LogFormat,
  type LogLevel,
  type Logger,
  type Progress,
} from '@replay-parity/core';

/** Where a command writes. Tests pass buffers; the binary passes the process streams. */
export interface CliStreams {
  stdout: Writable;
  stderr: Writable;
  /** The logger every stderr line goes through. `runCli` builds it from the flags; default text at info. */
  log?: Logger | undefined;
  /** The progress line being shown, so a log line can end it first on a TTY. */
  progress?: Progress | undefined;
}

export function out(streams: CliStreams, text: string): void {
  streams.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Writes a line to stderr through the logger at `info`, which in the text format is the line itself. */
export function err(streams: CliStreams, text: string): void {
  logger(streams).info(text);
}

/** Writes raw text to stderr, ending the progress line first when one is open on a TTY. */
export function writeErr(streams: CliStreams, text: string): void {
  streams.progress?.interrupt();
  streams.stderr.write(text);
}

/** The logger of `streams`, created as text at info over stderr when none was built. */
export function logger(streams: CliStreams): Logger {
  streams.log ??= createLogger({ sink: (line) => writeErr(streams, line) });
  return streams.log;
}

export function isTty(stream: Writable): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

export const LOG_LEVEL_ENV = 'RP_LOG_LEVEL';
export const LOG_FORMAT_ENV = 'RP_LOG_FORMAT';

export interface LogSettings {
  level: LogLevel;
  format: LogFormat;
}

interface Found {
  value: string;
  from: string;
}

/**
 * `--log-level` and `--log-format` from the raw arguments, else `RP_LOG_LEVEL`
 * and `RP_LOG_FORMAT`, else info and text. Read before commander parses, so
 * the logger exists for every line, a configuration error included. Both
 * `--flag value` and `--flag=value` are read and the last occurrence wins.
 */
export function scanLogFlags(args: readonly string[], env: NodeJS.ProcessEnv): LogSettings {
  const found: Record<'log-level' | 'log-format', Found | undefined> = {
    'log-level': undefined,
    'log-format': undefined,
  };
  for (const name of ['log-level', 'log-format'] as const) {
    const variable = name === 'log-level' ? LOG_LEVEL_ENV : LOG_FORMAT_ENV;
    const text = env[variable];
    if (text !== undefined && text.length > 0) found[name] = { value: text, from: variable };
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    for (const name of ['log-level', 'log-format'] as const) {
      const flag = `--${name}`;
      let value: string | undefined;
      if (arg === flag) value = args[i + 1];
      else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      if (value !== undefined && !(arg === flag && value.startsWith('-'))) {
        found[name] = { value, from: flag };
      }
    }
  }
  const level = found['log-level'];
  const format = found['log-format'];
  if (level !== undefined && !isLogLevel(level.value)) {
    throw new ConfigError(
      `${level.from}: expected one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(level.value)}`,
    );
  }
  if (format !== undefined && !isLogFormat(format.value)) {
    throw new ConfigError(
      `${format.from}: expected one of ${LOG_FORMATS.join(', ')}, got ${JSON.stringify(format.value)}`,
    );
  }
  return {
    level: level === undefined ? DEFAULT_LOG_LEVEL : (level.value as LogLevel),
    format: format === undefined ? DEFAULT_LOG_FORMAT : (format.value as LogFormat),
  };
}

/** A logger over `streams.stderr` with the given settings. `runCli` installs it on the streams. */
export function cliLogger(streams: CliStreams, settings: LogSettings): Logger {
  return createLogger({
    level: settings.level,
    format: settings.format,
    sink: (line) => writeErr(streams, line),
  });
}

export interface CliProgressOptions {
  every: number;
  heartbeatMs: number;
  intervalMs?: number | undefined;
  render: () => string;
  /** The structured form of the line, added to the record when the logger writes JSON. */
  fields: () => LogFields;
}

/**
 * Starts a progress line on stderr. In the text format it is drawn in place
 * on a TTY and added as a line otherwise. In the JSON format every print is
 * an info record carrying `progress: true` and the fields, so a collector
 * never sees a bare line.
 */
export function startProgress(streams: CliStreams, options: CliProgressOptions): Progress {
  const log = logger(streams);
  const json = log.format === 'json';
  const progress = createProgress({
    render: options.render,
    every: options.every,
    intervalMs: options.intervalMs,
    heartbeatMs: options.heartbeatMs,
    tty: !json && isTty(streams.stderr),
    write: json
      ? (text): void => {
          log.info(text.trimEnd(), { progress: true, ...options.fields() });
        }
      : (text): void => {
          streams.stderr.write(text);
        },
  });
  streams.progress = progress;
  return progress;
}

/** Prints the final line, ends the TTY line, and releases the slot on the streams. */
export function endProgress(streams: CliStreams, progress: Progress): void {
  progress.finish();
  if (streams.progress === progress) streams.progress = undefined;
}
