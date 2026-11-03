import { describe, expect, it } from 'vitest';
import { createProgress, formatDuration, type ProgressTimers } from './progress.js';

/** A clock and a timer queue under test control. */
function fakeTime(): {
  now: () => number;
  timers: ProgressTimers;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId;
        nextId += 1;
        queue.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(handle) {
        queue.delete(handle as number);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of queue) {
          if (entry.at <= target && entry.at < dueAt) {
            dueAt = entry.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const entry = queue.get(dueId) as { at: number; fn: () => void };
        queue.delete(dueId);
        now = entry.at;
        entry.fn();
      }
      now = target;
    },
    pending: () => queue.size,
  };
}

describe('createProgress', () => {
  it('prints every N units off a TTY, one line per print', () => {
    const time = fakeTime();
    const out: string[] = [];
    let done = 0;
    const progress = createProgress({
      render: () => `done ${done}`,
      write: (text) => out.push(text),
      tty: false,
      every: 3,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    for (let i = 0; i < 7; i += 1) {
      done += 1;
      progress.update();
    }
    expect(out).toEqual(['done 3\n', 'done 6\n']);
    expect(progress.count).toBe(7);
    expect(progress.lines).toBe(2);
    progress.finish();
    expect(out).toEqual(['done 3\n', 'done 6\n', 'done 7\n']);
    expect(progress.finished).toBe(true);
    progress.update();
    progress.finish();
    expect(out).toHaveLength(3);
  });

  it('prints at the next update once the interval has passed', () => {
    const time = fakeTime();
    const out: string[] = [];
    const progress = createProgress({
      render: () => `t ${time.now()}`,
      write: (text) => out.push(text),
      tty: false,
      every: 1000,
      intervalMs: 1000,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    progress.update();
    time.advance(999);
    progress.update();
    expect(out).toEqual([]);
    time.advance(1);
    progress.update();
    expect(out).toEqual(['t 1000\n']);
    time.advance(500);
    progress.update();
    expect(out).toEqual(['t 1000\n']);
  });

  it('counts a batch with advance', () => {
    const time = fakeTime();
    const out: string[] = [];
    const progress = createProgress({
      render: () => 'line',
      write: (text) => out.push(text),
      tty: false,
      every: 10,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    progress.advance(9);
    expect(out).toEqual([]);
    progress.advance(5);
    expect(out).toEqual(['line\n']);
    expect(progress.count).toBe(14);
  });

  it('redraws one line in place on a TTY and ends it on finish', () => {
    const time = fakeTime();
    let text = '';
    let n = 0;
    const progress = createProgress({
      render: () => `n ${n}`,
      write: (chunk) => {
        text += chunk;
      },
      tty: true,
      every: 1,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    n = 10;
    progress.update();
    n = 2;
    progress.update();
    expect(text).toBe('\rn 10\rn 2 ');
    progress.finish();
    expect(text).toBe('\rn 10\rn 2 \rn 2 \n');
  });

  it('ends the TTY line on interrupt so another writer can print, then draws it again', () => {
    const time = fakeTime();
    let text = '';
    const progress = createProgress({
      render: () => 'p',
      write: (chunk) => {
        text += chunk;
      },
      tty: true,
      every: 1,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    progress.interrupt();
    expect(text).toBe('');
    progress.update();
    progress.interrupt();
    progress.interrupt();
    text += 'log line\n';
    progress.update();
    expect(text).toBe('\rp\nlog line\n\rp');
  });

  it('prints a heartbeat after heartbeatMs without a line, off a TTY', () => {
    const time = fakeTime();
    const out: string[] = [];
    let done = 0;
    const progress = createProgress({
      render: () => `done ${done} at ${time.now()}`,
      write: (text) => out.push(text),
      tty: false,
      every: 100,
      intervalMs: 1000,
      heartbeatMs: 60_000,
      now: time.now,
      timers: time.timers,
    });
    time.advance(59_999);
    expect(out).toEqual([]);
    time.advance(1);
    expect(out).toEqual(['done 0 at 60000\n']);
    // A printed line restarts the wait.
    time.advance(30_000);
    done = 5;
    progress.update();
    expect(out).toHaveLength(2);
    time.advance(59_999);
    expect(out).toHaveLength(2);
    time.advance(1);
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('done 5 at 150000\n');
    progress.finish();
    expect(out).toHaveLength(4);
    expect(time.pending()).toBe(0);
    time.advance(120_000);
    expect(out).toHaveLength(4);
  });

  it('runs no heartbeat when heartbeatMs is 0', () => {
    const time = fakeTime();
    const out: string[] = [];
    createProgress({
      render: () => 'x',
      write: (text) => out.push(text),
      tty: false,
      heartbeatMs: 0,
      now: time.now,
      timers: time.timers,
    });
    expect(time.pending()).toBe(0);
    time.advance(600_000);
    expect(out).toEqual([]);
  });

  it('uses the defaults of 100 units, one second, and one minute', () => {
    const time = fakeTime();
    const out: string[] = [];
    const progress = createProgress({
      render: () => 'x',
      write: (text) => out.push(text),
      tty: false,
      now: time.now,
      timers: time.timers,
    });
    progress.advance(99);
    expect(out).toEqual([]);
    progress.advance(1);
    expect(out).toHaveLength(1);
    time.advance(1000);
    progress.update();
    expect(out).toHaveLength(2);
    time.advance(60_000);
    expect(out).toHaveLength(3);
  });

  it('rejects a bad every, interval, or heartbeat', () => {
    const base = { render: () => '', write: () => undefined, tty: false };
    expect(() => createProgress({ ...base, every: 0 })).toThrow(RangeError);
    expect(() => createProgress({ ...base, every: 1.5 })).toThrow(RangeError);
    expect(() => createProgress({ ...base, intervalMs: -1 })).toThrow(RangeError);
    expect(() => createProgress({ ...base, heartbeatMs: Number.NaN })).toThrow(RangeError);
  });

  it('works with the real timers and never keeps the process alive', () => {
    const out: string[] = [];
    const progress = createProgress({
      render: () => 'real',
      write: (text) => out.push(text),
      tty: false,
      every: 1,
      heartbeatMs: 60_000,
    });
    progress.update();
    progress.finish();
    expect(out).toEqual(['real\n', 'real\n']);
  });
});

describe('formatDuration', () => {
  it('prints seconds, minutes, and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(499)).toBe('0s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatDuration(-5)).toBe('0s');
  });
});
