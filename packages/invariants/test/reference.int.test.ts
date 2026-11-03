import { resolve } from 'node:path';
import { readRecording } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { evaluateInvariants } from '../src/index.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');

describe('the committed reference recording', () => {
  it('holds every invariant with nothing inconclusive', async () => {
    const exchanges = await readRecording(RECORDING);
    const report = evaluateInvariants(exchanges, { system: 'reference', recording: RECORDING });
    expect(report.exchanges).toBe(283);
    expect(report.module).toEqual({ name: 'order-lifecycle', version: '1.0.0', sha256: null });
    expect(report.inconclusive).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status, r.evidence.length])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 1, 'holds', 0]),
    );
    expect(report.violations).toBe(0);
    expect(report.results.every((r) => r.checks > 0)).toBe(true);
    expect(report.snapshots.ledger_reads).toBe(16);
  });
});
