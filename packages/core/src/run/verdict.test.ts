import { describe, expect, it } from 'vitest';
import type { ThresholdResult } from '../thresholds/schema.js';
import {
  EXIT_CODES,
  InconclusiveConditionSchema,
  RUN_LEVEL_INCONCLUSIVE_KINDS,
  decideVerdict,
  exitCodeFor,
} from './verdict.js';

function row(outcome: ThresholdResult['outcome']): ThresholdResult {
  return {
    id: `row.${outcome}`,
    section: 'latency',
    scope: 'overall',
    metric: 'p99_ms',
    limit: 1,
    measured: outcome === 'inconclusive' ? null : 1,
    outcome,
  };
}

describe('decideVerdict', () => {
  it('passes when nothing failed and nothing is inconclusive', () => {
    expect(decideVerdict({ threshold_results: [row('pass')], inconclusive: [] })).toBe('pass');
    expect(decideVerdict({ threshold_results: [], inconclusive: [] })).toBe('pass');
  });

  it('fails on a failed row or an invariant violation', () => {
    expect(decideVerdict({ threshold_results: [row('pass'), row('fail')], inconclusive: [] })).toBe(
      'fail',
    );
    expect(
      decideVerdict({ threshold_results: [], inconclusive: [], invariant_violations: 1 }),
    ).toBe('fail');
  });

  it('lets a run level condition override observed failures', () => {
    for (const kind of RUN_LEVEL_INCONCLUSIVE_KINDS) {
      expect(
        decideVerdict({
          threshold_results: [row('fail')],
          inconclusive: [{ kind, detail: 'x' }],
          invariant_violations: 2,
        }),
      ).toBe('inconclusive');
    }
  });

  it('lets a failed row override insufficient samples', () => {
    expect(
      decideVerdict({
        threshold_results: [row('fail'), row('inconclusive')],
        inconclusive: [{ kind: 'insufficient_samples', detail: 'x' }],
      }),
    ).toBe('fail');
    expect(
      decideVerdict({
        threshold_results: [row('pass'), row('inconclusive')],
        inconclusive: [{ kind: 'insufficient_samples', detail: 'x' }],
      }),
    ).toBe('inconclusive');
    expect(decideVerdict({ threshold_results: [row('inconclusive')], inconclusive: [] })).toBe(
      'inconclusive',
    );
  });

  it('maps verdicts to exit codes', () => {
    expect(exitCodeFor('pass')).toBe(0);
    expect(exitCodeFor('fail')).toBe(2);
    expect(exitCodeFor('inconclusive')).toBe(3);
    expect(EXIT_CODES.error).toBe(1);
  });

  it('rejects unknown condition kinds', () => {
    expect(InconclusiveConditionSchema.safeParse({ kind: 'tired', detail: 'x' }).success).toBe(
      false,
    );
    expect(
      InconclusiveConditionSchema.safeParse({ kind: 'barrier_timeout', detail: '' }).success,
    ).toBe(false);
  });
});
