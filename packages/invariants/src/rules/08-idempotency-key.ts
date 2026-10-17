import type { Epoch } from '../model.js';
import { Collector, type Rule } from './rule.js';

/**
 * Under one idempotency key, every accepted create with the same payload
 * names the same order, a retry after an accepted create is not rejected,
 * and a different payload is never accepted.
 */
export const rule: Rule = {
  id: 8,
  name: 'idempotency-key',
  statement:
    'Same idempotency key and payload have one effect; same key with a different payload is rejected.',
  check(epoch: Epoch) {
    const c = new Collector();
    for (const key of epoch.keys.values()) {
      c.check();
      const acceptedPayloads = [...key.byPayload.values()].filter((g) => g.accepted.length > 0);
      if (acceptedPayloads.length > 1) {
        c.violation(
          `idempotency key ${key.key}`,
          'one accepted payload',
          acceptedPayloads.length,
          `different payloads were accepted under the same key: ${acceptedPayloads.map((g) => g.payload).join(' and ')}`,
          acceptedPayloads[1]?.accepted[0]?.id ?? null,
        );
      }
      for (const group of key.byPayload.values()) {
        if (group.orderIds.size > 1) {
          c.violation(
            `idempotency key ${key.key}`,
            'one order',
            [...group.orderIds],
            `the same key and payload produced ${group.orderIds.size} orders`,
            group.accepted[group.accepted.length - 1]?.id ?? null,
          );
        }
        const firstAccepted = group.accepted[0];
        if (!firstAccepted) continue;
        const rejectedRetry = group.rejected.find((r) => r.index > firstAccepted.index);
        if (rejectedRetry) {
          c.violation(
            `idempotency key ${key.key}`,
            'the original response',
            `status ${rejectedRetry.status}`,
            'a retry with the same payload was rejected after the create had been accepted',
            rejectedRetry.id,
          );
        }
      }
    }
    return c.outcome();
  },
};
