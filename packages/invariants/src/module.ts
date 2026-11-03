import type { Exchange, InconclusiveCondition } from '@replay-parity/core';
import type { RuleOutcome } from './outcome.js';

/**
 * The invariant module contract. A module turns one system's recording into
 * a stream of commands and checks rules over it. The evaluator owns the
 * report, the merge across epochs, and the validation of every outcome. A
 * module owns what a command means.
 */

/** The fields every command carries, whatever the module. */
export interface BaseCommand {
  /**
   * What the exchange did, in the module's own words. `other` marks an
   * exchange the module ignores, and an accepted `reset` starts a new epoch
   * when the module does not group epochs itself.
   */
  kind: string;
  /** The system acknowledged the command, normally a 2xx response. */
  accepted: boolean;
  /** When the request was sent, in milliseconds from the start of the recording. */
  sentMs: number;
  /** When the response arrived, in milliseconds from the start of the recording. */
  ackedMs: number;
  /** The exchange id, which evidence entries name. */
  id: string;
}

/** One invariant. `check` runs once per epoch and the evaluator merges the outcomes. */
export interface InvariantRule<E = unknown> {
  /** A positive integer, unique within the module. */
  id: number;
  /** A short kebab case name, unique within the module. */
  name: string;
  /** The invariant in one sentence. */
  statement: string;
  check(epoch: E): RuleOutcome;
}

/** The counts the report shows beside the results. */
export interface SnapshotCounts {
  ledger_reads: number;
  stock_reads: number;
  order_reads: number;
}

/** The epoch a module gets when it does not define `epochs`. */
export interface CommandEpoch<C extends BaseCommand = BaseCommand> {
  /** Position of the epoch's first command in the recording. */
  start: number;
  commands: C[];
}

/**
 * What an invariant module exports. `name`, `version`, `parse`, and `rules`
 * are required. The rest are optional hooks with defaults.
 */
export interface InvariantModule<C extends BaseCommand = BaseCommand, E = CommandEpoch<C>> {
  name: string;
  version: string;
  /** Maps one exchange to one command. `index` is the exchange's position in the recording. */
  parse(exchange: Exchange, index: number): C;
  rules: readonly InvariantRule<E>[];
  /** Groups the commands into epochs. Default: a new epoch at every accepted `reset`. */
  epochs?(commands: C[]): E[];
  /** The command kinds the report counts as commands. Default: every kind except `other`. */
  stateChanging?: readonly string[];
  /** Counts for the report's `snapshots`. Default: zeros. */
  snapshots?(commands: readonly C[]): SnapshotCounts;
  /** Conditions that make the whole report inconclusive. Default: none. */
  inconclusive?(commands: readonly C[]): InconclusiveCondition[];
}

/** A module as the evaluator holds it, with the hash of the file it came from when there is one. */
export type LoadedInvariantModule = InvariantModule<BaseCommand, unknown> & {
  sha256?: string | null;
};

/** Splits commands at every accepted `reset`. The reset opens the epoch it starts. */
export function splitAtResets<C extends BaseCommand>(commands: readonly C[]): C[][] {
  const epochs: C[][] = [];
  let current: C[] = [];
  for (const c of commands) {
    if (c.kind === 'reset' && c.accepted && current.length > 0) {
      epochs.push(current);
      current = [];
    }
    current.push(c);
  }
  epochs.push(current);
  return epochs;
}

/** The default grouping: one `CommandEpoch` per run of commands between accepted resets. */
export function defaultEpochs<C extends BaseCommand>(commands: readonly C[]): CommandEpoch<C>[] {
  let start = 0;
  return splitAtResets(commands).map((group) => {
    const epoch = { start, commands: group };
    start += group.length;
    return epoch;
  });
}
