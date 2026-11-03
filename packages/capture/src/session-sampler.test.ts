import { ConfigError, bucketOf } from '@replay-parity/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SessionSampler, cookieValue, parseSessionSelector } from './session-sampler.js';

describe('parseSessionSelector', () => {
  it('reads header, cookie, and body selectors', () => {
    expect(parseSessionSelector('header:X-Session')).toMatchObject({
      kind: 'header',
      name: 'x-session',
      text: 'header:x-session',
    });
    expect(parseSessionSelector('Cookie:sid')).toMatchObject({
      kind: 'cookie',
      name: 'sid',
      text: 'cookie:sid',
    });
    expect(parseSessionSelector('$.session.id')).toMatchObject({
      kind: 'body',
      text: '$.session.id',
    });
  });

  it('refuses an unknown form, an empty name, and a body path with a wildcard', () => {
    expect(() => parseSessionSelector('x-session')).toThrow(ConfigError);
    expect(() => parseSessionSelector('header:')).toThrow(ConfigError);
    expect(() => parseSessionSelector('$.items[*].id')).toThrow(/names one value/);
    expect(() => parseSessionSelector('$..[')).toThrow(ConfigError);
  });
});

describe('cookieValue', () => {
  it('finds a cookie among several and returns null when absent', () => {
    expect(cookieValue('a=1; sid=abc; b=2', 'sid')).toBe('abc');
    expect(cookieValue('sid=x=y', 'sid')).toBe('x=y');
    expect(cookieValue('a=1; flag', 'sid')).toBeNull();
    expect(cookieValue(undefined, 'sid')).toBeNull();
  });
});

describe('SessionSampler', () => {
  const draws = (values: number[]): (() => number) => {
    let i = 0;
    return () => values[i++ % values.length] as number;
  };

  it('gives every request of a session the same answer, the one bucketOf gives', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.string({ minLength: 1 }),
        (seed, fraction, session) => {
          const sampler = new SessionSampler({
            fraction,
            seed,
            selector: parseSessionSelector('header:x-session'),
            random: () => {
              throw new Error('a request with a session never draws');
            },
          });
          const first = sampler.fromHeaders({ 'x-session': session });
          expect(sampler.fromHeaders({ 'x-session': session })).toBe(first);
          expect(first).toBe(bucketOf(seed, session) < fraction);
        },
      ),
    );
  });

  it('falls back to a draw of its own for a request without a session value', () => {
    const sampler = new SessionSampler({
      fraction: 0.5,
      seed: 1,
      selector: parseSessionSelector('cookie:sid'),
      random: draws([0.1, 0.9]),
    });
    expect(sampler.fromHeaders({})).toBe(true);
    expect(sampler.fromHeaders({ cookie: 'other=1' })).toBe(false);
  });

  it('waits for the body with a body selector and reads strings and numbers', () => {
    const sampler = new SessionSampler({
      fraction: 0.5,
      seed: 3,
      selector: parseSessionSelector('$.session'),
      random: draws([0.9]),
    });
    expect(sampler.fromHeaders({ 'x-session': 'a' })).toBe('body');
    expect(sampler.fromBody({ session: 'abc' })).toBe(bucketOf(3, '"abc"') < 0.5);
    expect(sampler.fromBody({ session: 42 })).toBe(bucketOf(3, '42') < 0.5);
    expect(sampler.fromBody({ other: 1 })).toBe(false);
    expect(sampler.fromBody(undefined)).toBe(false);
  });

  it('refuses fromBody without a body selector', () => {
    const sampler = new SessionSampler({
      fraction: 1,
      seed: 0,
      selector: parseSessionSelector('header:a'),
      random: Math.random,
    });
    expect(() => sampler.fromBody({})).toThrow(/body selector/);
  });
});
