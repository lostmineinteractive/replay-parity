import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CaptureServer, parseTagRule } from '@replay-parity/capture';
import { loadDiffRules, loadThresholds, readRecording } from '@replay-parity/core';
import { buildApp as buildCandidate, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import { replay } from '@replay-parity/replay';
import { renderHtml, renderTerminal } from '@replay-parity/report';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TAG_RULES, runLoad } from '../src/index.js';

/**
 * The demo without Docker: reference and candidates in process, the capture
 * proxy, the load generator, the replay, and the renderers, with the demo's
 * own rules and thresholds files.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const closers: (() => Promise<void>)[] = [];
let recording: string;

async function listen(app: ReturnType<typeof buildReference>): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function candidate(divergences: DivergenceSetting): Promise<string> {
  return listen(buildCandidate({ divergences, seed: 1 }));
}

beforeAll(async () => {
  const referenceUrl = await listen(buildReference());
  const dir = await mkdtemp(join(tmpdir(), 'rp-demo-'));
  recording = join(dir, 'recording.jsonl');
  const capture = await CaptureServer.create({
    target: referenceUrl,
    out: recording,
    append: false,
    tagRules: DEMO_TAG_RULES.map(parseTagRule),
  });
  const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
  const summary = await runLoad({
    target: `http://127.0.0.1:${addr.port}`,
    seed: 7,
    backgroundPerBlock: 6,
    minGapMs: 1,
    maxGapMs: 3,
  });
  await capture.close();
  expect(summary.sent).toBeGreaterThan(100);
  expect((await readRecording(recording)).length).toBe(summary.sent);
}, 60_000);

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
});

async function demoReplay(target: string, rulesFile: string) {
  return replay({
    recording,
    target,
    pace: 'max',
    concurrency: 1,
    rules: await loadDiffRules(join(ROOT, 'demo', rulesFile)),
    thresholds: await loadThresholds(join(ROOT, 'demo/thresholds.yaml')),
    barrierTags: ['list-ledger'],
    invariants: true,
  });
}

describe('the demo flow in process', () => {
  it('fails on the classic candidate under the demo rules and names the four divergences', async () => {
    const run = await demoReplay(await candidate('on'), 'diff-rules.yaml');
    expect(run.verdict).toBe('fail');
    const failed = run.threshold_results.filter((r) => r.outcome === 'fail').map((r) => r.id);
    expect(failed).toContain('latency.by_tag.adjust-stock.p99_ms');
    expect(failed).toContain('correctness.by_tag.create-order.mismatch_rate_max');
    expect(failed).toContain('correctness.by_tag.get-order.mismatch_rate_max');
    expect(failed).toContain('correctness.by_tag.list-inventory.mismatch_rate_max');
    expect(run.invariants.reference?.violations).toBe(0);
    expect(run.invariants.candidate?.violations).toBe(0);
    const html = renderHtml(run);
    expect(html).toContain('class="badge fail">FAIL<');
    expect(renderTerminal(run)).toContain(': FAIL');
  }, 60_000);

  it('tolerates the ordering divergence under the unordered rules and still fails on the other three', async () => {
    const run = await demoReplay(await candidate('on'), 'diff-rules-unordered.yaml');
    expect(run.verdict).toBe('fail');
    expect(run.stats.by_tag['list-inventory']?.mismatches).toBe(0);
    expect(
      run.threshold_results.find(
        (r) => r.id === 'correctness.by_tag.list-inventory.mismatch_rate_max',
      )?.outcome,
    ).toBe('pass');
  }, 60_000);

  it('passes on the clean pair with every invariant holding on both sides', async () => {
    const run = await demoReplay(await candidate('off'), 'diff-rules.yaml');
    expect(run.verdict).toBe('pass');
    expect(run.inconclusive).toEqual([]);
    expect(run.stats.overall.mismatches).toBe(0);
    expect(run.threshold_results.every((r) => r.outcome === 'pass')).toBe(true);
    for (const system of ['reference', 'candidate'] as const) {
      expect(run.invariants[system]?.results.every((r) => r.status !== 'violated')).toBe(true);
      expect(run.invariants[system]?.results.filter((r) => r.status === 'holds').length).toBe(10);
    }
  }, 60_000);

  it('catches the default seeded defect through the invariants', async () => {
    const run = await demoReplay(await candidate(['shipment-applied-twice']), 'diff-rules.yaml');
    expect(run.verdict).toBe('fail');
    expect(
      run.invariants.candidate?.results.find((r) => r.name === 'shipment-applied-once')?.status,
    ).toBe('violated');
    expect(
      run.threshold_results.find((r) => r.id === 'invariants.candidate.violations')?.outcome,
    ).toBe('fail');
  }, 60_000);
});
