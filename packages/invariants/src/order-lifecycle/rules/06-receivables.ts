import { formatMilli } from '../commands.js';
import type { Epoch, StockSnapshot } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * Between two consecutive ledger reads, receivables grow by the sum over
 * unique accepted shipments of quantity times unit price, in thousandths.
 */
export const rule: Rule = {
  id: 6,
  name: 'receivables',
  statement: 'Receivables equal the sum of unique shipment line totals, computed in decimal.',
  check(epoch: Epoch) {
    const c = new Collector();
    const ledgers = epoch.snapshots.filter((s) => s.kind === 'ledger');
    for (let i = 1; i < ledgers.length; i += 1) {
      const a = ledgers[i - 1] as StockSnapshot;
      const b = ledgers[i] as StockSnapshot;
      c.check();
      if (a.receivablesMilli === null || b.receivablesMilli === null) {
        c.undecided(`receivables could not be read at ${a.command.id} or ${b.command.id}`);
        continue;
      }
      let expected = 0;
      const lines: string[] = [];
      let unknownPrice = false;
      for (const record of epoch.shipments.values()) {
        const applied = record.acceptances[0];
        if (applied === undefined) continue;
        if (applied.index <= a.command.index || applied.index >= b.command.index) continue;
        const price = epoch.orders.get(record.orderId)?.unitPriceMilli ?? null;
        if (price === null) {
          unknownPrice = true;
          continue;
        }
        expected += record.quantity * price;
        lines.push(`${record.shipmentId}: ${record.quantity} x ${formatMilli(price)}`);
      }
      if (unknownPrice) {
        c.undecided(
          `a shipment between ${a.command.id} and ${b.command.id} has no known unit price`,
        );
        continue;
      }
      const observed = b.receivablesMilli - a.receivablesMilli;
      if (observed === expected) continue;
      c.violation(
        `receivables between ledger reads ${a.command.id} and ${b.command.id}`,
        formatMilli(expected),
        formatMilli(observed),
        `receivables went from ${formatMilli(a.receivablesMilli)} to ${formatMilli(b.receivablesMilli)}; unique shipments in between: ${lines.length === 0 ? 'none' : lines.join(', ')}`,
        b.command.id,
      );
    }
    return c.outcome();
  },
};
