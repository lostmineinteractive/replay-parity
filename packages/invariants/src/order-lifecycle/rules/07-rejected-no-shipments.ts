import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/** An order whose allocation was rejected never ships and never shows shipped quantity. */
export const rule: Rule = {
  id: 7,
  name: 'rejected-no-shipments',
  statement: 'A rejected order produces no shipments.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const order of epoch.orders.values()) {
      if (order.allocation !== 'REJECTED') continue;
      c.check();
      for (const record of epoch.shipments.values()) {
        if (record.orderId !== order.orderId || record.acceptances.length === 0) continue;
        c.violation(
          `order ${order.orderId}`,
          'no accepted shipment',
          `shipment ${record.shipmentId} accepted`,
          'the order was rejected at creation',
          record.acceptances[0]?.id ?? null,
        );
      }
      for (const obs of epoch.observations) {
        if (obs.orderId !== order.orderId || obs.view.shipped === null || obs.view.shipped === 0) {
          continue;
        }
        c.violation(
          `order ${order.orderId}`,
          0,
          obs.view.shipped,
          'a rejected order shows shipped quantity',
          obs.command.id,
        );
        break;
      }
    }
    return c.outcome();
  },
};
