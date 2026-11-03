import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * The number of orders equals the number of distinct create commands, a
 * repeated shipment delivery answers with the original shipment, and an
 * order that was created can still be read.
 */
export const rule: Rule = {
  id: 9,
  name: 'retry-no-reset',
  statement: 'A retried command cannot reset state or create a second order.',
  check(epoch: Epoch) {
    const c = new Collector();
    if (epoch.creates.some((r) => r.command.accepted)) {
      c.check();
      const keyless = epoch.creates.filter(
        (r) => r.first && r.command.kind === 'create' && r.command.key === null,
      ).length;
      const keyed = [...epoch.keys.values()].filter((k) =>
        [...k.byPayload.values()].some((g) => g.accepted.length > 0),
      ).length;
      const expected = keyless + keyed;
      const observed = epoch.orders.size;
      if (observed !== expected) {
        const extra = [...epoch.orders.values()]
          .filter((o) => o.key !== null)
          .filter((o, _, all) => all.some((p) => p.key === o.key && p.orderId < o.orderId))
          .map((o) => `${o.orderId} (key ${o.key ?? ''})`);
        c.violation(
          'orders created',
          expected,
          observed,
          `${keyless} creates without a key and ${keyed} keys with an accepted create${extra.length > 0 ? `; second orders under a reused key: ${extra.join(', ')}` : ''}`,
          null,
        );
      }
    }
    for (const record of epoch.shipments.values()) {
      if (record.acceptances.length < 2) continue;
      c.check();
      const first = record.firstView;
      for (const later of record.acceptances.slice(1)) {
        const view = later.kind === 'shipment' ? later.view : null;
        if (first === null || view === null) continue;
        if (view.order_id !== first.order_id || view.quantity !== first.quantity) {
          c.violation(
            `shipment ${record.shipmentId}`,
            { order_id: first.order_id, quantity: first.quantity },
            { order_id: view.order_id, quantity: view.quantity },
            'a repeated delivery did not answer with the original shipment',
            later.id,
          );
        }
      }
    }
    for (const missing of epoch.missingReads) {
      c.check();
      c.violation(
        `order ${missing.orderId}`,
        'readable after creation',
        `status ${missing.command.status}`,
        'the order was created in this recording and later could not be read',
        missing.command.id,
      );
    }
    return c.outcome();
  },
};
