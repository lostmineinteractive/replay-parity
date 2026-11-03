import type { JsonValue } from '../json.js';

/**
 * Decimal comparison at a scale. The text of each value is rounded half
 * away from zero to `scale` places with integer arithmetic on its digits,
 * never through a floating point number, and the two rounded texts are
 * compared. `"29.90"`, `"29.9"`, and `29.9` are equal at scale 2; `"1.005"`
 * and `"1.01"` are equal at scale 2 and differ at scale 3.
 */

/** An optional sign, digits, and an optional fraction, with at least one digit in all. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** The decimal text of a value: a string as written, a finite number as JavaScript prints it. */
export function decimalText(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Rounds a decimal text to `scale` places, half away from zero. Returns the
 * canonical text with exactly `scale` fraction digits and no leading zeros,
 * or `undefined` when the text is not a decimal. Negative zero is `0`.
 */
export function roundDecimalText(text: string, scale: number): string | undefined {
  const m = DECIMAL_TEXT.exec(text.trim());
  if (!m) return undefined;
  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  if (whole.length === 0 && frac.length === 0) return undefined;
  const kept = frac.slice(0, scale).padEnd(scale, '0');
  let units = BigInt(`${whole.length === 0 ? '0' : whole}${kept}`);
  if (frac.length > scale && (frac[scale] as string) >= '5') units += 1n;
  const negative = m[1] === '-' && units !== 0n;
  const digits = units.toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${intPart}${scale > 0 ? `.${fracPart}` : ''}`;
}

/**
 * Whether two values are equal decimals at `scale`. `undefined` when either
 * is not a decimal string or a finite number, so the caller falls back to the
 * ordinary comparison.
 */
export function decimalsEqual(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
  scale: number,
): boolean | undefined {
  const ta = decimalText(a);
  const tb = decimalText(b);
  if (ta === undefined || tb === undefined) return undefined;
  const ra = roundDecimalText(ta, scale);
  const rb = roundDecimalText(tb, scale);
  if (ra === undefined || rb === undefined) return undefined;
  return ra === rb;
}
