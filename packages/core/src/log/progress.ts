/**
 * Throttled progress lines. A command counts units of work with `update` or
 * `advance` and the line is printed every `every` units or every
 * `intervalMs`, whichever comes first, from a `render` function that reads
 * the command's live state. On a TTY the line is drawn again in place with a
 * carriage return. Off a TTY every print is a new line, and a heartbeat
 * prints the line again after `heartbeatMs` without one, so a CI log shows
 * the job is alive during a long wait. The clock and the timers are
 * injectable for tests.
 */

export interface ProgressTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProgressOptions {
  /** Produces the line. Called only when a line is printed. */
  render: () => string;
  /** Receives the text to write, with the carriage return or the newline included. */
  write: (text: string) => void;
  /** True to redraw one line in place, false to add a line per print. */
  tty: boolean;
  /** Units between prints. Default 100. */
  every?: number | undefined;
  /** Print at the next update when this long has passed since the last line. Default 1000. */
  intervalMs?: number | undefined;
  /** Print the line again after this long without one. 0 disables. Default 60000. */
  heartbeatMs?: number | undefined;
  /** The clock in milliseconds. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** The timers the heartbeat uses. Default: the global timers, unreferenced. */
  timers?: ProgressTimers | undefined;
}

export interface Progress {
  /** Counts one unit of work. */
  update(): void;
  /** Counts `n` units at once, the way a poll of a counter reports a batch. */
  advance(n: number): void;
  /** Ends the line shown on a TTY so another writer can print. The next print draws it again. */
  interrupt(): void;
  /** Prints the line one last time, ends the TTY line, and stops the heartbeat. */
  finish(): void;
  /** Units counted so far. */
  readonly count: number;
  /** Lines printed so far, heartbeats included. */
  readonly lines: number;
  readonly finished: boolean;
}

export const DEFAULT_PROGRESS_EVERY = 100;
export const DEFAULT_PROGRESS_INTERVAL_MS = 1000;
export const DEFAULT_HEARTBEAT_MS = 60_000;

const realTimers: ProgressTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export function createProgress(options: ProgressOptions): Progress {
  const every = options.every ?? DEFAULT_PROGRESS_EVERY;
  const intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isInteger(every) || every < 1) {
    throw new RangeError(`every must be a positive integer, got ${String(every)}`);
  }
  if (!(Number.isFinite(intervalMs) && intervalMs >= 0)) {
    throw new RangeError(`intervalMs must be a non negative number, got ${String(intervalMs)}`);
  }
  if (!(Number.isFinite(heartbeatMs) && heartbeatMs >= 0)) {
    throw new RangeError(`heartbeatMs must be a non negative number, got ${String(heartbeatMs)}`);
  }
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;

  let count = 0;
  let lines = 0;
  let printedCount = 0;
  let printedAt = now();
  let widest = 0;
  let open = false;
  let finished = false;
  let timer: unknown = null;

  const clear = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    clear();
    if (heartbeatMs > 0 && !finished) timer = timers.setTimeout(heartbeat, heartbeatMs);
  };
  const print = (): void => {
    const text = options.render();
    if (options.tty) {
      // The padding clears what a longer earlier line left behind the cursor.
      const pad = ' '.repeat(Math.max(0, widest - text.length));
      widest = Math.max(widest, text.length);
      options.write(`\r${text}${pad}`);
      open = true;
    } else {
      options.write(`${text}\n`);
    }
    lines += 1;
    printedCount = count;
    printedAt = now();
    schedule();
  };
  const heartbeat = (): void => {
    timer = null;
    if (!finished) print();
  };
  const advance = (n: number): void => {
    if (finished) return;
    count += n;
    if (count - printedCount >= every || now() - printedAt >= intervalMs) print();
  };
  const interrupt = (): void => {
    if (!open) return;
    options.write('\n');
    open = false;
  };

  schedule();
  return {
    update(): void {
      advance(1);
    },
    advance,
    interrupt,
    finish(): void {
      if (finished) return;
      finished = true;
      clear();
      print();
      interrupt();
    },
    get count(): number {
      return count;
    },
    get lines(): number {
      return lines;
    },
    get finished(): boolean {
      return finished;
    },
  };
}

/** `12s`, `1m 05s`, or `1h 02m`, for an elapsed or remaining time. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
