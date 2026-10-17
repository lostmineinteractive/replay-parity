import type { Epoch, StockSnapshot } from '../model.js';
import { Collector, type Rule } from './rule.js';

function describeInterval(epoch: Epoch, a: StockSnapshot, b: StockSnapshot, sku: string): string {
  const parts: string[] = [];
  for (const cmd of epoch.commands) {
    if (cmd.index <= a.command.index || cmd.index >= b.command.index) continue;
    if (cmd.kind === 'adjust' && cmd.accepted && cmd.sku === sku) parts.push(`adjust ${cmd.delta}`);
    if (cmd.kind === 'shipment' && cmd.accepted) {
      const record = epoch.shipments.get(cmd.shipmentId);
      if (record?.sku !== sku) continue;
      const nth = record.acceptances.findIndex((x) => x.index === cmd.index);
      parts.push(
        nth === 0
          ? `shipment ${cmd.shipmentId} (${cmd.quantity})`
          : `shipment ${cmd.shipmentId} delivered again`,
      );
    }
  }
  return parts.length === 0 ? 'no accepted stock changes in between' : parts.join(', ');
}

/**
 * Between two consecutive stock reads, the change in stock on hand for a
 * SKU equals the accepted adjustments minus the unique accepted shipments
 * in between. A shipment applied twice shows up in the interval where it
 * happened.
 */
export const rule: Rule = {
  id: 5,
  name: 'stock-on-hand',
  statement:
    'Stock on hand equals initial stock plus accepted adjustments minus unique accepted shipments.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (let i = 1; i < epoch.snapshots.length; i += 1) {
      const a = epoch.snapshots[i - 1] as StockSnapshot;
      const b = epoch.snapshots[i] as StockSnapshot;
      c.check();
      if (b.unattributedAt > a.unattributedAt) {
        c.undecided(
          `a shipment for an order the recording did not create landed between ${a.command.id} and ${b.command.id}`,
        );
        continue;
      }
      for (const sku of Object.keys(a.stock).sort()) {
        if (!(sku in b.stock)) continue;
        const expected = (b.deltaAt.get(sku) ?? 0) - (a.deltaAt.get(sku) ?? 0);
        const observed = (b.stock[sku] as number) - (a.stock[sku] as number);
        if (expected === observed) continue;
        c.violation(
          `sku ${sku} between reads ${a.command.id} and ${b.command.id}`,
          expected,
          observed,
          `on hand went from ${a.stock[sku]} to ${b.stock[sku]}; ${describeInterval(epoch, a, b, sku)}`,
          b.command.id,
        );
      }
    }
    return c.outcome();
  },
};
