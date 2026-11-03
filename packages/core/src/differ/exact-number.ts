import { isLosslessNumber, type JsonValue } from '../json.js';

/**
 * Exact decimal arithmetic on number texts, for lossless numbers. A text is
 * read as a sign, an integer coefficient, and a power of ten, with trailing
 * zeros of the coefficient moved into the exponent, so `1.10`, `1.1`, and
 * `11e-1` read the same and equality is a comparison of the three parts.
 * Nothing goes through a floating point number, so `12345678901234567890`
 * and `12345678901234567891` differ.
 */

export interface ExactDecimal {
  negative: boolean;
  /** Non negative; zero only for the value zero. */
  coefficient: bigint;
  exponent: number;
}

const TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Reads a JSON number text, or a finite number as JavaScript prints it. `undefined` when it is neither. */
export function parseExactDecimal(text: string): ExactDecimal | undefined {
  const m = TEXT.exec(text.trim());
  if (m === null) return undefined;
  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  if (whole.length === 0 && frac.length === 0) return undefined;
  let coefficient = BigInt(`${whole}${frac}` || '0');
  let exponent = Number(m[4] ?? '0') - frac.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  if (coefficient === 0n) return { negative: false, coefficient: 0n, exponent: 0 };
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1;
  }
  return { negative: m[1] === '-', coefficient, exponent };
}

/** The decimal of a lossless number or a finite number, or `undefined` for anything else. */
export function exactDecimalOf(value: JsonValue | undefined): ExactDecimal | undefined {
  if (isLosslessNumber(value)) return parseExactDecimal(value.$num);
  if (typeof value === 'number' && Number.isFinite(value)) return parseExactDecimal(String(value));
  return undefined;
}

function digits(n: bigint): number {
  return n.toString().length;
}

/** -1, 0, or 1 as `a` is below, equal to, or above `b`. */
export function compareExactDecimals(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const signA = a.coefficient === 0n ? 0 : a.negative ? -1 : 1;
  const signB = b.coefficient === 0n ? 0 : b.negative ? -1 : 1;
  if (signA !== signB) return signA < signB ? -1 : 1;
  if (signA === 0) return 0;
  // Same sign: compare magnitudes, then flip for negatives.
  const flip = signA < 0 ? -1 : 1;
  const magA = digits(a.coefficient) + a.exponent;
  const magB = digits(b.coefficient) + b.exponent;
  let order: number;
  if (magA !== magB) {
    order = magA < magB ? -1 : 1;
  } else {
    // Equal leading position, so the exponents differ by at most the digit counts.
    const e = Math.min(a.exponent, b.exponent);
    const ca = a.coefficient * 10n ** BigInt(a.exponent - e);
    const cb = b.coefficient * 10n ** BigInt(b.exponent - e);
    order = ca === cb ? 0 : ca < cb ? -1 : 1;
  }
  if (order === 0) return 0;
  return (order * flip) as -1 | 1;
}

export function exactDecimalsEqual(a: ExactDecimal, b: ExactDecimal): boolean {
  return compareExactDecimals(a, b) === 0;
}

/** The largest exponent gap the exact tolerance check aligns; past it the gap dwarfs any tolerance. */
const MAX_ALIGN = 4096;

/** `d` as an integer count of 10^e. `e` is at most the exponent of `d` unless `d` is zero. */
function scaled(d: ExactDecimal, e: number): bigint {
  if (d.coefficient === 0n) return 0n;
  const c = d.coefficient * 10n ** BigInt(d.exponent - e);
  return d.negative ? -c : c;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * Whether `|a - b| <= max(absTol, relTol * max(|a|, |b|))`, worked exactly
 * on the decimals with the tolerances read from their JavaScript text. When
 * the exponents involved are more than a few thousand places apart, the
 * check goes through floating point instead, where no tolerance can change
 * the answer.
 */
export function withinExactTolerance(
  a: ExactDecimal,
  b: ExactDecimal,
  absTol: number | undefined,
  relTol: number | undefined,
): boolean {
  const absD = parseExactDecimal(String(absTol ?? 0)) as ExactDecimal;
  const relD = parseExactDecimal(String(relTol ?? 0)) as ExactDecimal;
  const exponents = [a.exponent, b.exponent];
  if (absD.coefficient !== 0n) exponents.push(absD.exponent);
  const unit = Math.min(...exponents);
  const top = Math.max(...exponents);
  if (top - unit > MAX_ALIGN || Math.abs(relD.exponent) > MAX_ALIGN) {
    const x = Number(`${a.negative ? '-' : ''}${a.coefficient}e${a.exponent}`);
    const y = Number(`${b.negative ? '-' : ''}${b.coefficient}e${b.exponent}`);
    const allowance = Math.max(absTol ?? 0, (relTol ?? 0) * Math.max(Math.abs(x), Math.abs(y)));
    return Math.abs(x - y) <= allowance;
  }
  // Every term as an integer count of 10^unit.
  const ua = scaled(a, unit);
  const ub = scaled(b, unit);
  const diff = abs(ua - ub);
  if (diff <= scaled(absD, unit)) return true;
  const larger = abs(ua) > abs(ub) ? abs(ua) : abs(ub);
  // diff <= rel * larger, with rel = coefficient * 10^exponent, multiplied out so no division is needed.
  return relD.exponent >= 0
    ? diff <= relD.coefficient * larger * 10n ** BigInt(relD.exponent)
    : diff * 10n ** BigInt(-relD.exponent) <= relD.coefficient * larger;
}
