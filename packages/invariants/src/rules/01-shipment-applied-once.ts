import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * For every order with an accepted shipment, each later view of the order
 * shows `shipped` equal to the sum of its unique accepted shipments. A
 * shipment delivered twice must count once.
 */
export const rule: Rule = {
  id: 1,
  name: 'shipment-applied-once',
  statement:
    'An accepted shipment event changes stock on hand exactly once, including after retries or restart.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const order of epoch.orders.values()) {
      if (order.shipmentIds.length === 0) continue;
      c.check();
      const firstId = order.shipmentIds[0] as string;
      const firstIndex = epoch.shipments.get(firstId)?.acceptances[0]?.index ?? 0;
      const repeated = order.shipmentIds
        .map((id) => epoch.shipments.get(id))
        .filter((s) => s !== undefined && s.acceptances.length > 1)
        .map((s) => `${s?.shipmentId ?? ''} delivered ${s?.acceptances.length ?? 0} times`);
      for (const obs of epoch.observations) {
        if (obs.orderId !== order.orderId || obs.command.index < firstIndex) continue;
        if (obs.view.shipped === null || obs.expected === null) continue;
        if (obs.view.shipped === obs.expected.shipped) continue;
        c.violation(
          `order ${order.orderId}`,
          obs.expected.shipped,
          obs.view.shipped,
          `shipped after ${order.shipmentIds.length} unique accepted shipment${order.shipmentIds.length === 1 ? '' : 's'} (${order.shipmentIds.join(', ')})${repeated.length > 0 ? `; ${repeated.join('; ')}` : ''}`,
          obs.command.id,
        );
        break;
      }
    }
    return c.outcome();
  },
};
