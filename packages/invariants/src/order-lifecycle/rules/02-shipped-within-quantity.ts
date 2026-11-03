import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * Every view shows `shipped` at most `quantity`. An accepted first delivery
 * never exceeds what was left to ship, and an accepted quantity change never
 * goes below what was already shipped.
 */
export const rule: Rule = {
  id: 2,
  name: 'shipped-within-quantity',
  statement: 'Shipped quantity never exceeds the effective total quantity.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const obs of epoch.observations) {
      if (obs.view.shipped === null || obs.view.quantity === null) continue;
      c.check();
      if (obs.view.shipped > obs.view.quantity) {
        c.violation(
          `order ${obs.orderId}`,
          `shipped at most ${obs.view.quantity}`,
          obs.view.shipped,
          'the view shows more shipped than the total quantity',
          obs.command.id,
        );
      }
    }
    for (const d of epoch.shipmentDecisions) {
      if (!d.first || !d.command.accepted || d.before === null) continue;
      c.check();
      const limit =
        d.before.status === 'CANCELED' ? d.before.canceledUnshipped : d.before.remaining;
      if (d.record.quantity > limit) {
        c.violation(
          `shipment ${d.record.shipmentId}`,
          `quantity at most ${limit}`,
          d.record.quantity,
          `accepted beyond what order ${d.record.orderId} had left to ship`,
          d.command.id,
        );
      }
    }
    for (const q of epoch.quantityDecisions) {
      if (q.shippedBefore === null || q.order === null) continue;
      c.check();
      if (q.command.kind === 'quantity' && q.command.quantity < q.shippedBefore) {
        c.violation(
          `order ${q.order.orderId}`,
          `quantity at least ${q.shippedBefore}`,
          q.command.quantity,
          'a quantity below the shipped amount was accepted',
          q.command.id,
        );
      }
    }
    return c.outcome();
  },
};
