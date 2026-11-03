import { describe, expect, it } from 'vitest';
import {
  createLogger,
  isLogFormat,
  isLogLevel,
  jsonLine,
  noopLogger,
  textLine,
  type LogLevel,
} from './logger.js';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

const FIXED = new Date('2026-10-27T12:00:00.000Z');

describe('createLogger', () => {
  it('writes the message alone in the text format, ended with one newline', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink });
    log.info('wrote run.json: PASS');
    log.warn('capped 2 recorded gaps at 30000 ms\n');
    log.error('capture: GET /x: Error: refused', { context: 'GET /x' });
    expect(lines).toEqual([
      'wrote run.json: PASS\n',
      'capped 2 recorded gaps at 30000 ms\n',
      'capture: GET /x: Error: refused\n',
    ]);
  });

  it('drops lines under the level and keeps the rest', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toEqual(['w\n', 'e\n']);
    expect(log.enabled('info')).toBe(false);
    expect(log.enabled('warn')).toBe(true);
    expect(log.level).toBe('warn');
    expect(log.format).toBe('text');
  });

  it('writes one JSON object per line with ts, level, msg, and the fields', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: 'json', now: () => FIXED });
    log.info('wrote run.json: PASS', { path: 'run.json', verdict: 'pass' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: '2026-10-27T12:00:00.000Z',
      level: 'info',
      msg: 'wrote run.json: PASS',
      path: 'run.json',
      verdict: 'pass',
    });
    expect(Object.keys(JSON.parse(lines[0] as string) as object)).toEqual([
      'ts',
      'level',
      'msg',
      'path',
      'verdict',
    ]);
  });

  it('binds child fields before the call fields and lets the call override', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: 'json', now: () => FIXED }).child({
      command: 'replay',
      run: 'a',
    });
    log.child({ trace_id: 'abc' }).warn('slow', { run: 'b' });
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: '2026-10-27T12:00:00.000Z',
      level: 'warn',
      msg: 'slow',
      command: 'replay',
      run: 'b',
      trace_id: 'abc',
    });
  });

  it('keeps the child level and format', () => {
    const { lines, sink } = capture();
    const child = createLogger({ sink, format: 'json', level: 'error' }).child({ a: 1 });
    child.info('hidden');
    child.error('shown');
    expect(child.level).toBe('error');
    expect(child.format).toBe('json');
    expect(lines).toHaveLength(1);
  });

  it('never lets a field replace ts, level, or msg, and drops undefined fields', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: 'json', now: () => FIXED });
    log.info('m', { ts: 'x', level: 'debug', msg: 'y', gone: undefined, kept: 0 });
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: '2026-10-27T12:00:00.000Z',
      level: 'info',
      msg: 'm',
      kept: 0,
    });
  });

  it('writes an Error as its name and message and a bigint as text', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: 'json', now: () => FIXED });
    log.error('failed', { error: new TypeError('bad'), n: 10n });
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      error: { name: 'TypeError', message: 'bad' },
      n: '10',
    });
  });

  it('keeps the line when a field cannot be serialized', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const line = JSON.parse(jsonLine(FIXED, 'info', 'm', { cycle })) as Record<string, unknown>;
    expect(line.msg).toBe('m');
    expect(String(line.log_error)).toContain('fields could not be serialized');
  });

  it('strips one trailing newline from a JSON message', () => {
    expect(JSON.parse(jsonLine(FIXED, 'info', 'done\n', {}))).toMatchObject({ msg: 'done' });
    expect(textLine('done')).toBe('done\n');
    expect(textLine('done\n')).toBe('done\n');
  });

  it('defaults to info and text', () => {
    const log = createLogger();
    expect(log.level).toBe('info');
    expect(log.format).toBe('text');
    expect(log.enabled('debug')).toBe(false);
  });
});

describe('noopLogger', () => {
  it('writes nothing, is never enabled, and is its own child', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[]) {
      expect(noopLogger.enabled(level)).toBe(false);
      noopLogger[level]('ignored', { a: 1 });
    }
    expect(noopLogger.child({ a: 1 })).toBe(noopLogger);
  });
});

describe('level and format guards', () => {
  it('accept the known names only', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('loud')).toBe(false);
    expect(isLogLevel(1)).toBe(false);
    expect(isLogFormat('json')).toBe(true);
    expect(isLogFormat('xml')).toBe(false);
  });
});
