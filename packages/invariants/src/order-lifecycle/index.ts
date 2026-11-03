import type { InconclusiveCondition } from '@replay-parity/core';
import type { InvariantModule, SnapshotCounts } from '../module.js';
import { STATE_CHANGING, parseCommand, type Command } from './commands.js';
import { buildEpochs, type Epoch } from './model.js';
import { RULES } from './rules/index.js';

/**
 * The built in module: the demo's order lifecycle. It parses the demo's
 * routes into commands, rebuilds the expected state from the system's own
 * acknowledgements, and checks the ten rules per epoch.
 */

export const ORDER_LIFECYCLE_NAME = 'order-lifecycle';
export const ORDER_LIFECYCLE_VERSION = '1.0.0';

/**
 * The completion check. The final ledger read is the snapshot the run ends
 * on. A state changing command that was sent before that read and
 * acknowledged after it was in flight when the snapshot was taken, so the
 * snapshot may not reflect it.
 */
export function snapshotBeforeAck(commands: readonly Command[]): InconclusiveCondition | null {
  let final: Command | null = null;
  for (const c of commands) if (c.kind === 'read-ledger' && c.accepted) final = c;
  if (final === null) return null;
  const snapshot = final;
  const inFlight = commands.filter(
    (c) =>
      STATE_CHANGING.has(c.kind) &&
      c.accepted &&
      c.sentMs < snapshot.sentMs &&
      c.ackedMs > snapshot.sentMs,
  );
  if (inFlight.length === 0) return null;
  return {
    kind: 'snapshot_before_ack',
    detail: `the final ledger read ${snapshot.id} was sent while ${inFlight.length} accepted command${inFlight.length === 1 ? ' was' : 's were'} still in flight: ${inFlight
      .slice(0, 5)
      .map((c) => c.id)
      .join(', ')}`,
  };
}

function snapshotCounts(commands: readonly Command[]): SnapshotCounts {
  return {
    ledger_reads: commands.filter((c) => c.kind === 'read-ledger' && c.accepted).length,
    stock_reads: commands.filter(
      (c) => (c.kind === 'read-ledger' || c.kind === 'read-inventory') && c.accepted,
    ).length,
    order_reads: commands.filter((c) => c.kind === 'read-order').length,
  };
}

export const orderLifecycle: InvariantModule<Command, Epoch> = {
  name: ORDER_LIFECYCLE_NAME,
  version: ORDER_LIFECYCLE_VERSION,
  parse: parseCommand,
  rules: RULES,
  epochs: buildEpochs,
  stateChanging: [...STATE_CHANGING],
  snapshots: snapshotCounts,
  inconclusive(commands) {
    const completion = snapshotBeforeAck(commands);
    return completion === null ? [] : [completion];
  },
};
