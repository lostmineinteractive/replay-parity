import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DiffRulesSchema, type DiffRulesInput } from '../rules/schema.js';
import { jsonResponse } from '../testing.js';
import type { JsonValue } from '../json.js';
import { createDiffer } from './diff.js';
import {
  compareExactDecimals,
  exactDecimalOf,
  exactDecimalsEqual,
  parseExactDecimal,
  withinExactTolerance,
  type ExactDecimal,
} from './exact-number.js';

/** A decimal as an integer count of 10^-scale, rendered in several equal spellings. */
interface Spelled {
  units: bigint;
  scale: number;
}

const spelled = fc.record({
  units: fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
  scale: fc.integer({ min: 0, max: 25 }),
});

/** `units / 10^scale` as plain decimal text, with `pad` extra trailing zeros. */
function plain({ units, scale }: Spelled, pad = 0): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = `${digits.slice(digits.length - scale)}${'0'.repeat(pad)}`;
  return `${negative && units !== 0n ? '-' : ''}${whole}${frac.length > 0 ? `.${frac}` : ''}`;
}

/** The same value with an exponent: the coefficient's digits and `e-scale`. */
function exponential({ units, scale }: Spelled): string {
  return `${units.toString()}e-${scale}`;
}

/** The exact order of two spelled decimals, by cross multiplication. */
function referenceOrder(a: Spelled, b: Spelled): -1 | 0 | 1 {
  const s = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(s - a.scale);
  const y = b.units * 10n ** BigInt(s - b.scale);
  return x === y ? 0 : x < y ? -1 : 1;
}

function read(text: string): ExactDecimal {
  const d = parseExactDecimal(text);
  if (d === undefined) throw new Error(`did not parse ${text}`);
  return d;
}

describe('exact decimal comparison', () => {
  it('agrees with integer cross multiplication on every pair', () => {
    fc.assert(
      fc.property(spelled, spelled, (a, b) => {
        expect(compareExactDecimals(read(plain(a)), read(plain(b)))).toBe(referenceOrder(a, b));
      }),
    );
  });

  it('reads every spelling of one value as equal', () => {
    fc.assert(
      fc.property(spelled, fc.integer({ min: 0, max: 5 }), (a, pad) => {
        const base = read(plain(a));
        expect(exactDecimalsEqual(base, read(plain(a, pad)))).toBe(true);
        expect(exactDecimalsEqual(base, read(exponential(a)))).toBe(true);
      }),
    );
  });

  it('is antisymmetric and reflexive', () => {
    fc.assert(
      fc.property(spelled, spelled, (a, b) => {
        const x = read(plain(a));
        const y = read(plain(b));
        expect(compareExactDecimals(x, y)).toBe(-compareExactDecimals(y, x) || 0);
        expect(compareExactDecimals(x, x)).toBe(0);
      }),
    );
  });

  it('settles the stated cases', () => {
    expect(exactDecimalsEqual(read('1.10'), read('1.1'))).toBe(true);
    expect(exactDecimalsEqual(read('1e2'), read('100'))).toBe(true);
    expect(exactDecimalsEqual(read('-0'), read('0'))).toBe(true);
    expect(exactDecimalsEqual(read('12345678901234567890'), read('12345678901234567891'))).toBe(
      false,
    );
    expect(compareExactDecimals(read('1e-400'), read('0'))).toBe(1);
    expect(compareExactDecimals(read('-1e400'), read('1'))).toBe(-1);
    expect(parseExactDecimal('abc')).toBeUndefined();
    expect(parseExactDecimal('.')).toBeUndefined();
    expect(exactDecimalOf('1')).toBeUndefined();
    expect(exactDecimalOf(Number.NaN)).toBeUndefined();
    expect(exactDecimalOf(1e21)).toEqual(read('1e21'));
  });
});

describe('exact tolerance', () => {
  it('matches the exact definition for an absolute tolerance', () => {
    fc.assert(
      fc.property(spelled, spelled, fc.integer({ min: 1, max: 10_000 }), (a, b, tolUnits) => {
        // A tolerance of tolUnits / 1000, exact in decimal.
        const tol = tolUnits / 1000;
        const s = Math.max(a.scale, b.scale, 3);
        const x = a.units * 10n ** BigInt(s - a.scale);
        const y = b.units * 10n ** BigInt(s - b.scale);
        const diff = x > y ? x - y : y - x;
        const allowance = BigInt(tolUnits) * 10n ** BigInt(s - 3);
        expect(withinExactTolerance(read(plain(a)), read(plain(b)), tol, undefined)).toBe(
          diff <= allowance,
        );
      }),
    );
  });

  it('applies a relative tolerance without rounding', () => {
    const a = read('10000000000000000000');
    expect(withinExactTolerance(a, read('10000000000000000001'), undefined, 1e-19)).toBe(true);
    expect(withinExactTolerance(a, read('10000000000000000002'), undefined, 1e-19)).toBe(false);
    expect(withinExactTolerance(read('1.10'), read('1.2'), 0.1, undefined)).toBe(true);
    expect(withinExactTolerance(read('1.10'), read('1.21'), 0.1, undefined)).toBe(false);
    expect(withinExactTolerance(read('1e5000'), read('2e5000'), 1, undefined)).toBe(false);
  });
});

describe('the differ on lossless numbers', () => {
  const diff = (ref: JsonValue, cand: JsonValue, rules: DiffRulesInput = {}) =>
    createDiffer(DiffRulesSchema.parse(rules)).diff(jsonResponse(ref), jsonResponse(cand));

  it('matches equal values in any spelling, lossless or plain', () => {
    expect(diff({ v: { $num: '1.10' } }, { v: 1.1 }).verdict).toBe('match');
    expect(diff({ v: { $num: '1.10' } }, { v: { $num: '1.100' } }).verdict).toBe('match');
    expect(diff({ v: { $num: '1e2' } }, { v: 100 }).verdict).toBe('match');
    const big = { $num: '12345678901234567890' };
    expect(diff({ v: big }, { v: big }).verdict).toBe('match');
  });

  it('finds a difference beyond double precision and names no tolerance', () => {
    const d = diff(
      { v: { $num: '12345678901234567890' } },
      { v: { $num: '12345678901234567891' } },
    );
    expect(d.verdict).toBe('mismatch');
    expect(d.findings).toEqual([
      expect.objectContaining({
        path: '$.v',
        kind: 'value',
        reference: { $num: '12345678901234567890' },
        candidate: { $num: '12345678901234567891' },
        detail: 'no tolerance rule covers this path',
      }),
    ]);
  });

  it('applies tolerances and decimal rules to lossless numbers', () => {
    const tolerances = { tolerances: [{ path: '$.v', abs: 1 }] };
    expect(
      diff(
        { v: { $num: '12345678901234567890' } },
        { v: { $num: '12345678901234567891' } },
        tolerances,
      ).verdict,
    ).toBe('tolerated');
    expect(
      diff(
        { v: { $num: '12345678901234567890' } },
        { v: { $num: '12345678901234567892' } },
        tolerances,
      ).verdict,
    ).toBe('mismatch');
    const decimal = { decimal: [{ path: '$.v', scale: 1 }] };
    expect(diff({ v: { $num: '1.10' } }, { v: { $num: '1.14' } }, decimal).verdict).toBe(
      'tolerated',
    );
  });

  it('reports a lossless number against a string as a type difference between number and string', () => {
    const d = diff({ v: { $num: '1.10' } }, { v: '1.10' });
    expect(d.findings[0]).toMatchObject({
      kind: 'type',
      detail: 'reference is number, candidate is string',
    });
  });

  it('is deterministic over lossless and plain numbers', () => {
    const num = fc.oneof(
      spelled.map((s) => ({ $num: plain(s, 1) })),
      fc.double({ noNaN: true, noDefaultInfinity: true }) as fc.Arbitrary<JsonValue>,
    );
    fc.assert(
      fc.property(fc.dictionary(fc.string(), num), fc.dictionary(fc.string(), num), (a, b) => {
        expect(JSON.stringify(diff(a, b))).toBe(JSON.stringify(diff(a, b)));
      }),
    );
  });
});
