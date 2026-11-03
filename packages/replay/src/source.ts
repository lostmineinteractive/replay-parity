import { iterateRecording, type Exchange, type SubstitutionRule } from '@replay-parity/core';
import { DependencyIndex } from './substitutions.js';

/**
 * Where the engine reads the selected exchanges. A source knows, before the
 * run starts, how many exchanges the recording holds and which of them are
 * selected, and it hands the selection to the engine one pass at a time in
 * recording order. A pass over a file reads the file again, so the engine
 * holds only the exchanges inside its window.
 */
export interface SelectedExchange {
  exchange: Exchange;
  /** Selected only because a filtered exchange uses a substituted value it produces. */
  dependency: boolean;
}

export interface ExchangeSource {
  /** Exchanges in the recording. */
  exchanges: number;
  first_ts: string | null;
  last_ts: string | null;
  /** Exchanges in one pass, after the filter, the dependencies, and the limit. */
  selected: number;
  /** How many of those were pulled in as dependencies. */
  dependencies: number;
  /** One pass over the selection, in recording order. */
  pass(): AsyncIterable<SelectedExchange> | Iterable<SelectedExchange>;
}

export interface SelectionOptions {
  filterTag: string | null;
  limit: number | null;
  includeDependencies: boolean;
  rules: readonly SubstitutionRule[];
}

/**
 * Chooses the positions to replay. With a filter, substitution rules, and
 * `includeDependencies`, the producers of every captured value the filtered
 * exchanges use are selected too, transitively. `visit` is called with every
 * exchange in recording order, and `finish` returns the sorted positions and
 * those pulled in as dependencies. Without a filter nothing is stored per
 * exchange. With one, the positions of the tagged exchanges are stored, and
 * with dependencies also the direct producers of every exchange that has any.
 */
class Selector {
  private count = 0;
  private readonly chosen: number[] = [];
  private readonly index: DependencyIndex | null;
  /** Position -> the positions of its direct producers, for the exchanges that have any. */
  private readonly producers = new Map<number, number[]>();

  constructor(private readonly options: SelectionOptions) {
    this.index =
      options.filterTag !== null && options.includeDependencies && options.rules.length > 0
        ? new DependencyIndex([], options.rules)
        : null;
  }

  visit(e: Exchange): void {
    const i = this.count;
    this.count += 1;
    const { filterTag, limit } = this.options;
    if (filterTag === null) return;
    if (e.tags.includes(filterTag) && (limit === null || this.chosen.length < limit)) {
      this.chosen.push(i);
    }
    if (this.index !== null) {
      const direct = this.index.dependenciesOf(i, e.request);
      if (direct.length > 0) this.producers.set(i, direct);
      this.index.add(e, i);
    }
  }

  /** The selected positions in recording order, or null for the first `selected` positions. */
  finish(): { positions: number[] | null; pulled: Set<number>; selected: number } {
    const { filterTag, limit } = this.options;
    if (filterTag === null) {
      return {
        positions: null,
        pulled: new Set(),
        selected: limit === null ? this.count : Math.min(limit, this.count),
      };
    }
    const pulled = new Set<number>();
    const seen = new Set(this.chosen);
    const queue = [...this.chosen];
    while (queue.length > 0) {
      const i = queue.pop() as number;
      for (const producer of this.producers.get(i) ?? []) {
        if (seen.has(producer)) continue;
        seen.add(producer);
        pulled.add(producer);
        queue.push(producer);
      }
    }
    const positions = [...this.chosen, ...pulled].sort((a, b) => a - b);
    return { positions, pulled, selected: positions.length };
  }
}

/** A source over exchanges already in memory. */
export function memorySource(all: readonly Exchange[], options: SelectionOptions): ExchangeSource {
  const selector = new Selector(options);
  for (const e of all) selector.visit(e);
  const { positions, pulled, selected } = selector.finish();
  const order = positions ?? Array.from({ length: selected }, (_, i) => i);
  const items: SelectedExchange[] = order.map((i) => ({
    exchange: all[i] as Exchange,
    dependency: pulled.has(i),
  }));
  return {
    exchanges: all.length,
    first_ts: all[0]?.ts ?? null,
    last_ts: all[all.length - 1]?.ts ?? null,
    selected,
    dependencies: pulled.size,
    pass: () => items,
  };
}

/**
 * A source over a recording file. The file is read once up front to validate
 * every line, count the exchanges, and choose the selection, and once more per
 * pass. A recording that does not parse is refused before anything is sent.
 */
export async function fileSource(path: string, options: SelectionOptions): Promise<ExchangeSource> {
  const selector = new Selector(options);
  let exchanges = 0;
  let first: string | null = null;
  let last: string | null = null;
  for await (const e of iterateRecording(path)) {
    selector.visit(e);
    exchanges += 1;
    first ??= e.ts;
    last = e.ts;
  }
  const { positions, pulled, selected } = selector.finish();
  async function* pass(): AsyncGenerator<SelectedExchange> {
    if (selected === 0) return;
    let i = 0;
    let next = 0;
    for await (const exchange of iterateRecording(path)) {
      if (positions === null) {
        yield { exchange, dependency: false };
        if (i + 1 >= selected) return;
      } else if (positions[next] === i) {
        yield { exchange, dependency: pulled.has(i) };
        next += 1;
        if (next >= positions.length) return;
      }
      i += 1;
    }
  }
  return {
    exchanges,
    first_ts: first,
    last_ts: last,
    selected,
    dependencies: pulled.size,
    pass,
  };
}
