import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * A new order is open when its quantity fits the stock available at that
 * moment and rejected otherwise. Available stock is the expected stock on
 * hand minus what live orders still have to ship.
 */
export const rule: Rule = {
  id: 10,
  name: 'allocation-deterministic',
  statement:
    'Allocation decisions are deterministic given the order and the stock snapshot in the recording.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const create of epoch.creates) {
      if (!create.first || create.orderId === null || create.command.kind !== 'create') continue;
      const order = epoch.orders.get(create.orderId);
      if (!order) continue;
      c.check();
      const initial = epoch.initialStock.get(create.sku);
      if (initial === undefined) {
        c.undecided(`no stock read for sku ${create.sku} fixes a baseline`);
        continue;
      }
      const onHand = initial + create.deltaAt;
      const available = onHand - create.allocatedAt;
      const expected = create.command.qty <= available ? 'OPEN' : 'REJECTED';
      if (expected === order.allocation) continue;
      c.violation(
        `order ${order.orderId}`,
        expected,
        order.allocation,
        `qty ${create.command.qty} against ${available} available (${onHand} on hand, ${create.allocatedAt} allocated to live orders)`,
        create.command.id,
      );
    }
    return c.outcome();
  },
};
