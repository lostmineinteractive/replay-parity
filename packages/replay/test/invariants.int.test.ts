import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  compileRunValidator,
  parseDiffRules,
  parseThresholds,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import {
  buildApp,
  type DivergenceName,
  type DivergenceSetting,
} from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { replay } from '../src/index.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');
const RULES = parseDiffRules(`
ignore: ["$.created_at"]
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`);

let validate: RunValidator;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function runWith(divergences: DivergenceSetting): Promise<Run> {
  const app = buildApp({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const dir = await mkdtemp(join(tmpdir(), 'rp-inv-'));
  return replay({
    recording: RECORDING,
    target: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    pace: 'max',
    concurrency: 1,
    rules: RULES,
    thresholds: parseThresholds('correctness:\n  mismatch_rate_max: 0\n'),
    candidateRecording: join(dir, 'candidate.jsonl'),
    invariants: true,
  });
}

function violated(run: Run, system: 'reference' | 'candidate'): string[] {
  return (run.invariants[system]?.results ?? [])
    .filter((r) => r.status === 'violated')
    .map((r) => r.name);
}

describe('invariants on both systems through the engine', () => {
  it('hold on the clean pair and fill the run section', async () => {
    const run = await runWith('off');
    expect(run.verdict).toBe('pass');
    expect(run.candidate_recording).toMatch(/candidate\.jsonl$/);
    expect(run.invariants.reference?.system).toBe('reference');
    expect(run.invariants.candidate?.system).toBe('candidate');
    expect(run.invariants.candidate?.recording).toBe(run.candidate_recording);
    expect(run.invariants.candidate?.exchanges).toBe(283);
    expect(violated(run, 'reference')).toEqual([]);
    expect(violated(run, 'candidate')).toEqual([]);
    expect(run.invariants.candidate?.inconclusive).toEqual([]);
    expect(run.threshold_results.map((r) => [r.id, r.outcome])).toEqual([
      ['correctness.mismatch_rate_max', 'pass'],
      ['invariants.reference.violations', 'pass'],
      ['invariants.candidate.violations', 'pass'],
    ]);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('is off by default', async () => {
    const app = buildApp({ divergences: 'off' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const run = await replay({
      recording: RECORDING,
      target: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      limit: 20,
    });
    expect(run.invariants).toEqual({ reference: null, candidate: null });
    expect(run.candidate_recording).toBeNull();
    expect(run.threshold_results).toEqual([]);
  });

  const expectations: Partial<Record<DivergenceName, string[]>> = {
    'shipment-applied-twice': ['shipment-applied-once', 'stock-on-hand', 'receivables'],
    'quantity-as-additional': ['shipped-within-quantity', 'remaining-arithmetic'],
    'drop-late-precancel-shipment': ['remaining-arithmetic'],
    'idempotency-lost-on-restart': ['idempotency-key', 'retry-no-reset'],
  };

  for (const defect of Object.keys(expectations) as DivergenceName[]) {
    const names = expectations[defect] ?? [];
    it(`catch ${defect} on the candidate only`, async () => {
      const run = await runWith([defect]);
      expect(violated(run, 'reference')).toEqual([]);
      const found = violated(run, 'candidate');
      for (const name of names) expect(found).toContain(name);
      expect(run.verdict).toBe('fail');
      expect(
        run.threshold_results.find((r) => r.id === 'invariants.candidate.violations'),
      ).toMatchObject({ outcome: 'fail', measured: found.length });
      const first = run.invariants.candidate?.results.find((r) => r.name === names[0]);
      expect(first?.evidence.length).toBeGreaterThan(0);
      expect(first?.evidence[0]?.exchange_id).toBeTruthy();
      expect(validate(run), validate.errors ?? '').toBe(true);
    });
  }

  it('reports violations without gating when fail_on_violation is false', async () => {
    const app = buildApp({ divergences: ['shipment-applied-twice'] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const run = await replay({
      recording: RECORDING,
      target: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      thresholds: parseThresholds('invariants:\n  fail_on_violation: false\n'),
      invariants: true,
    });
    expect(violated(run, 'candidate').length).toBeGreaterThan(0);
    expect(run.verdict).toBe('pass');
    expect(
      run.threshold_results.find((r) => r.id === 'invariants.candidate.violations'),
    ).toMatchObject({
      outcome: 'pass',
      detail: 'reported, not gated',
    });
  });
});
