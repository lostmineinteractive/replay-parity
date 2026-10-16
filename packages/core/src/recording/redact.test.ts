import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTED_HEADERS,
  REDACTED,
  dropRedactedHeaders,
  redactHeaders,
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

describe('dropRedactedHeaders', () => {
  it('removes entries whose value is the marker', () => {
    expect(dropRedactedHeaders({ authorization: REDACTED, accept: 'a' })).toEqual({ accept: 'a' });
  });
});
