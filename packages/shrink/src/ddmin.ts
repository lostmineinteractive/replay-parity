/**
 * Delta debugging over an ordered list. `test` says whether a candidate
 * subset still reproduces the failure. `closure` adds the prerequisites a
 * subset needs, so every subset tried is well formed. Items keep their
 * relative order throughout.
 *
 * With `parallel` above one, the candidates of a round are tested in windows of
 * that many at once and the first reproducing candidate in chunk order is
 * taken, so the result equals the sequential result. The tests that ran past
 * the accepted candidate are handed to `onDiscard`.
 *
 * This is the complement form of ddmin: at granularity `n` the list is cut
 * into `n` chunks and each chunk is tried for removal. A successful removal
 * keeps the smaller list and lowers the granularity. When no chunk can be
 * removed the granularity doubles, until single items have been tried.
 */
export class AttemptBudgetExceeded extends Error {
  constructor(message = 'attempt budget exceeded') {
    super(message);
    this.name = 'AttemptBudgetExceeded';
  }
}

export interface DdminOptions<T> {
  /** Returns `subset` plus whatever it needs, in the original order. */
  closure: (subset: readonly T[]) => T[];
  test: (subset: readonly T[]) => Promise<boolean>;
  /** Equality of two lists, for skipping no-op candidates. */
  same?: ((a: readonly T[], b: readonly T[]) => boolean) | undefined;
  /** Candidates tested at once. Default 1. */
  parallel?: number | undefined;
  /** Caps the window below `parallel`, for a budget that is nearly spent. At least one test is always run. */
  limit?: (() => number) | undefined;
  /** Receives the candidates that were tested ahead of an accepted candidate and not needed. */
  onDiscard?: ((candidates: readonly T[][]) => void) | undefined;
}

export function chunk<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  const size = Math.ceil(items.length / n);
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function ddmin<T>(items: readonly T[], options: DdminOptions<T>): Promise<T[]> {
  const same =
    options.same ??
    ((a: readonly T[], b: readonly T[]): boolean =>
      a.length === b.length && a.every((x, i) => x === b[i]));
  const width = Math.max(1, Math.floor(options.parallel ?? 1));
  let current = [...items];
  let n = 2;
  while (current.length >= 2) {
    const chunks = chunk(current, n);
    const candidates: T[][] = [];
    for (const piece of chunks) {
      const removed = new Set(piece);
      const candidate = options.closure(current.filter((x) => !removed.has(x)));
      if (candidate.length >= current.length || same(candidate, current)) continue;
      candidates.push(candidate);
    }
    let accepted: T[] | undefined;
    for (let at = 0; at < candidates.length && accepted === undefined;) {
      const size = Math.max(1, Math.min(width, options.limit?.() ?? width));
      const window = candidates.slice(at, at + size);
      at += window.length;
      if (window.length === 1) {
        if (await options.test(window[0] as T[])) accepted = window[0];
        continue;
      }
      const settled = await Promise.allSettled(window.map((candidate) => options.test(candidate)));
      for (const [k, outcome] of settled.entries()) {
        if (outcome.status === 'rejected') throw outcome.reason;
        if (outcome.value) {
          accepted = window[k];
          options.onDiscard?.(window.slice(k + 1));
          break;
        }
      }
    }
    if (accepted !== undefined) {
      current = accepted;
      n = Math.max(n - 1, 2);
      continue;
    }
    if (n >= current.length) break;
    n = Math.min(n * 2, current.length);
  }
  return current;
}
