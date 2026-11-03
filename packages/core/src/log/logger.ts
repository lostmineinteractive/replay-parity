/**
 * A small structured logger. Every package takes it through the `Logger`
 * interface, so a library user routes the lines wherever they want and the
 * CLI builds one from its flags. The text format writes the message alone,
 * which is the line the commands printed before the logger existed. The JSON
 * format writes one object per line with the time, the level, the message,
 * and the fields bound to the logger or given with the call.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export type LogFields = Record<string, unknown>;

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
export const LOG_FORMATS: readonly LogFormat[] = ['text', 'json'];
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_LOG_FORMAT: LogFormat = 'text';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys the JSON line sets itself. A field with one of these names is dropped. */
const RESERVED = new Set(['ts', 'level', 'msg']);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogFormat(value: unknown): value is LogFormat {
  return typeof value === 'string' && (LOG_FORMATS as readonly string[]).includes(value);
}

export interface Logger {
  /** The least level that is written. */
  readonly level: LogLevel;
  readonly format: LogFormat;
  /** True when a line at `level` would be written. */
  enabled(level: LogLevel): boolean;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Default `info`. */
  level?: LogLevel | undefined;
  /** Default `text`. */
  format?: LogFormat | undefined;
  /** Receives every line with its trailing newline. Default: standard error. */
  sink?: ((line: string) => void) | undefined;
  /** The clock for `ts`. Default: the system clock. */
  now?: (() => Date) | undefined;
  /** Fields bound to every line. */
  fields?: LogFields | undefined;
}

/** A value as it is written in a JSON line. An Error keeps its name and message, nothing else. */
function plain(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** The text form of a message: the message itself, ended with one newline. */
export function textLine(msg: string): string {
  return msg.endsWith('\n') ? msg : `${msg}\n`;
}

/** The JSON form: `ts`, `level`, `msg`, then the fields, one object on one line. */
export function jsonLine(ts: Date, level: LogLevel, msg: string, fields: LogFields): string {
  const record: Record<string, unknown> = {
    ts: ts.toISOString(),
    level,
    msg: msg.endsWith('\n') ? msg.slice(0, -1) : msg,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED.has(key) || value === undefined) continue;
    record[key] = plain(value);
  }
  try {
    return `${JSON.stringify(record)}\n`;
  } catch (e) {
    // A field that cannot be serialized, such as a cycle, must not lose the line.
    const fallback = {
      ts: record.ts,
      level,
      msg: record.msg,
      log_error: `fields could not be serialized: ${(e as Error).message}`,
    };
    return `${JSON.stringify(fallback)}\n`;
  }
}

class StructuredLogger implements Logger {
  constructor(
    readonly level: LogLevel,
    readonly format: LogFormat,
    private readonly sink: (line: string) => void,
    private readonly now: () => Date,
    private readonly bound: LogFields,
  ) {}

  enabled(level: LogLevel): boolean {
    return RANK[level] >= RANK[this.level];
  }

  private write(level: LogLevel, msg: string, fields: LogFields): void {
    if (!this.enabled(level)) return;
    if (this.format === 'text') {
      this.sink(textLine(msg));
      return;
    }
    this.sink(jsonLine(this.now(), level, msg, { ...this.bound, ...fields }));
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields: LogFields = {}): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.write('error', msg, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.level, this.format, this.sink, this.now, {
      ...this.bound,
      ...fields,
    });
  }
}

class NoopLogger implements Logger {
  readonly level: LogLevel = 'error';
  readonly format: LogFormat = 'text';

  enabled(): boolean {
    return false;
  }

  debug(): void {
    return undefined;
  }

  info(): void {
    return undefined;
  }

  warn(): void {
    return undefined;
  }

  error(): void {
    return undefined;
  }

  child(): Logger {
    return this;
  }
}

/** A logger that writes nothing. The default wherever a `Logger` is optional. */
export const noopLogger: Logger = new NoopLogger();

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(
    options.level ?? DEFAULT_LOG_LEVEL,
    options.format ?? DEFAULT_LOG_FORMAT,
    options.sink ??
      ((line: string): void => {
        process.stderr.write(line);
      }),
    options.now ?? ((): Date => new Date()),
    { ...options.fields },
  );
}
