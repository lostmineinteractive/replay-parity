import { ConfigError, makeRequest } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { NO_SESSION, cookieValue, parseSessionKey, sessionOf } from './sessions.js';

describe('parseSessionKey', () => {
  it('reads a header, a cookie, and a JSONPath', () => {
    expect(parseSessionKey('header:X-Session')).toEqual({
      kind: 'header',
      name: 'x-session',
      spec: 'header:x-session',
    });
    expect(parseSessionKey('cookie:sid')).toEqual({
      kind: 'cookie',
      name: 'sid',
      spec: 'cookie:sid',
    });
    expect(parseSessionKey('$.session.id')).toMatchObject({
      kind: 'jsonpath',
      spec: '$.session.id',
    });
  });

  it('rejects an empty name, a bad JSONPath, and an unknown form', () => {
    expect(() => parseSessionKey('header:')).toThrow(ConfigError);
    expect(() => parseSessionKey('cookie: ')).toThrow(/cookie name is empty/);
    expect(() => parseSessionKey('$..[')).toThrow(/unsupported JSONPath/);
    expect(() => parseSessionKey('session')).toThrow(/expected header:<name>, cookie:<name>/);
  });
});

describe('cookieValue', () => {
  it('finds one cookie among several and trims it', () => {
    expect(cookieValue('a=1; sid=abc ; b=2', 'sid')).toBe('abc');
    expect(cookieValue('a=1', 'sid')).toBeUndefined();
    expect(cookieValue('broken; sid=x', 'sid')).toBe('x');
    expect(cookieValue(undefined, 'sid')).toBeUndefined();
  });
});

describe('sessionOf', () => {
  it('keys a request by its header, cookie, or body value', () => {
    const header = parseSessionKey('header:x-session');
    expect(sessionOf(header, makeRequest({ headers: { 'x-session': 's1' } }))).toBe('=s1');
    expect(sessionOf(header, makeRequest())).toBe(NO_SESSION);

    const cookie = parseSessionKey('cookie:sid');
    expect(sessionOf(cookie, makeRequest({ headers: { cookie: 'sid=42; t=1' } }))).toBe('=42');
    expect(sessionOf(cookie, makeRequest({ headers: { cookie: 't=1' } }))).toBe(NO_SESSION);

    const body = parseSessionKey('$.account');
    expect(sessionOf(body, makeRequest({ body: { account: 'a' } }))).toBe('=a');
    // A number and a string of the same digits are one session, which only adds ordering.
    expect(sessionOf(body, makeRequest({ body: { account: 7 } }))).toBe('=7');
    expect(sessionOf(body, makeRequest({ body: { account: '7' } }))).toBe('=7');
    expect(sessionOf(body, makeRequest({ body: { account: { id: 1 } } }))).toBe('={"id":1}');
    expect(sessionOf(body, makeRequest({ body: { other: 1 } }))).toBe(NO_SESSION);
    expect(sessionOf(body, makeRequest({ body: { account: null } }))).toBe(NO_SESSION);
    expect(sessionOf(body, makeRequest({ body: 'YQ==', encoding: 'base64' }))).toBe(NO_SESSION);
  });

  it('treats an empty value as no value', () => {
    const header = parseSessionKey('header:x-session');
    expect(sessionOf(header, makeRequest({ headers: { 'x-session': '' } }))).toBe(NO_SESSION);
  });
});
