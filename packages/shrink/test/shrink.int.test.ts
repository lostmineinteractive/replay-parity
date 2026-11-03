import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  compileRunValidator,
  parseDiffRules,
  parseRecordingText,
  readRecording,
  type Exchange,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { replayExchanges } from '@replay-parity/replay';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultRule, reproduces, shrink, type ShrinkRule } from '../src/index.js';

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
let recording: Exchange[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
  recording = await readRecording(RECORDING);
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function candidate(divergences: DivergenceSetting): Promise<string> {
  const app = buildApp({ divergences, seed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

const resetter = (url: string) => async (): Promise<void> => {
  const res = await fetch(`${url}/admin/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`reset failed with ${res.status}`);
};

async function failingRun(url: string): Promise<Run> {
  await resetter(url)();
  return replayExchanges(recording, {
    recording: RECORDING,
    target: url,
    pace: 'max',
    concurrency: 1,
    rules: RULES,
    invariants: true,
  });
}

describe('shrink', () => {
  it('reduces the duplicate shipment defect to a few steps that still trip the invariant', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    expect(rule).toMatchObject({
      kind: 'invariant',
      system: 'candidate',
      name: 'shipment-applied-once',
    });
    const dir = await mkdtemp(join(tmpdir(), 'rp-shrink-'));
    const out = join(dir, 'reduced-reproduction.jsonl');
    const events: string[] = [];
    const { reproduction, exchanges } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
      out,
      onAttempt: (e) => events.push(`${e.phase}:${e.steps}:${e.reproduced ? 'y' : 'n'}`),
    });
    expect(reproduction.successful).toBe(true);
    expect(reproduction.label).toBe('reduced reproduction');
    expect(reproduction.rule).toBe('invariant:candidate:shipment-applied-once');
    expect(reproduction.original_steps).toBe(283);
    expect(reproduction.reduced_steps).toBeLessThanOrEqual(5);
    expect(reproduction.reduced_steps).toBe(exchanges.length);
    expect(reproduction.attempts).toBeGreaterThan(1);
    expect(reproduction.attempts).toBeLessThanOrEqual(64);
    expect(reproduction.recording).toBe(out);
    expect(events[0]).toMatch(/^confirm:\d+:y$/);

    const methods = reproduction.steps.map((s) => `${s.method} ${s.path.replace(/o-\d+/, 'o-N')}`);
    expect(methods[0]).toBe('POST /v1/orders');
    const shipments = reproduction.steps.filter((s) => s.path.endsWith('/shipments'));
    expect(shipments).toHaveLength(2);
    expect(shipments[0]?.body).toMatchObject({ shipment_id: expect.any(String) as string });
    expect((shipments[0]?.body as { shipment_id: string }).shipment_id).toBe(
      (shipments[1]?.body as { shipment_id: string }).shipment_id,
    );
    expect(reproduction.steps.some((s) => s.quantity_reduced)).toBe(true);

    // The written recording replays on a reset candidate and still trips the rule.
    const written = parseRecordingText(await readFile(out, 'utf8'));
    expect(written.map((e) => e.id)).toEqual(exchanges.map((e) => e.id));
    await resetter(url)();
    const again = await replayExchanges(written, {
      target: url,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      invariants: true,
    });
    expect(reproduces(again, rule)).toBe(true);
    expect(validate({ ...run, reproduction }), validate.errors ?? '').toBe(true);
  }, 60_000);

  it('reduces the dropped pre cancel shipment to create, cancel, and shipment', async () => {
    const url = await candidate(['drop-late-precancel-shipment']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    expect(rule).toMatchObject({ kind: 'invariant', name: 'remaining-arithmetic' });
    const { reproduction } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
    });
    expect(reproduction.successful).toBe(true);
    expect(reproduction.steps.map((s) => s.method + ' ' + s.path.replace(/o-\d+/, 'o-N'))).toEqual([
      'POST /v1/orders',
      'POST /v1/orders/o-N/cancel',
      'POST /v1/orders/o-N/shipments',
    ]);
  }, 60_000);

  it('reduces a response mismatch to the single exchange that shows it', async () => {
    const url = await candidate(['rounding-half-even']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    expect(rule).toMatchObject({ kind: 'mismatch', path: '$.total' });
    const { reproduction } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
    });
    expect(reproduction.successful).toBe(true);
    expect(reproduction.reduced_steps).toBe(1);
    expect(reproduction.steps[0]).toMatchObject({
      method: 'POST',
      path: '/v1/orders',
      quantity_reduced: false,
    });
  }, 60_000);

  it('keeps the original and says so when the rule does not reproduce', async () => {
    const url = await candidate('off');
    const { reproduction, exchanges } = await shrink({
      exchanges: recording.slice(0, 30),
      target: url,
      reset: resetter(url),
      rule: { kind: 'invariant', system: 'candidate', name: 'receivables' },
      replay: { rules: RULES },
    });
    expect(reproduction).toMatchObject({
      successful: false,
      label: 'reduction unsuccessful',
      attempts: 1,
      original_steps: 30,
      reduced_steps: 30,
      recording: null,
    });
    expect(exchanges).toHaveLength(30);
    expect(reproduction.steps).toHaveLength(30);
  });

  it('stops at the attempt budget and keeps the best reduction so far', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    const { reproduction } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
      maxAttempts: 2,
    });
    expect(reproduction.attempts).toBe(2);
    // The witness truncation alone is a reduction, confirmed by the first attempt.
    expect(reproduction.successful).toBe(true);
    expect(reproduction.reduced_steps).toBeLessThan(283);
    expect(reproduction.reduced_steps).toBeGreaterThan(5);
  });

  it('stops on a signal after the attempt in progress and keeps the best reduction so far', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), 'rp-shrink-'));
    const out = join(dir, 'reduced-reproduction.jsonl');
    const { reproduction, aborted } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
      out,
      onAttempt: () => controller.abort(),
      signal: controller.signal,
    });
    expect(aborted).toBe(true);
    expect(reproduction.attempts).toBe(1);
    // The witness truncation was confirmed by the first attempt and is kept.
    expect(reproduction.successful).toBe(true);
    expect(reproduction.reduced_steps).toBeLessThan(283);
    expect(reproduction.recording).toBe(out);
    expect(parseRecordingText(await readFile(out, 'utf8'))).toHaveLength(
      reproduction.reduced_steps,
    );

    // A signal that is already aborted spends no attempt.
    const none = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
      signal: AbortSignal.abort(),
    });
    expect(none.aborted).toBe(true);
    expect(none.reproduction).toMatchObject({ attempts: 0, successful: false, reduced_steps: 283 });
    const done = await shrink({
      exchanges: recording.slice(0, 30),
      target: url,
      reset: resetter(url),
      rule: { kind: 'invariant', system: 'candidate', name: 'receivables' },
      replay: { rules: RULES },
      signal: new AbortController().signal,
    });
    expect(done.aborted).toBe(false);
  }, 60_000);

  it('stops at the time budget', async () => {
    const url = await candidate(['shipment-applied-twice']);
    const run = await failingRun(url);
    const rule = defaultRule(run) as ShrinkRule;
    let tick = 0;
    const { reproduction } = await shrink({
      exchanges: recording,
      target: url,
      reset: resetter(url),
      rule,
      replay: { rules: RULES },
      timeBudgetMs: 5,
      now: () => (tick += 10),
    });
    expect(reproduction.attempts).toBe(0);
    expect(reproduction.successful).toBe(false);
    expect(reproduction.reduced_steps).toBe(283);
  });

  it('runs the chunks of a round on two demo candidates with the same result and attempt count', async () => {
    const first = await candidate(['drop-late-precancel-shipment']);
    const second = await candidate(['drop-late-precancel-shipment']);
    const run = await failingRun(first);
    const rule = defaultRule(run) as ShrinkRule;
    const single = await shrink({
      exchanges: recording,
      target: first,
      reset: resetter(first),
      rule,
      replay: { rules: RULES },
    });
    expect(single.speculative).toBe(0);
    const both = await shrink({
      exchanges: recording,
      target: first,
      reset: resetter(first),
      extraTargets: [{ target: second, reset: resetter(second) }],
      rule,
      replay: { rules: RULES },
    });
    expect(both.reproduction.steps).toEqual(single.reproduction.steps);
    expect(both.reproduction.attempts).toBe(single.reproduction.attempts);
    expect(both.exchanges.map((e) => e.id)).toEqual(single.exchanges.map((e) => e.id));
    expect(both.reproduction.reduced_steps).toBe(3);
  }, 60_000);
});
