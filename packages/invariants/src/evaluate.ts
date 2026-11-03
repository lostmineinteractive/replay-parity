import {
  ConfigError,
  InconclusiveConditionSchema,
  InvariantResultSchema,
  formatZodError,
  type Exchange,
  type InconclusiveCondition,
  type InvariantReport,
  type InvariantResult,
} from '@replay-parity/core';
import { defaultEpochs, type BaseCommand, type LoadedInvariantModule } from './module.js';
import { orderLifecycle } from './order-lifecycle/index.js';
import { mergeOutcomes, type RuleOutcome } from './outcome.js';

export interface EvaluateOptions {
  /** Label for the report, normally `reference` or `candidate`. */
  system?: string | undefined;
  /** Path of the recording, for the report. */
  recording?: string | undefined;
  /** The module whose rules run. Default: the built in `order-lifecycle` module. */
  module?: LoadedInvariantModule | undefined;
}

/** What one `check` call must return. */
const OutcomeSchema = InvariantResultSchema.pick({
  status: true,
  checks: true,
  evidence: true,
  detail: true,
});

function failure(module: LoadedInvariantModule, what: string, e: unknown): ConfigError {
  return new ConfigError(
    `invariant module ${module.name}: ${what} failed: ${e instanceof Error ? e.message : String(e)}`,
  );
}

function runRule(
  module: LoadedInvariantModule,
  rule: LoadedInvariantModule['rules'][number],
  epochs: readonly unknown[],
): InvariantResult {
  let outcomes: RuleOutcome[];
  try {
    outcomes = epochs.map((epoch) => rule.check(epoch));
  } catch (e) {
    throw failure(module, `rule ${rule.id} (${rule.name})`, e);
  }
  for (const outcome of outcomes) {
    const parsed = OutcomeSchema.safeParse(outcome);
    if (!parsed.success) {
      throw new ConfigError(
        `invariant module ${module.name}: rule ${rule.id} (${rule.name}) returned a malformed outcome: ${formatZodError(parsed.error)}`,
      );
    }
  }
  const merged = mergeOutcomes(outcomes);
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
}

/** Evaluates the rules of one invariant module against one system's recording. */
export function evaluateInvariants(
  exchanges: readonly Exchange[],
  options: EvaluateOptions = {},
): InvariantReport {
  const module: LoadedInvariantModule = options.module ?? orderLifecycle;
  let commands: BaseCommand[];
  try {
    commands = exchanges.map((e, i) => module.parse(e, i));
  } catch (e) {
    throw failure(module, 'parse', e);
  }
  let epochs: unknown[];
  try {
    epochs = module.epochs ? module.epochs(commands) : defaultEpochs(commands);
  } catch (e) {
    throw failure(module, 'epochs', e);
  }
  const results = module.rules.map((rule) => runRule(module, rule, epochs));
  let inconclusive: InconclusiveCondition[];
  try {
    inconclusive = module.inconclusive?.(commands) ?? [];
  } catch (e) {
    throw failure(module, 'inconclusive', e);
  }
  for (const c of inconclusive) {
    const parsed = InconclusiveConditionSchema.safeParse(c);
    if (!parsed.success) {
      throw new ConfigError(
        `invariant module ${module.name}: inconclusive returned a malformed condition: ${formatZodError(parsed.error)}`,
      );
    }
  }
  const counted = module.stateChanging === undefined ? null : new Set<string>(module.stateChanging);
  return {
    system: options.system ?? 'system',
    recording: options.recording ?? '',
    module: { name: module.name, version: module.version, sha256: module.sha256 ?? null },
    exchanges: exchanges.length,
    commands: commands.filter((c) => (counted === null ? c.kind !== 'other' : counted.has(c.kind)))
      .length,
    snapshots: module.snapshots?.(commands) ?? { ledger_reads: 0, stock_reads: 0, order_reads: 0 },
    results,
    violations: results.filter((r) => r.status === 'violated').length,
    inconclusive,
  };
}
