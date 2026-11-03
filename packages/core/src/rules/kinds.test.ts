import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeRequest, makeResponse } from '../testing.js';
import { captureSource, captureValue, describeCapture } from './capture.js';
import { decimalsEqual, roundDecimalText } from './decimal.js';
import { parseNumericText } from './numeric.js';
import { compileAnchored, compilePattern, patternProblem } from './pattern.js';
import { SubstitutionCaptureSchema, parseDiffRules } from './schema.js';
import { describeWhen, exchangeContext, whenMatches } from './scope.js';
import { parseTimestamp } from './time.js';

describe('whenMatches', () => {
  it('treats no when as global and applies every when without a context', () => {
    expect(whenMatches(undefined, undefined)).toBe(true);
    expect(whenMatches(undefined, {})).toBe(true);
    expect(whenMatches({ tags: ['a'] }, undefined)).toBe(true);
    expect(whenMatches({ tags: ['a'] }, {})).toBe(false);
  });

  it('needs one of each list given, with methods compared case blind', () => {
    const when = { tags: ['a', 'b'], methods: ['post'], paths: ['/v1/orders/*'] };
    expect(whenMatches(when, { tags: ['b'], method: 'POST', path: '/v1/orders/7' })).toBe(true);
    expect(whenMatches(when, { tags: ['c'], method: 'POST', path: '/v1/orders/7' })).toBe(false);
    expect(whenMatches(when, { tags: ['a'], method: 'GET', path: '/v1/orders/7' })).toBe(false);
    expect(whenMatches(when, { tags: ['a'], method: 'POST', path: '/v1/orders' })).toBe(false);
    expect(whenMatches({ methods: ['GET'] }, { tags: [] })).toBe(false);
  });

  it('reads the context of a recorded exchange and describes a scope', () => {
    expect(
      exchangeContext({ tags: ['t'], request: makeRequest({ method: 'GET', path: '/x' }) }),
    ).toEqual({ tags: ['t'], method: 'GET', path: '/x' });
    expect(describeWhen(undefined)).toBe('global');
    expect(describeWhen({ tags: ['a', 'b'], methods: ['GET'], paths: ['/v1/*'] })).toBe(
      'tags a, b; methods GET; paths /v1/*',
    );
  });
});

describe('roundDecimalText', () => {
  it('rounds half away from zero on the digits', () => {
    expect(roundDecimalText('1.005', 2)).toBe('1.01');
    expect(roundDecimalText('-1.005', 2)).toBe('-1.01');
    expect(roundDecimalText('1.004999', 2)).toBe('1.00');
    expect(roundDecimalText('0.5', 0)).toBe('1');
    expect(roundDecimalText('-0.5', 0)).toBe('-1');
    expect(roundDecimalText('-0.004', 2)).toBe('0.00');
    expect(roundDecimalText('9.995', 2)).toBe('10.00');
    expect(roundDecimalText('+.5', 1)).toBe('0.5');
    expect(roundDecimalText('12', 3)).toBe('12.000');
    expect(roundDecimalText('123456789012345678901.5', 0)).toBe('123456789012345678902');
  });

  it('rejects text that is not a decimal', () => {
    for (const text of ['', '.', '-', '1e3', '1.2.3', 'abc', '0x10']) {
      expect(roundDecimalText(text, 2), text).toBeUndefined();
    }
    expect(decimalsEqual('n/a', '1', 2)).toBeUndefined();
    expect(decimalsEqual(null, 1, 2)).toBeUndefined();
  });

  it('agrees with rounding scaled integers for any value of a few digits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 3 }),
        (thousandths, scale) => {
          const sign = thousandths < 0 ? '-' : '';
          const abs = Math.abs(thousandths);
          const text = `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
          const factor = 10 ** (3 - scale);
          const units =
            Math.floor(abs / factor) + (abs % factor >= factor / 2 && factor > 1 ? 1 : 0);
          const digits = String(units).padStart(scale + 1, '0');
          const expected = `${sign && units !== 0 ? '-' : ''}${digits.slice(0, digits.length - scale)}${scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''}`;
          expect(roundDecimalText(text, scale)).toBe(expected);
          // Trailing zeros and the number form give the same text.
          expect(roundDecimalText(`${text}000`, scale)).toBe(expected);
        },
      ),
      { seed: 20261103, numRuns: 300 },
    );
  });
});

describe('parseTimestamp', () => {
  it('reads ISO 8601 with a fraction, a zone, or neither', () => {
    const base = Date.UTC(2026, 9, 16, 20, 50, 45);
    expect(parseTimestamp('2026-10-16T20:50:45Z', 'iso8601')).toBe(base);
    expect(parseTimestamp('2026-10-16T20:50:45', 'iso8601')).toBe(base);
    expect(parseTimestamp('2026-10-16 20:50:45.123456Z', 'iso8601')).toBe(base + 123);
    expect(parseTimestamp('2026-10-16T22:50:45+0200', 'iso8601')).toBe(base);
    expect(parseTimestamp('2026-10-16T20:50Z', 'iso8601')).toBe(base - 45_000);
    expect(parseTimestamp('2026-10-16', 'iso8601')).toBe(Date.UTC(2026, 9, 16));
  });

  it('rejects text that does not read', () => {
    expect(parseTimestamp('2026-13-45', 'iso8601')).toBeUndefined();
    expect(parseTimestamp('yesterday', 'iso8601')).toBeUndefined();
    expect(parseTimestamp(1, 'iso8601')).toBeUndefined();
    expect(parseTimestamp('x', 'epoch_ms')).toBeUndefined();
    expect(parseTimestamp(true, 'epoch_s')).toBeUndefined();
  });

  it('reads epoch numbers and numeric strings', () => {
    expect(parseTimestamp(1500, 'epoch_ms')).toBe(1500);
    expect(parseTimestamp('1.5', 'epoch_s')).toBe(1500);
    expect(parseNumericText('01')).toBeUndefined();
  });
});

describe('patterns', () => {
  it('compiles once and anchors masks', () => {
    expect(compilePattern('a+')).toBe(compilePattern('a+'));
    expect(compileAnchored('a|b').test('ab')).toBe(false);
    expect(compileAnchored('a|b').test('b')).toBe(true);
    expect(patternProblem('(')).toMatch(/./);
    expect(patternProblem('ok')).toBeNull();
  });
});

describe('captures', () => {
  const response = makeResponse({
    headers: { location: '/v1/orders/ord_42' },
    body: { order_id: 'ord_42', n: 7, o: {} },
  });
  const request = makeRequest({ body: { client_ref: 'c-1' } });

  it('reads a body path, a header through a pattern, and a request path', () => {
    const parse = (raw: unknown) => SubstitutionCaptureSchema.parse(raw);
    expect(captureValue(parse({ tag: 't', path: '$.order_id' }), response)).toBe('ord_42');
    expect(captureValue(parse({ tag: 't', path: '$.n' }), response)).toBe(7);
    expect(captureValue(parse({ tag: 't', path: '$.o' }), response)).toBeUndefined();
    const header = parse({ tag: 't', header: 'Location', pattern: '/v1/orders/([^/]+)$' });
    expect(captureValue(header, response)).toBe('ord_42');
    expect(captureValue(parse({ tag: 't', header: 'location' }), response)).toBe(
      '/v1/orders/ord_42',
    );
    expect(
      captureValue(parse({ tag: 't', header: 'location', pattern: 'nope(.)' }), response),
    ).toBe(undefined);
    expect(captureValue(parse({ tag: 't', header: 'x-none' }), response)).toBeUndefined();
    const fromRequest = parse({ tag: 't', from: 'request', path: '$.client_ref' });
    expect(captureValue(fromRequest, response, request)).toBe('c-1');
    expect(captureValue(fromRequest, response)).toBeUndefined();
    expect(captureSource(header)).toBe('header:location');
    expect(captureSource(fromRequest)).toBe('request:$.client_ref');
    expect(describeCapture(header)).toBe('header location through /v1/orders/([^/]+)$');
    expect(describeCapture(fromRequest)).toBe('$.client_ref from the request body');
  });

  it('rejects captures that name no source, two sources, or a bad pattern', () => {
    const load = (capture: string) =>
      parseDiffRules(`substitutions:\n  - name: id\n    capture: ${capture}\n`);
    expect(() => load('{ tag: t }')).toThrow(/capture needs path or header/);
    expect(() => load('{ tag: t, path: "$.a", header: x }')).toThrow(
      /capture needs path or header/,
    );
    expect(() => load('{ tag: t, path: "$.a", pattern: "x" }')).toThrow(/header capture only/);
    expect(() => load('{ tag: t, from: request, header: x }')).toThrow(/reads a path/);
    expect(() => load('{ tag: t, header: x, pattern: "(" }')).toThrow(/bad pattern/);
    expect(() => load('{ tag: t, path: "$..a" }')).toThrow(/unsupported JSONPath/);
  });
});
