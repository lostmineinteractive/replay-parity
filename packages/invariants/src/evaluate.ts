import type {
  Exchange,
  InconclusiveCondition,
  InvariantReport,
  InvariantResult,
} from '@replay-parity/core';
import { STATE_CHANGING, parseCommands, type Command } from './commands.js';
import { buildEpochs } from './model.js';
import { RULES, mergeOutcomes } from './rules/index.js';

export interface EvaluateOptions {
  /** Label for the report, normally `reference` or `candidate`. */
  system?: string | undefined;
  /** Path of the recording, for the report. */
  recording?: string | undefined;
}

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

/** Evaluates the ten invariants against one system's recording. */
export function evaluateInvariants(
  exchanges: readonly Exchange[],
  options: EvaluateOptions = {},
): InvariantReport {
  const commands = parseCommands(exchanges);
  const epochs = buildEpochs(commands);
  const results: InvariantResult[] = RULES.map((rule) => {
    const merged = mergeOutcomes(epochs.map((epoch) => rule.check(epoch)));
    const result: InvariantResult = {
      id: rule.id,
      name: rule.name,
      statement: rule.statement,
      status: merged.status,
      checks: merged.checks,
      evidence: merged.evidence,
    };
    if (merged.detail !== undefined) result.detail = merged.detail;
    return result;
  });
  const inconclusive: InconclusiveCondition[] = [];
  const completion = snapshotBeforeAck(commands);
  if (completion) inconclusive.push(completion);
  return {
    system: options.system ?? 'system',
    recording: options.recording ?? '',
    exchanges: exchanges.length,
    commands: commands.filter((c) => STATE_CHANGING.has(c.kind)).length,
    snapshots: {
      ledger_reads: commands.filter((c) => c.kind === 'read-ledger' && c.accepted).length,
      stock_reads: commands.filter(
        (c) => (c.kind === 'read-ledger' || c.kind === 'read-inventory') && c.accepted,
      ).length,
      order_reads: commands.filter((c) => c.kind === 'read-order').length,
    },
    results,
    violations: results.filter((r) => r.status === 'violated').length,
    inconclusive,
  };
}
