import { isJsonObject, type DiffRules, type Exchange } from '@replay-parity/core';
import { DependencyIndex } from '@replay-parity/replay';

/**
 * Which earlier exchanges an exchange needs. Two sources: the substitution
 * rules, which name the values a request takes from an earlier response,
 * and the order lifecycle, where any request on `/v1/orders/<id>` needs the
 * create that produced `<id>`. Shipment ids and the relative order are
 * never changed, so those prerequisites hold by construction.
 */
const ORDER_PATH = /^\/v1\/orders\/([^/?]+)/;

export class Prerequisites {
  private readonly index: DependencyIndex;
  private readonly creates = new Map<string, number>();

  constructor(
    private readonly exchanges: readonly Exchange[],
    rules: DiffRules,
  ) {
    this.index = new DependencyIndex(exchanges, rules.substitutions);
    exchanges.forEach((e, i) => {
      if (e.request.method.toUpperCase() !== 'POST' || e.request.path !== '/v1/orders') return;
      if (e.response.status !== 201 || !isJsonObject(e.response.body)) return;
      const id = e.response.body.order_id;
      if (typeof id === 'string' && !this.creates.has(id)) this.creates.set(id, i);
    });
  }

  /** Indices of the exchanges that the exchange at `i` needs. */
  of(i: number): number[] {
    const exchange = this.exchanges[i] as Exchange;
    const out = new Set<number>(this.index.dependenciesOf(i, exchange.request));
    const m = ORDER_PATH.exec(exchange.request.path);
    if (m) {
      const create = this.creates.get(m[1] as string);
      if (create !== undefined && create < i) out.add(create);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Returns `indices` plus every prerequisite, transitively, plus `always`, sorted. */
  closure(indices: readonly number[], always: readonly number[] = []): number[] {
    const kept = new Set<number>([...indices, ...always]);
    const queue = [...kept];
    while (queue.length > 0) {
      const i = queue.pop() as number;
      for (const p of this.of(i)) {
        if (!kept.has(p)) {
          kept.add(p);
          queue.push(p);
        }
      }
    }
    return [...kept].sort((a, b) => a - b);
  }
}
