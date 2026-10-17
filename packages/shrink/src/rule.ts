import {
  ConfigError,
  RUN_LEVEL_INCONCLUSIVE_KINDS,
  type Run,
  type Finding,
} from '@replay-parity/core';

/** The failing rule a reproduction is judged by. */
export type ShrinkRule =
  | {
      kind: 'invariant';
      system: 'reference' | 'candidate';
      name: string;
      /** The exchange that witnessed the violation, when known. Steps after it are dropped first. */
      witness?: string | undefined;
    }
  | { kind: 'mismatch'; exchangeId: string; path?: string | undefined };

export function formatRule(rule: ShrinkRule): string {
  if (rule.kind === 'invariant') return `invariant:${rule.system}:${rule.name}`;
  return rule.path === undefined
    ? `mismatch:${rule.exchangeId}`
    : `mismatch:${rule.exchangeId}:${rule.path}`;
}

/** Parses `invariant:<system>:<name>` or `mismatch:<exchange id>[:<path>]`. */
export function parseRule(text: string): ShrinkRule {
  const parts = text.split(':');
  if (parts[0] === 'invariant' && parts.length === 3) {
    const system = parts[1];
    const name = parts[2] as string;
    if ((system !== 'reference' && system !== 'candidate') || name.length === 0) {
      throw new ConfigError(
        `rule ${JSON.stringify(text)}: expected invariant:<reference|candidate>:<name>`,
      );
    }
    return { kind: 'invariant', system, name };
  }
  if (parts[0] === 'mismatch' && parts.length >= 2 && (parts[1] as string).length > 0) {
    const exchangeId = parts[1] as string;
    const path = parts.length > 2 ? parts.slice(2).join(':') : undefined;
    return path === undefined
      ? { kind: 'mismatch', exchangeId }
      : { kind: 'mismatch', exchangeId, path };
  }
  throw new ConfigError(
    `rule ${JSON.stringify(text)}: expected invariant:<system>:<name> or mismatch:<exchange id>[:<path>]`,
  );
}

/** The first violated invariant, candidate first, else the first mismatching exchange. */
export function defaultRule(run: Run): ShrinkRule | null {
  for (const system of ['candidate', 'reference'] as const) {
    const violated = run.invariants[system]?.results.find((r) => r.status === 'violated');
    if (violated) {
      const witness = violated.evidence[0]?.exchange_id ?? undefined;
      return witness === undefined
        ? { kind: 'invariant', system, name: violated.name }
        : { kind: 'invariant', system, name: violated.name, witness };
    }
  }
  const mismatch = run.exchanges.find((e) => !e.control && e.diff?.verdict === 'mismatch');
  if (mismatch) {
    const first = mismatch.diff?.findings.find((f: Finding) => !f.tolerated);
    return first === undefined
      ? { kind: 'mismatch', exchangeId: mismatch.id }
      : { kind: 'mismatch', exchangeId: mismatch.id, path: first.path };
  }
  return null;
}

/** The exchange that must stay in every reduction, when the rule names one. */
export function witnessOf(rule: ShrinkRule): string | undefined {
  return rule.kind === 'invariant' ? rule.witness : rule.exchangeId;
}

/** Whether a replayed attempt still trips the rule. An inconclusive attempt never counts. */
export function reproduces(run: Run, rule: ShrinkRule): boolean {
  if (run.inconclusive.some((c) => RUN_LEVEL_INCONCLUSIVE_KINDS.has(c.kind))) return false;
  if (rule.kind === 'invariant') {
    const result = run.invariants[rule.system]?.results.find((r) => r.name === rule.name);
    return result?.status === 'violated';
  }
  const exchange = run.exchanges.find((e) => e.id === rule.exchangeId);
  if (exchange?.diff?.verdict !== 'mismatch') return false;
  if (rule.path === undefined) return true;
  const path = rule.path;
  return exchange.diff.findings.some((f) => !f.tolerated && f.path === path);
}
