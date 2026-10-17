import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/** Across the views of one order in time order, `shipped` never goes down. */
export const rule: Rule = {
  id: 3,
  name: 'shipped-monotonic',
  statement: 'Cumulative shipped quantity never decreases.',
  check(epoch: Epoch) {
    const c = new Collector();
    const last = new Map<string, { shipped: number; id: string }>();
    const seen = new Set<string>();
    for (const obs of epoch.observations) {
      if (obs.view.shipped === null) continue;
      const previous = last.get(obs.orderId);
      if (previous !== undefined) {
        if (!seen.has(obs.orderId)) {
          seen.add(obs.orderId);
          c.check();
        }
        if (obs.view.shipped < previous.shipped) {
          c.violation(
            `order ${obs.orderId}`,
            `shipped at least ${previous.shipped}`,
            obs.view.shipped,
            `shipped went down after exchange ${previous.id}`,
            obs.command.id,
          );
        }
      }
      last.set(obs.orderId, { shipped: obs.view.shipped, id: obs.command.id });
    }
    return c.outcome();
  },
};
