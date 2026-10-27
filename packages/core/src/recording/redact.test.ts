import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTED_HEADERS,
  DEFAULT_REDACTED_QUERY,
  REDACTED,
  dropRedactedHeaders,
  redactHeaders,
  redactQuery,
} from './redact.js';

describe('redactHeaders', () => {
  it('replaces the default names case insensitively', () => {
    expect(DEFAULT_REDACTED_HEADERS).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
    ]);
    expect(
      redactHeaders({ Authorization: 'Bearer x', Cookie: 'a=1', 'X-API-Key': 'k', Accept: 'a' }),
    ).toEqual({ authorization: REDACTED, cookie: REDACTED, 'x-api-key': REDACTED, accept: 'a' });
  });

  it('honors a custom list', () => {
    expect(redactHeaders({ authorization: 'x', 'x-secret': 'y' }, ['X-Secret'])).toEqual({
      authorization: 'x',
      'x-secret': REDACTED,
    });
  });
});

describe('redactQuery', () => {
  it('replaces the default names case insensitively and keeps the key as written', () => {
    expect(DEFAULT_REDACTED_QUERY).toEqual([
      'api_key',
      'apikey',
      'access_token',
      'token',
      'key',
      'secret',
      'signature',
      'password',
    ]);
    expect(
      redactQuery({ api_key: 'k', Token: 't', ACCESS_TOKEN: 'a', page: '2', q: ['x', 'y'] }),
    ).toEqual({
      api_key: REDACTED,
      Token: REDACTED,
      ACCESS_TOKEN: REDACTED,
      page: '2',
      q: ['x', 'y'],
    });
  });

  it('replaces every value of a repeated parameter', () => {
    expect(redactQuery({ token: ['a', 'b'], secret: [] })).toEqual({
      token: [REDACTED, REDACTED],
      secret: [],
    });
  });

  it('honors a custom list and leaves the input untouched', () => {
    const input = { api_key: 'k', tag: ['a', 'b'] };
    expect(redactQuery(input, ['TAG'])).toEqual({ api_key: 'k', tag: [REDACTED, REDACTED] });
    expect(redactQuery(input, [])).toEqual(input);
    expect(input).toEqual({ api_key: 'k', tag: ['a', 'b'] });
    expect(redactQuery({})).toEqual({});
  });
});

describe('dropRedactedHeaders', () => {
  it('removes entries whose value is the marker', () => {
    expect(dropRedactedHeaders({ authorization: REDACTED, accept: 'a' })).toEqual({ accept: 'a' });
  });
});
