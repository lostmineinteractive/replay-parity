/**
 * Delta debugging over an ordered list. `test` says whether a candidate
 * subset still reproduces the failure. `closure` adds the prerequisites a
 * subset needs, so every subset tried is well formed. Items keep their
 * relative order throughout.
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
  let current = [...items];
  let n = 2;
  while (current.length >= 2) {
    const chunks = chunk(current, n);
    let reduced = false;
    for (const piece of chunks) {
      const removed = new Set(piece);
      const candidate = options.closure(current.filter((x) => !removed.has(x)));
      if (candidate.length >= current.length || same(candidate, current)) continue;
      if (await options.test(candidate)) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (n >= current.length) break;
    n = Math.min(n * 2, current.length);
  }
  return current;
}
