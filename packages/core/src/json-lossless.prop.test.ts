import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  containsLosslessNumber,
  isLosslessNumber,
  numberTextRoundTrips,
  parseJsonLossless,
  stringifyJsonLossless,
  type JsonValue,
} from './json.js';
import { decodeBody, encodeBody } from './recording/body.js';

/** Any JSON number text: big integers, trailing zeros, exponents, negative zero. */
const numberText = fc.oneof(
  fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }).map(String),
  fc
    .tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.nat({ max: 999_999 }), fc.nat(4))
    .map(([w, f, z]) => `${w}.${f}${'0'.repeat(z)}`),
  fc
    .tuple(fc.integer({ min: -999, max: 999 }), fc.constantFrom('e', 'E', 'e+', 'e-'), fc.nat(400))
    .map(([m, e, x]) => `${m}${e}${x}`),
  fc.constantFrom('-0', '0', '1.0', '1.10', '1e2', '9007199254740993', '0.1', '100'),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((d) => JSON.stringify(d)),
);

/**
 * JSON text written without whitespace, strings through JSON.stringify,
 * numbers as generated, and unique keys.
 */
const jsonText: fc.Arbitrary<string> = fc.letrec<{ value: string }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    numberText,
    fc.string().map((s) => JSON.stringify(s)),
    fc.constantFrom('true', 'false', 'null'),
    fc.array(tie('value'), { maxLength: 4 }).map((items) => `[${items.join(',')}]`),
    fc
      // Keys never look like array indexes, which JavaScript objects move to the front.
      .uniqueArray(
        fc.tuple(
          fc.string().map((k) => `k${k}`),
          tie('value'),
        ),
        {
          maxLength: 4,
          selector: ([k]) => k,
        },
      )
      .map((entries) => `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`),
  ),
})).value;

describe('lossless JSON', () => {
  it('round trips any number text exactly through parse and stringify', () => {
    fc.assert(
      fc.property(jsonText, (text) => {
        expect(stringifyJsonLossless(parseJsonLossless(text))).toBe(text);
      }),
    );
  });

  it('gives what JSON.parse gives when every number keeps its text', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        expect(parseJsonLossless(text)).toEqual(JSON.parse(text));
        expect(containsLosslessNumber(parseJsonLossless(text))).toBe(false);
      }),
    );
  });

  it('wraps exactly the numbers whose JavaScript round trip changes their text', () => {
    fc.assert(
      fc.property(numberText, (text) => {
        const parsed = parseJsonLossless(text);
        if (numberTextRoundTrips(text)) {
          expect(parsed).toBe(Number(text));
        } else {
          expect(parsed).toEqual({ $num: text });
        }
      }),
    );
  });

  it('keeps the stated cases', () => {
    expect(parseJsonLossless('{"a":1.10,"b":[12345678901234567890,1e2,3]}')).toEqual({
      a: { $num: '1.10' },
      b: [{ $num: '12345678901234567890' }, { $num: '1e2' }, 3],
    });
    expect(parseJsonLossless(' [ 1.0 , "x\\"1.0" ] ')).toEqual([{ $num: '1.0' }, 'x"1.0']);
  });

  it('keeps JSON.parse semantics for __proto__ and repeated keys', () => {
    const text = '{"__proto__":{"x":1.10},"a":1,"a":2.50}';
    const parsed = parseJsonLossless(text) as Record<string, JsonValue>;
    expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(text) as object));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed.a).toEqual({ $num: '2.50' });
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({
      x: { $num: '1.10' },
    });
  });

  it('rejects what JSON.parse rejects', () => {
    expect(() => parseJsonLossless('{"a":1.10')).toThrow(SyntaxError);
    expect(() => parseJsonLossless('01')).toThrow(SyntaxError);
  });

  it('recognizes only the reserved shape with a number text', () => {
    expect(isLosslessNumber({ $num: '1.10' })).toBe(true);
    expect(isLosslessNumber({ $num: 'abc' })).toBe(false);
    expect(isLosslessNumber({ $num: '1', other: 1 })).toBe(false);
    expect(isLosslessNumber('1.10')).toBe(false);
  });
});

describe('lossless numbers in stored bodies', () => {
  const store = (text: string) => encodeBody(Buffer.from(text), 'application/json');

  it('stores a lossy number as $num and sends its original text back', () => {
    fc.assert(
      fc.property(jsonText, (text) => {
        const fields = store(text);
        expect(fields.encoding).toBeUndefined();
        expect(decodeBody(fields)?.toString('utf8')).toBe(text);
      }),
    );
  });

  it('stores a body with no lossy number exactly as JSON.parse reads it', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        expect(store(text)).toEqual({ body: JSON.parse(text) as JsonValue });
      }),
    );
  });

  it('stores a body that spells the reserved shape itself as bytes', () => {
    const text = '{"price":{"$num":"1.5"}}';
    const fields = store(text);
    expect(fields.encoding).toBe('base64');
    expect(decodeBody(fields)?.toString('utf8')).toBe(text);
    expect(store('{"$num":"abc"}')).toEqual({ body: { $num: 'abc' } });
  });
});
