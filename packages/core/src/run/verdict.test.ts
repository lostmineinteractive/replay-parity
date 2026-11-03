import { describe, expect, it } from 'vitest';
import type { ThresholdResult } from '../thresholds/schema.js';
import {
  EXIT_CODES,
  InconclusiveConditionSchema,
  RUN_LEVEL_INCONCLUSIVE_KINDS,
  decideVerdict,
  exitCodeFor,
  isTolerated,
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
  it('passes when every inconclusive row is covered by a tolerated condition', () => {
    const thin = row('inconclusive');
    const tolerated = {
      kind: 'insufficient_samples' as const,
      detail: `${thin.id}: 3 successful samples, minimum 20`,
      tolerated: true as const,
    };
    expect(
      decideVerdict({ threshold_results: [row('pass'), thin], inconclusive: [tolerated] }),
    ).toBe('pass');
    // A row with no tolerated condition naming it still makes the run inconclusive.
    const other = { ...thin, id: 'row.other' };
    expect(decideVerdict({ threshold_results: [thin, other], inconclusive: [tolerated] })).toBe(
      'inconclusive',
    );
    // An untolerated condition beside a tolerated one keeps the run inconclusive.
    expect(
      decideVerdict({
        threshold_results: [thin],
        inconclusive: [tolerated, { kind: 'insufficient_samples', detail: 'x: y' }],
      }),
    ).toBe('inconclusive');
    // A failed row still fails.
    expect(
      decideVerdict({ threshold_results: [thin, row('fail')], inconclusive: [tolerated] }),
    ).toBe('fail');
  });

  it('never tolerates a run level condition', () => {
    for (const kind of RUN_LEVEL_INCONCLUSIVE_KINDS) {
      const condition = { kind, detail: 'x', tolerated: true as const };
      expect(isTolerated(condition)).toBe(false);
      expect(decideVerdict({ threshold_results: [], inconclusive: [condition] })).toBe(
        'inconclusive',
      );
    }
    expect(isTolerated({ kind: 'insufficient_samples', detail: 'x', tolerated: true })).toBe(true);
    expect(isTolerated({ kind: 'insufficient_samples', detail: 'x' })).toBe(false);
  });

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

  it('treats a stop by signal as a run level condition', () => {
    expect(InconclusiveConditionSchema.safeParse({ kind: 'aborted', detail: 'x' }).success).toBe(
      true,
    );
    expect(RUN_LEVEL_INCONCLUSIVE_KINDS.has('aborted')).toBe(true);
    expect(
      decideVerdict({
        threshold_results: [row('fail')],
        inconclusive: [{ kind: 'aborted', detail: 'stopped by signal after 3 of 10 exchanges' }],
      }),
    ).toBe('inconclusive');
    expect(
      exitCodeFor(
        decideVerdict({ threshold_results: [], inconclusive: [{ kind: 'aborted', detail: 'x' }] }),
      ),
    ).toBe(3);
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
