import type { Diff, ExchangeResult } from '@replay-parity/core';

/**
 * Noise from the reference re-replay. Every exchange is sent to the reference
 * as well as the candidate, and the reference's answer is diffed against its
 * own recording first. A path where they differ moves on the reference by
 * itself, so the same difference on the candidate is not held against it.
 */

export const NO_NOISE: ReadonlySet<string> = new Set();

/** The rule a noise finding names. */
export const NOISE_RULE = 'noise:reference';

/** Finding kinds that say the reference did not behave as recorded at all. */
const NOT_COMPARABLE: ReadonlySet<string> = new Set(['status', 'body_format', 'body_too_large']);

/**
 * The paths where the reference, replayed now, differs from its own recording. A path that
 * moves on the reference by itself, such as a timestamp, cannot be held against the candidate.
 * A reference that answered a different status, a body of another format, or a body too large
 * to compare is not the same behavior as the recording, so it names no noise at all: otherwise
 * a reference that failed would excuse every difference of a candidate that failed the same way.
 */
export function noisePaths(diff: Diff): ReadonlySet<string> {
  const untolerated = diff.findings.filter((f) => !f.tolerated);
  if (untolerated.some((f) => NOT_COMPARABLE.has(f.kind))) return NO_NOISE;
  return new Set(untolerated.map((f) => f.path));
}

/**
 * Tolerates every untolerated finding at a noise path, marks it `noise: true` with the rule
 * `noise:reference`, and recomputes the verdict. Findings at other paths are left as they are.
 */
export function markNoise(
  diff: Diff,
  noise: ReadonlySet<string>,
): { diff: NonNullable<ExchangeResult['diff']>; count: number } {
  let count = 0;
  const findings = diff.findings.map((f) => {
    if (f.tolerated || !noise.has(f.path)) return f;
    count += 1;
    return { ...f, tolerated: true, rule: NOISE_RULE, noise: true as const };
  });
  if (count === 0) return { diff, count };
  // A finding was marked, so the diff is not empty and is tolerated or still a mismatch.
  const verdict = findings.every((f) => f.tolerated) ? 'tolerated' : 'mismatch';
  return { diff: { verdict, findings }, count };
}
