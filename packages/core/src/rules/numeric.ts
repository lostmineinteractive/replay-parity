/**
 * The grammar of a number written as text: an optional sign, an integer
 * part without leading zeros, and an optional fraction. Substitutions use it
 * to read a captured number back from a path or a query, and the
 * `numeric_strings` equivalence uses it to compare `"1"` with `1`.
 */
export const NUMERIC_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** The number a text spells under `NUMERIC_TEXT`, or `undefined`. */
export function parseNumericText(text: string): number | undefined {
  return NUMERIC_TEXT.test(text) ? Number(text) : undefined;
}
