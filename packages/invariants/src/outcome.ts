import type { InvariantEvidence, InvariantStatus, JsonValue } from '@replay-parity/core';

/** The most evidence entries one rule reports. A rule counts the rest in its detail. */
export const EVIDENCE_CAP = 25;

/** What a rule's `check` returns for one epoch. */
export interface RuleOutcome {
  status: InvariantStatus;
  checks: number;
  evidence: InvariantEvidence[];
  detail?: string | undefined;
}

/** Collects checks and evidence for one rule over one epoch. */
export class Collector {
  checks = 0;
  inconclusive = 0;
  readonly evidence: InvariantEvidence[] = [];
  private total = 0;
  private readonly notes: string[] = [];

  check(): void {
    this.checks += 1;
  }

  undecided(note: string): void {
    this.inconclusive += 1;
    if (this.notes.length < 3) this.notes.push(note);
  }

  violation(
    subject: string,
    expected: JsonValue,
    observed: JsonValue,
    detail: string,
    exchangeId: string | null,
  ): void {
    this.total += 1;
    if (this.evidence.length < EVIDENCE_CAP) {
      this.evidence.push({ subject, expected, observed, detail, exchange_id: exchangeId });
    }
  }

  outcome(): RuleOutcome {
    if (this.total > 0) {
      const detail =
        this.total > this.evidence.length
          ? `${this.total} violations, first ${this.evidence.length} shown`
          : undefined;
      return { status: 'violated', checks: this.checks, evidence: this.evidence, detail };
    }
    if (this.inconclusive > 0) {
      return {
        status: 'inconclusive',
        checks: this.checks,
        evidence: [],
        detail: `${this.inconclusive} instance${this.inconclusive === 1 ? '' : 's'} could not be decided: ${this.notes.join('; ')}`,
      };
    }
    if (this.checks === 0) {
      return { status: 'not_applicable', checks: 0, evidence: [], detail: 'nothing to check' };
    }
    return { status: 'holds', checks: this.checks, evidence: [] };
  }
}

/** Merges per epoch outcomes of one rule. Violated wins, then inconclusive, then holds. */
export function mergeOutcomes(outcomes: readonly RuleOutcome[]): RuleOutcome {
  const checks = outcomes.reduce((n, o) => n + o.checks, 0);
  const evidence = outcomes.flatMap((o) => o.evidence).slice(0, EVIDENCE_CAP);
  const details = outcomes.map((o) => o.detail).filter((d): d is string => d !== undefined);
  const pick = (status: InvariantStatus): RuleOutcome | undefined =>
    outcomes.find((o) => o.status === status);
  if (pick('violated')) {
    return { status: 'violated', checks, evidence, detail: details[0] };
  }
  if (pick('inconclusive')) {
    return { status: 'inconclusive', checks, evidence: [], detail: details.join('; ') };
  }
  if (checks === 0) {
    return { status: 'not_applicable', checks: 0, evidence: [], detail: 'nothing to check' };
  }
  return { status: 'holds', checks, evidence: [] };
}
