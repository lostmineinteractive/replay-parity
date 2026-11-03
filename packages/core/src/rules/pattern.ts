/**
 * Regular expressions from rules files. Each pattern is compiled once and
 * cached by its text. A pattern that does not compile is rejected when the
 * rules are loaded, so the differ never meets one.
 */

const plain = new Map<string, RegExp>();
const anchored = new Map<string, RegExp>();

/** The reason a pattern does not compile, or `null` when it does. */
export function patternProblem(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The pattern as written. A header capture applies it and takes the first group or the whole match. */
export function compilePattern(pattern: string): RegExp {
  let re = plain.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern);
    plain.set(pattern, re);
  }
  return re;
}

/** The pattern anchored at both ends, so a mask matches a whole value whether or not it says `^` and `$`. */
export function compileAnchored(pattern: string): RegExp {
  let re = anchored.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^(?:${pattern})$`);
    anchored.set(pattern, re);
  }
  return re;
}
