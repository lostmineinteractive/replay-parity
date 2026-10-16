import { describe, expect, it } from 'vitest';
import {
  HeaderParseError,
  mergeHeaders,
  normalizeHeaders,
  parseHeaderLine,
  parseHeadersText,
} from './headers.js';

describe('parseHeaderLine', () => {
  it('splits at the first colon, lower cases the name, and trims', () => {
    expect(parseHeaderLine('Authorization: Bearer a:b')).toEqual(['authorization', 'Bearer a:b']);
    expect(parseHeaderLine('  X-Trace :  abc  ')).toEqual(['x-trace', 'abc']);
  });

  it('rejects lines without a name or colon', () => {
    expect(() => parseHeaderLine('no colon here')).toThrow(HeaderParseError);
    expect(() => parseHeaderLine(': value')).toThrow(HeaderParseError);
    expect(() => parseHeaderLine('   : value')).toThrow(HeaderParseError);
  });
});

describe('parseHeadersText', () => {
  it('skips blank lines and comments', () => {
    const text = '# auth\nAuthorization: Bearer t\n\n  \nX-Api-Key: k\n';
    expect(parseHeadersText(text)).toEqual({ authorization: 'Bearer t', 'x-api-key': 'k' });
  });

  it('later lines win', () => {
    expect(parseHeadersText('a: 1\nA: 2')).toEqual({ a: '2' });
  });
});

describe('normalizeHeaders', () => {
  it('lower cases names, joins arrays, stringifies numbers, drops undefined', () => {
    expect(
      normalizeHeaders({ 'Set-Cookie': ['a=1', 'b=2'], 'Content-Length': 12, Missing: undefined }),
    ).toEqual({ 'set-cookie': 'a=1, b=2', 'content-length': '12' });
  });
});

describe('mergeHeaders', () => {
  it('applies overrides case insensitively', () => {
    expect(
      mergeHeaders({ Accept: 'a', authorization: '<redacted>' }, { Authorization: 'real' }),
    ).toEqual({
      accept: 'a',
      authorization: 'real',
    });
  });
});
