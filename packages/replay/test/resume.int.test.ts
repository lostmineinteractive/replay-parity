import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  parseThresholds,
  type Exchange,
  type ExchangeResult,
  type RecordedRequest,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { readCheckpoint, replay, type Adapter, type ReplayOptions } from '../src/index.js';
import { tempDir, writeRecording } from './helpers.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

const RULES = parseDiffRules(
  'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
);
const THRESHOLDS = parseThresholds('correctness:\n  mismatch_rate_max: 0.1\n');

/**
 * Seven sessions over 3000 exchanges. Every 40th exchange creates an order and the exchange
 * 100 later reads it back by the reference's id, so a read after the checkpoint uses an id
 * captured before it. Every third read of an item answers with a wrong value.
 */
function recording(): Exchange[] {
  return Array.from({ length: 3000 }, (_, i) => {
    const headers = { 'x-session': `s${i % 7}` };
    if (i % 40 === 0) {
      return makeExchange({
        index: i,
        offset_ms: i,
        tags: ['create-order'],
        request: makeRequest({ method: 'POST', path: '/orders', headers, body: { n: i } }),
        response: jsonResponse({ order_id: `r-${i}` }, 201, 1),
      });
    }
    if (i % 40 === 20 && i >= 100) {
      const created = i - 100 - ((i - 100) % 40);
      return makeExchange({
        index: i,
        offset_ms: i,
        tags: ['get-order'],
        request: makeRequest({ path: `/orders/r-${created}`, headers }),
        response: jsonResponse({ order_id: `r-${created}` }, 200, 1),
      });
    }
    return makeExchange({
      index: i,
      offset_ms: i,
      tags: ['item'],
      request: makeRequest({ path: `/items/${i}`, headers }),
      response: jsonResponse({ value: i }, 200, 1),
    });
  });
}

/** Answers every request the same way on every run, so two runs can be compared. */
const candidate: Adapter = {
  name: 'fake',
  async send(req: RecordedRequest, ctx) {
    await sleep(1, undefined, { signal: ctx.signal });
    if (req.method === 'POST') {
      return jsonResponse({ order_id: `c-${(req.body as { n: number }).n}` }, 201, 1);
    }
    if (req.path.startsWith('/orders/')) {
      return jsonResponse({ order_id: req.path.split('/').pop() ?? '' }, 200, 1);
    }
    const i = Number(req.path.split('/').pop());
    return jsonResponse({ value: i % 3 === 0 ? -1 : i }, 200, 1);
  },
};

async function lines(path: string): Promise<ExchangeResult[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ExchangeResult);
}

/** What a run decided, without the timings. */
function decided(r: ExchangeResult) {
  return {
    id: r.id,
    error: r.error,
    candidate: r.candidate?.status ?? null,
    verdict: r.diff?.verdict ?? null,
    findings: r.diff?.findings ?? null,
  };
}

function outcome(run: Run) {
  return {
    verdict: run.verdict,
    inconclusive: run.inconclusive,
    threshold_results: run.threshold_results,
    overall: { ...run.stats.overall, candidate: undefined, histogram: undefined },
    by_tag: Object.fromEntries(
      Object.entries(run.stats.by_tag).map(([tag, t]) => [
        tag,
        [t.count, t.errors, t.matches, t.tolerated, t.mismatches],
      ]),
    ),
    kept: run.exchanges.map(decided),
    selected: run.recording.selected,
  };
}

describe('checkpoint and resume', () => {
  it('resumes a run stopped by a signal and ends equal to a run that was never stopped', async () => {
    const exchanges = recording();
    const whole = await tempDir();
    const options = (dir: string): ReplayOptions => ({
      recording: '',
      target: 'fake://',
      adapter: candidate,
      pace: 'max',
      concurrency: 8,
      sessionKey: 'header:x-session',
      rules: RULES,
      thresholds: THRESHOLDS,
      exchangesPath: join(dir, 'run.exchanges.jsonl'),
      exchangesSidecar: 'always',
      checkpointPath: join(dir, 'run.checkpoint.json'),
    });
    const uninterrupted = await replay({
      ...options(whole),
      recording: await writeRecording(exchanges, whole),
    });
    expect(uninterrupted.inconclusive).toEqual([]);

    const dir = await tempDir();
    const path = await writeRecording(exchanges, dir);
    const controller = new AbortController();
    const stopped = await replay({
      ...options(dir),
      recording: path,
      signal: controller.signal,
      onProgress(p) {
        if (p.completed === 1500) controller.abort();
      },
    });
    expect(stopped.verdict).toBe('inconclusive');
    expect(stopped.inconclusive[0]?.kind).toBe('aborted');
    const checkpoint = await readCheckpoint(join(dir, 'run.checkpoint.json'));
    // The prefix ends where the stop cut it, after at least one periodic checkpoint.
    expect(checkpoint.next_index).toBeGreaterThan(1000);
    expect(checkpoint.next_index).toBeLessThanOrEqual(1500);
    expect(checkpoint.sidecar.lines).toBe(checkpoint.next_index);
    expect(checkpoint.substitutions.order_id?.length).toBeGreaterThan(0);

    const resumed = await replay({ ...options(dir), recording: path, resume: true });
    expect(resumed.run_id).toBe(stopped.run_id);
    expect(outcome(resumed)).toEqual(outcome(uninterrupted));
    expect(resumed.verdict).toBe('fail');
    const all = await lines(join(dir, 'run.exchanges.jsonl'));
    expect(all.map(decided)).toEqual(
      (await lines(join(whole, 'run.exchanges.jsonl'))).map(decided),
    );
    // Reads after the checkpoint used the ids captured before it.
    const late = all.find(
      (r) => r.tags.includes('get-order') && all.indexOf(r) > checkpoint.next_index,
    );
    expect(late?.diff?.verdict).toBe('tolerated');
    // A finished run leaves no checkpoint behind.
    await expect(access(join(dir, 'run.checkpoint.json'))).rejects.toThrow();
    expect(validate(resumed), validate.errors ?? '').toBe(true);
  });

  it('refuses to resume without a checkpoint or for another run', async () => {
    const dir = await tempDir();
    const path = await writeRecording(recording().slice(0, 50), dir);
    const base: ReplayOptions = {
      recording: path,
      target: 'fake://',
      adapter: candidate,
      pace: 'max',
      exchangesPath: join(dir, 'run.exchanges.jsonl'),
      exchangesSidecar: 'always',
      checkpointPath: join(dir, 'run.checkpoint.json'),
      checkpointEvery: 10,
    };
    await expect(replay({ ...base, resume: true })).rejects.toThrow(/--resume: no checkpoint at/);
    const controller = new AbortController();
    await replay({
      ...base,
      signal: controller.signal,
      onProgress(p) {
        if (p.completed === 20) controller.abort();
      },
    });
    await expect(replay({ ...base, resume: true, limit: 40 })).rejects.toThrow(
      /--resume: the checkpoint was written for another run, limit differs/,
    );
    await expect(replay({ ...base, resume: true, target: 'other://' })).rejects.toThrow(
      /target differs/,
    );
    await expect(
      replay({ ...base, resume: true, candidateRecording: join(dir, 'c.jsonl') }),
    ).rejects.toThrow(/cannot write a candidate recording/);
    await expect(replay({ ...base, resume: true, exchangesSidecar: 'never' })).rejects.toThrow(
      /used the exchanges sidecar/,
    );
    const finished = await replay({ ...base, resume: true });
    expect(finished.stats.overall.count + finished.inconclusive.length).toBeGreaterThan(0);
    expect(finished.inconclusive).toEqual([]);
    expect((await lines(join(dir, 'run.exchanges.jsonl'))).length).toBe(50);
  });
});
