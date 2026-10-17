import { isLiveStatus, type Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * Every view is arithmetically consistent, its quantity is the last
 * accepted one, and shipment events on a canceled order are accepted when
 * they originated before the cancellation and rejected when they did not.
 */
export const rule: Rule = {
  id: 4,
  name: 'remaining-arithmetic',
  statement:
    'Remaining equals total minus shipped for live orders and is zero after cancellation. Unshipped canceled quantity is tracked separately.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const obs of epoch.observations) {
      if (obs.expected === null) continue;
      c.check();
      const v = obs.view;
      const subject = `order ${obs.orderId}`;
      if (v.quantity !== null && v.quantity !== obs.expected.quantity) {
        c.violation(
          subject,
          obs.expected.quantity,
          v.quantity,
          'quantity differs from the create or the last accepted quantity command',
          obs.command.id,
        );
      }
      if (v.status === null) continue;
      const closed = v.status === 'CANCELED' || v.status === 'REJECTED';
      if (
        (isLiveStatus(v.status) || v.status === 'SHIPPED') &&
        v.remaining !== null &&
        v.quantity !== null &&
        v.shipped !== null &&
        v.remaining !== v.quantity - v.shipped
      ) {
        c.violation(
          subject,
          v.quantity - v.shipped,
          v.remaining,
          'remaining is not total minus shipped',
          obs.command.id,
        );
      }
      if (closed && v.remaining !== null && v.remaining !== 0) {
        c.violation(subject, 0, v.remaining, `remaining after ${v.status}`, obs.command.id);
      }
      if (
        v.status === 'CANCELED' &&
        v.canceled_unshipped !== null &&
        v.quantity !== null &&
        v.shipped !== null &&
        v.canceled_unshipped !== v.quantity - v.shipped
      ) {
        c.violation(
          subject,
          v.quantity - v.shipped,
          v.canceled_unshipped,
          'unshipped canceled quantity is not total minus shipped',
          obs.command.id,
        );
      }
    }
    for (const d of epoch.shipmentDecisions) {
      if (!d.first || d.order === null || d.before?.status !== 'CANCELED') continue;
      c.check();
      const canceledAt = d.order.canceledAt as string;
      const preCancel = Date.parse(d.record.originatedAt) < Date.parse(canceledAt);
      const fits = d.record.quantity <= d.before.canceledUnshipped;
      const subject = `shipment ${d.record.shipmentId}`;
      if (preCancel && fits && !d.command.accepted) {
        c.violation(
          subject,
          'accepted',
          `rejected with ${d.command.status}`,
          `originated at ${d.record.originatedAt}, before the cancellation at ${canceledAt}, and fits the ${d.before.canceledUnshipped} unshipped`,
          d.command.id,
        );
      } else if (!preCancel && d.command.accepted) {
        c.violation(
          subject,
          'rejected',
          `accepted with ${d.command.status}`,
          `originated at ${d.record.originatedAt}, not before the cancellation at ${canceledAt}`,
          d.command.id,
        );
      }
    }
    return c.outcome();
  },
};
