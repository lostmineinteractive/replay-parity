import { makeExchangeResult, makeRun, type ExchangeResult } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  formatRule,
  latencyBreached,
  latencySamples,
  parseRule,
  reproduces,
  witnessOf,
  type ShrinkRule,
} from './rule.js';

type LatencyRule = Extract<ShrinkRule, { kind: 'latency' }>;

const result = (id: string, tags: string[], ms: number, over: Partial<ExchangeResult> = {}) =>
  makeExchangeResult({ id, tags, candidate: { status: 200, latency_ms: ms }, ...over });

describe('latency rules', () => {
  it('parse and format as latency:<tag>:<metric>', () => {
    expect(parseRule('latency:slow:p99')).toEqual({ kind: 'latency', tag: 'slow', metric: 'p99' });
    expect(formatRule(parseRule('latency:get-order:max'))).toBe('latency:get-order:max');
    // A tag may hold a colon because the metric is the last part.
    expect(parseRule('latency:a:b:p50')).toEqual({ kind: 'latency', tag: 'a:b', metric: 'p50' });
    expect(formatRule({ kind: 'latency', tag: 'x', metric: 'p90', limitMs: 5 })).toBe(
      'latency:x:p90',
    );
  });

  it('refuse a missing tag, an unknown metric, and p999', () => {
    for (const text of [
      'latency',
      'latency:slow',
      'latency::p99',
      'latency:slow:p999',
      'latency:slow:mean',
    ]) {
      expect(() => parseRule(text), text).toThrow(/expected latency:<tag>:<p50\|p90\|p99\|max>/);
    }
  });

  it('have no witness exchange', () => {
    expect(witnessOf({ kind: 'latency', tag: 'slow', metric: 'max' })).toBeUndefined();
  });

  it('take the candidate latency of the successful exchanges that carry the tag', () => {
    const run = makeRun({
      exchanges: [
        result('a', ['slow'], 30),
        result('b', ['slow', 'other'], 50),
        result('c', ['fast'], 5),
        result('d', ['slow'], 900, { warmup: true }),
        result('e', ['slow'], 900, { control: true }),
        result('f', ['slow'], 900, { dependency: true }),
        result('g', ['slow'], 900, { candidate: null, error: 'timeout', diff: null }),
      ],
    });
    expect(latencySamples(run, 'slow')).toEqual([30, 50]);
    expect(latencySamples(run, 'other')).toEqual([50]);
    expect(latencySamples(run, 'none')).toEqual([]);
  });

  it('breach when the named percentile of the sample is over the limit', () => {
    const rule = (over: Partial<LatencyRule>): LatencyRule => ({
      kind: 'latency',
      tag: 'slow',
      metric: 'p50',
      limitMs: 100,
      ...over,
    });
    const samples = [10, 20, 30, 40, 500];
    expect(latencyBreached(samples, rule({ metric: 'p50' }))).toBe(false);
    expect(latencyBreached(samples, rule({ metric: 'p90' }))).toBe(true);
    expect(latencyBreached(samples, rule({ metric: 'max' }))).toBe(true);
    expect(latencyBreached(samples, rule({ metric: 'max', limitMs: 500 }))).toBe(false);
    // No sample, no limit, or too few samples never breach.
    expect(latencyBreached([], rule({}))).toBe(false);
    expect(latencyBreached(samples, rule({ limitMs: undefined }))).toBe(false);
    expect(latencyBreached(samples, rule({ metric: 'max', minSamples: 6 }))).toBe(false);
  });

  it('reproduce from one run through reproduces', () => {
    const run = makeRun({ exchanges: [result('a', ['slow'], 300)] });
    const rule: LatencyRule = { kind: 'latency', tag: 'slow', metric: 'max', limitMs: 100 };
    expect(reproduces(run, rule)).toBe(true);
    expect(reproduces(run, { ...rule, limitMs: 400 })).toBe(false);
    expect(reproduces(run, { kind: 'latency', tag: 'slow', metric: 'max' })).toBe(false);
  });
});
