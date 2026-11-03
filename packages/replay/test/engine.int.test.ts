import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  REDACTED,
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  parseRecordingText,
  parseThresholds,
  readRecording,
  type Exchange,
  type RecordedRequest,
  type RecordedResponse,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import {
  HttpAdapter,
  dropRedactedQuery,
  replay,
  type Adapter,
  type ReplayContext,
  type ReplayOptions,
} from '../src/index.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');

const STRICT_RULES = `
ignore:
  - "$.created_at"
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`;

const UNORDERED_RULES = `${STRICT_RULES}
unordered:
  - path: "$.items"
    key: "$.sku"
`;

let validate: RunValidator;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function startCandidate(
  divergences: DivergenceSetting,
  seed = 1,
): Promise<{ url: string; app: ReturnType<typeof buildApp> }> {
  const app = buildApp({ divergences, seed });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  return { url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, app };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-replay-'));
}

async function writeRecording(exchanges: Exchange[]): Promise<string> {
  const path = join(await tempDir(), 'recording.jsonl');
  await writeFile(path, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

function demoRun(url: string, over: Partial<ReplayOptions> = {}): Promise<Run> {
  return replay({
    recording: RECORDING,
    target: url,
    pace: 'max',
    concurrency: 1,
    rules: parseDiffRules(STRICT_RULES),
    ...over,
  });
}

function byTag(run: Run, tag: string) {
  return run.exchanges.filter((e) => e.tags.includes(tag));
}

/**
 * Logs why an attempt of a retried timing test failed, with the pacing fields of its run, so a
 * retry is never silent in the output. The hook runs after each failed attempt.
 */
function logFailedAttempt(run: Run): void {
  onTestFailed(({ task }) => {
    const errors = task.result?.errors ?? [];
    const timeline = run.exchanges
      .map((e) => `${e.scheduled_at_ms}/${e.sent_at_ms}/${e.acked_at_ms ?? '-'}`)
      .join(' ');
    console.error(
      `attempt failed: ${errors[errors.length - 1]?.message ?? 'no error recorded'}\n` +
        `pacing ${JSON.stringify(run.pacing)} duration_ms ${run.duration_ms}\n` +
        `scheduled/sent/acked ${timeline}`,
    );
  });
}

/** Wraps an adapter so tests can slow down or rewrite selected responses. */
class Shim implements Adapter {
  readonly name: string;
  constructor(
    private readonly inner: Adapter,
    private readonly hook: (
      req: RecordedRequest,
      ctx: ReplayContext,
      next: () => Promise<RecordedResponse>,
    ) => Promise<RecordedResponse>,
  ) {
    this.name = inner.name;
  }
  send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse> {
    return this.hook(req, ctx, () => this.inner.send(req, ctx));
  }
  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

describe('replay against the candidate with divergences off', () => {
  // Retried because the latency row below is judged on a candidate that runs in this process,
  // where stalls of 7 to 10 s were observed when other suites ran at the same time on a shared
  // machine, and a stall is measured as candidate latency.
  it(
    'passes with zero mismatches, flags the control, and writes a valid run and candidate recording',
    { retry: 2 },
    async () => {
      const { url } = await startCandidate('off');
      const dir = await tempDir();
      const candidateRecording = join(dir, 'candidate.jsonl');
      // The latency limit is generous: a quiet machine measures a candidate p99 under 1 ms. The row
      // is here to prove that the latency section is evaluated and reported in order.
      const run = await demoRun(url, {
        candidateRecording,
        headers: { authorization: 'Bearer replay-token' },
        thresholds: parseThresholds(
          'correctness:\n  mismatch_rate_max: 0\nerrors:\n  rate_max: 0\nlatency:\n  min_samples: 20\n  overall: { p99_ms: 2000 }\npacing:\n  slip_max_ms: 250\n',
        ),
      });
      logFailedAttempt(run);

      expect(run.verdict).toBe('pass');
      expect(run.inconclusive).toEqual([]);
      expect(run.recording).toMatchObject({ exchanges: 283, selected: 283 });
      expect(run.stats.overall.mismatches).toBe(0);
      expect(run.stats.overall.errors).toBe(0);
      expect(run.stats.overall.count).toBe(282);
      expect(run.exchanges).toHaveLength(283);
      expect(validate(run), validate.errors ?? '').toBe(true);

      const restart = byTag(run, 'admin-restart');
      expect(restart).toHaveLength(1);
      expect(restart[0]).toMatchObject({
        control: true,
        diff: { verdict: 'match', findings: [] },
      });
      expect(run.stats.by_tag['admin-restart']).toBeUndefined();
      expect(run.exchanges.filter((e) => e.control)).toHaveLength(1);
      for (const e of run.exchanges) {
        expect(e.acked_at_ms).not.toBeNull();
        expect(e.acked_at_ms as number).toBeGreaterThanOrEqual(e.sent_at_ms);
        expect(e.sent_at_ms).toBeGreaterThanOrEqual(e.scheduled_at_ms);
      }
      expect(run.pacing).toMatchObject({
        mode: 'max',
        rps: null,
        requested_rps: null,
        barrier_tags: [],
        barrier_timeout_ms: 10_000,
        barrier_waits: 0,
      });
      expect(run.pacing.achieved_rps).toBeGreaterThan(0);
      expect(run.threshold_results.map((r) => [r.id, r.outcome])).toEqual([
        ['latency.overall.p99_ms', 'pass'],
        ['correctness.mismatch_rate_max', 'pass'],
        ['errors.rate_max', 'pass'],
        ['pacing.slip_max_ms', 'pass'],
      ]);

      const written = parseRecordingText(await readFile(candidateRecording, 'utf8'));
      expect(written).toHaveLength(283);
      expect(written.map((e) => e.id)).toEqual(run.exchanges.map((e) => e.id));
      expect(written[0]?.offset_ms).toBe(0);
      expect(written.every((e) => e.adapter === 'http')).toBe(true);
      expect(written.every((e) => e.request.headers.authorization === REDACTED)).toBe(true);
      expect(written.find((e) => e.tags.includes('admin-restart'))?.response.body).toEqual({
        restarted: true,
      });
      const idempotent = written.filter((e) => e.request.headers['idempotency-key'] !== undefined);
      expect(idempotent.length).toBeGreaterThan(0);
    },
  );

  it('tolerates shifted ids through substitutions and reports them as tolerated', async () => {
    const { url } = await startCandidate('off');
    // One rejected order consumes an id without touching stock, so every candidate id shifts by one.
    const res = await fetch(`${url}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'A-100', qty: 600 }),
    });
    expect((await res.json()) as object).toMatchObject({ order_id: 'o-1', status: 'REJECTED' });

    const dir = await tempDir();
    const candidateRecording = join(dir, 'candidate.jsonl');
    // Sequential, since a concurrent replay of a sequential stateful recording can serve a
    // read before the write it followed. The substitution logic is what this test covers.
    const run = await demoRun(url, { candidateRecording, pace: 'max', concurrency: 1 });
    expect(run.verdict).toBe('pass');
    expect(run.stats.overall.mismatches).toBe(0);
    expect(run.stats.overall.tolerated).toBeGreaterThan(40);
    const create = byTag(run, 'create-order').find((e) => e.reference.status === 201);
    expect(create?.diff?.findings).toEqual([
      expect.objectContaining({
        path: '$.order_id',
        tolerated: true,
        rule: 'substitution:order_id',
      }),
    ]);
    const written = parseRecordingText(await readFile(candidateRecording, 'utf8'));
    const gets = written.filter((e) => e.tags.includes('get-order') && e.response.status === 200);
    expect(gets.length).toBeGreaterThan(50);
    for (const g of gets) {
      const id = g.request.path.split('/').pop() as string;
      expect((g.response.body as { order_id: string }).order_id).toBe(id);
    }
    // The recorded path is the reference's; the candidate recording holds the path as sent.
    const first = run.exchanges.find(
      (e) => e.tags.includes('get-order') && e.reference.status === 200,
    );
    const sent = written.find((e) => e.id === first?.id);
    expect(first?.path).not.toBe(sent?.request.path);
  });

  it('runs the ledger and restart as barriers under concurrency and counts the waits', async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, {
      pace: 'max',
      concurrency: 8,
      barrierTags: ['list-ledger'],
    });
    expect(run.pacing.barrier_tags).toEqual(['list-ledger']);
    expect(run.pacing.barrier_waits).toBeGreaterThan(0);
    expect(run.inconclusive).toEqual([]);
    const restart = byTag(run, 'admin-restart')[0];
    const before = run.exchanges.filter((e) => e.sent_at_ms < (restart?.sent_at_ms ?? 0));
    for (const e of before)
      expect(e.acked_at_ms ?? Infinity).toBeLessThanOrEqual(restart?.sent_at_ms ?? 0);
    const after = run.exchanges.filter((e) => e.sent_at_ms > (restart?.sent_at_ms ?? 0));
    for (const e of after)
      expect(e.sent_at_ms).toBeGreaterThanOrEqual(restart?.acked_at_ms ?? Infinity);
  });
});

describe('replay against the candidate with the classic divergences', () => {
  it('finds the four divergences and fails the adjust-stock latency gate', async () => {
    const { url } = await startCandidate('on', 1);
    const strict = await demoRun(url, {
      thresholds: parseThresholds(
        'latency:\n  by_tag:\n    adjust-stock: { p99_ms: 30 }\ncorrectness:\n  by_tag:\n    list-inventory: { mismatch_rate_max: 0 }\n',
      ),
    });
    expect(strict.verdict).toBe('fail');
    expect(validate(strict), validate.errors ?? '').toBe(true);

    const creates = byTag(strict, 'create-order').filter((e) => e.reference.status === 201);
    const rounding = creates.filter((e) =>
      e.diff?.findings.some((f) => f.path === '$.total' && !f.tolerated),
    );
    expect(rounding.length).toBeGreaterThan(0);
    expect(rounding.length).toBeLessThan(creates.length);

    const inventory = byTag(strict, 'list-inventory');
    expect(inventory.every((e) => e.diff?.verdict === 'mismatch')).toBe(true);
    expect(inventory[0]?.diff?.findings.some((f) => f.path.startsWith('$.items['))).toBe(true);

    const unknown = byTag(strict, 'get-order').filter((e) => e.reference.status === 404);
    expect(unknown.length).toBeGreaterThan(0);
    for (const e of unknown) {
      expect(e.candidate?.status).toBe(200);
      expect(e.diff?.findings[0]).toMatchObject({
        path: 'status',
        kind: 'status',
        tolerated: false,
      });
    }

    const adjust = strict.threshold_results.find(
      (r) => r.id === 'latency.by_tag.adjust-stock.p99_ms',
    );
    expect(adjust?.outcome).toBe('fail');
    expect(adjust?.measured).toBeGreaterThanOrEqual(60);
    expect(
      strict.threshold_results.find(
        (r) => r.id === 'correctness.by_tag.list-inventory.mismatch_rate_max',
      ),
    ).toMatchObject({ outcome: 'fail', measured: 1 });

    // Keyed unordered comparison finds the same rows on both sides, so there is nothing to report.
    // A fresh candidate, since the strict run above already moved its stock.
    const fresh = await startCandidate('on', 1);
    const unordered = await demoRun(fresh.url, { rules: parseDiffRules(UNORDERED_RULES) });
    const accepted = byTag(unordered, 'list-inventory');
    expect(accepted).toHaveLength(inventory.length);
    expect(accepted.every((e) => e.diff?.verdict === 'match')).toBe(true);
    expect(unordered.stats.by_tag['list-inventory']?.mismatches).toBe(0);
  });
});

describe('selection, warmup, and pacing', () => {
  it('filters by tag, limits, and excludes warmup from statistics', async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { filterTag: 'list-inventory', limit: 10, warmup: 3 });
    expect(run.recording.selected).toBe(10);
    expect(run.exchanges).toHaveLength(10);
    expect(run.exchanges.every((e) => e.tags.includes('list-inventory'))).toBe(true);
    expect(run.exchanges.map((e) => e.warmup)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(run.stats.overall.count).toBe(7);
    expect(run.filter).toEqual({
      tag: 'list-inventory',
      include_dependencies: true,
      dependencies: 0,
    });
    expect(run.limit).toBe(10);
    expect(run.warmup).toBe(3);
  });

  it('pulls in the producers of substituted values under a filter and does not count them', async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { filterTag: 'get-order' });
    const reads = run.exchanges.filter((e) => !e.dependency);
    const pulled = run.exchanges.filter((e) => e.dependency);
    expect(reads).toHaveLength(109);
    expect(reads.every((e) => e.tags.includes('get-order'))).toBe(true);
    expect(pulled).toHaveLength(44);
    expect(pulled.every((e) => e.tags.includes('create-order'))).toBe(true);
    expect(run.filter).toEqual({ tag: 'get-order', include_dependencies: true, dependencies: 44 });
    expect(run.recording.selected).toBe(153);
    expect(run.exchanges).toHaveLength(153);
    // Recording order is kept across the two groups.
    const position = new Map((await readRecording(RECORDING)).map((e, i) => [e.id, i]));
    const positions = run.exchanges.map((e) => position.get(e.id) as number);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Dependencies are replayed and acknowledged but not counted, like warmup exchanges.
    expect(run.stats.overall.count).toBe(109);
    expect(Object.keys(run.stats.by_tag)).toEqual(['get-order']);
    expect(pulled.every((e) => e.candidate?.status === 201 && e.acked_at_ms !== null)).toBe(true);
    // Every id the reads use now resolves, so no read mismatches on its id or its status.
    const findings = reads.flatMap((e) => e.diff?.findings.filter((f) => !f.tolerated) ?? []);
    expect(findings.some((f) => f.path === 'status' || f.path === '$.order_id')).toBe(false);
    // The reads that followed a shipment, a cancel, or a quantity change in the recording
    // still differ on those lifecycle fields, since nothing they use is a substituted value.
    const lifecycle = new Set([
      '$.status',
      '$.shipped',
      '$.remaining',
      '$.canceled_at',
      '$.canceled_unshipped',
      '$.items[0].qty',
      '$.quantity',
      '$.total',
    ]);
    expect(findings.every((f) => lifecycle.has(f.path))).toBe(true);
    expect(run.stats.overall.mismatches).toBe(27);
    expect(validate(run), validate.errors ?? '').toBe(true);

    // Without the producers every known id is unknown to the candidate.
    const fresh = await startCandidate('off');
    const bare = await demoRun(fresh.url, { filterTag: 'get-order', includeDependencies: false });
    expect(bare.filter).toEqual({ tag: 'get-order', include_dependencies: false, dependencies: 0 });
    expect(bare.exchanges).toHaveLength(109);
    expect(bare.exchanges.every((e) => !e.dependency)).toBe(true);
    const unknownIds = bare.exchanges.filter((e) => e.reference.status === 404).length;
    expect(
      bare.exchanges.filter((e) =>
        e.diff?.findings.some((f) => f.path === 'status' && !f.tolerated),
      ),
    ).toHaveLength(109 - unknownIds);

    // A limit applies to the filtered exchanges before their producers are added.
    const limited = await demoRun(fresh.url, { filterTag: 'get-order', limit: 2 });
    expect(limited.exchanges.filter((e) => !e.dependency)).toHaveLength(2);
    expect(limited.filter.dependencies).toBeGreaterThan(0);
    expect(limited.recording.selected).toBe(2 + limited.filter.dependencies);
  });

  // Retried because the absolute bound below failed with stalls of 7 to 10 s when other suites
  // ran at the same time on a shared machine. The other assertions hold under any stall.
  it('honors recorded gaps under as-recorded pacing', { retry: 2 }, async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { pace: 'as-recorded', concurrency: 8, limit: 25 });
    logFailedAttempt(run);
    const offsets: number[] = [];
    for (const line of (await readFile(RECORDING, 'utf8')).split('\n').slice(0, 25)) {
      offsets.push((JSON.parse(line) as Exchange).offset_ms);
    }
    const span = offsets[24]! - offsets[0]!;
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual(
      offsets.map((o) => o - offsets[0]!),
    );
    expect(run.pacing.requested_rps).toBeCloseTo((24 * 1000) / span, 1);
    // The schedule is read from the run's own fields. Sends keep the recording order, never run
    // ahead of their scheduled time beyond timer granularity, and span at least the schedule. A
    // stall on the machine delays every send alike and leaves these true.
    const sent = run.exchanges.map((e) => e.sent_at_ms);
    for (let i = 0; i < sent.length; i += 1) {
      expect(sent[i]!).toBeGreaterThanOrEqual(run.exchanges[i]!.scheduled_at_ms - 1);
      if (i > 0) expect(sent[i]!).toBeGreaterThanOrEqual(sent[i - 1]!);
    }
    expect(sent[24]! - sent[0]!).toBeGreaterThanOrEqual(span - 1);
    expect(run.duration_ms).toBeGreaterThanOrEqual(span - 1);
    // The slip is judged against the gaps, not against a fixed number: the median send goes out
    // within one median gap of its scheduled time. The largest slip has a generous absolute bound,
    // since a 60 ms bound held on a quiet machine and failed under CPU contention.
    const gaps = offsets.slice(1).map((o, i) => o - offsets[i]!);
    const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)]!;
    expect(run.pacing.slip_p50_ms).toBeLessThanOrEqual(medianGap);
    expect(run.pacing.slip_max_ms).toBeLessThan(1500);
    // The engine clamps a slip at zero: a timer that fires early is not ahead of schedule.
    const slips = run.exchanges
      .map((e) => Math.max(0, e.sent_at_ms - e.scheduled_at_ms))
      .sort((a, b) => a - b);
    expect(run.pacing.slip_max_ms).toBeCloseTo(slips[slips.length - 1]!, 3);
    expect(run.pacing.slip_p50_ms).toBeCloseTo(slips[Math.floor((slips.length - 1) / 2)]!, 3);
    // The default cap of thirty seconds leaves the demo recording's gaps alone.
    expect(run.pacing).toMatchObject({ max_gap_ms: 30_000, gaps_capped: 0 });
  });

  // Retried because the absolute bound below is a stall away from failing: stalls of 7 to 10 s
  // were observed when other suites ran at the same time on a shared machine.
  it(
    'caps recorded gaps above --max-gap-ms under as-recorded pacing and records the cap',
    { retry: 2 },
    async () => {
      const adapter: Adapter = {
        name: 'fake',
        send: (req) => Promise.resolve(jsonResponse({ echo: req.path }, 200, 1)),
      };
      const exchanges = [0, 100, 50_100, 50_200].map((offset, i) =>
        makeExchange({
          index: i,
          offset_ms: offset,
          request: makeRequest({ path: `/c/${i}` }),
          response: jsonResponse({ echo: `/c/${i}` }, 200, 1),
        }),
      );
      const recording = await writeRecording(exchanges);
      const run = await replay({
        recording,
        target: 'fake://',
        adapter,
        pace: 'as-recorded',
        maxGapMs: 100,
      });
      logFailedAttempt(run);
      expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 100, 200, 300]);
      expect(run.pacing).toMatchObject({
        mode: 'as-recorded',
        max_gap_ms: 100,
        gaps_capped: 1,
        requested_rps: 10,
      });
      expect(run.duration_ms).toBeGreaterThanOrEqual(295);
      // The capped schedule spans 300 ms and a quiet machine finishes within a few milliseconds of
      // that. The bound leaves 1700 ms of slack over the schedule.
      expect(run.duration_ms).toBeLessThan(2000);
      expect(run.stats.overall.matches).toBe(4);
      expect(validate(run), validate.errors ?? '').toBe(true);

      // Zero disables the cap, and the other modes have no recorded gaps to cap.
      const short = await writeRecording(exchanges.map((e, i) => ({ ...e, offset_ms: i * 30 })));
      const uncapped = await replay({
        recording: short,
        target: 'fake://',
        adapter,
        pace: 'as-recorded',
        maxGapMs: 0,
      });
      expect(uncapped.pacing).toMatchObject({ max_gap_ms: null, gaps_capped: 0 });
      expect(uncapped.exchanges.map((e) => e.scheduled_at_ms)).toEqual([0, 30, 60, 90]);
      const fixed = await replay({
        recording,
        target: 'fake://',
        adapter,
        pace: 'fixed-rate',
        rps: 200,
        maxGapMs: 100,
      });
      expect(fixed.pacing).toMatchObject({ max_gap_ms: null, gaps_capped: 0, requested_rps: 200 });
      const max = await replay({ recording, target: 'fake://', adapter, pace: 'max' });
      expect(max.pacing).toMatchObject({ max_gap_ms: null, gaps_capped: 0 });
      await expect(
        replay({ recording, target: 'fake://', adapter, pace: 'max', maxGapMs: -1 }),
      ).rejects.toThrow(/max gap/);
    },
  );

  // Retried because the absolute bound below failed with stalls of 7 to 10 s when other suites
  // ran at the same time on a shared machine. The other assertions hold under any stall.
  it('approximates the requested rate under fixed-rate pacing', { retry: 2 }, async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { pace: 'fixed-rate', rps: 100, limit: 40 });
    logFailedAttempt(run);
    expect(run.pacing).toMatchObject({ mode: 'fixed-rate', rps: 100, requested_rps: 100 });
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual(
      Array.from({ length: 40 }, (_, i) => i * 10),
    );
    // Read from the run's own fields: sends keep order, never run ahead of the schedule beyond
    // timer granularity (5 ms: a send 1.2 ms early was observed once in five runs), and span at
    // least the 390 ms of the schedule.
    const sent = run.exchanges.map((e) => e.sent_at_ms);
    for (let i = 0; i < sent.length; i += 1) {
      expect(sent[i]!).toBeGreaterThanOrEqual(i * 10 - 5);
      if (i > 0) expect(sent[i]!).toBeGreaterThanOrEqual(sent[i - 1]!);
    }
    expect(sent[39]! - sent[0]!).toBeGreaterThanOrEqual(389);
    expect(run.duration_ms).toBeGreaterThanOrEqual(389);
    // The achieved rate is the count over the run's own duration, and a 390 ms schedule cannot
    // be run faster than 103 per second.
    expect(run.pacing.achieved_rps).toBeCloseTo((40 * 1000) / run.duration_ms, 2);
    expect(run.pacing.achieved_rps).toBeLessThanOrEqual(103);
    // The slip is judged against the 10 ms gap: the median send goes out within one gap of its
    // scheduled time. The duration has a generous absolute bound, since an 800 ms bound held on
    // a quiet machine and failed under CPU contention.
    expect(run.pacing.slip_p50_ms).toBeLessThanOrEqual(10);
    expect(run.duration_ms).toBeLessThan(390 + 2000);
  });

  // Retried because the absolute bounds below are a stall away from failing: stalls of 7 to 10 s
  // were observed when other suites ran at the same time on a shared machine.
  it('keeps the pool full under max without exceeding the concurrency', { retry: 2 }, async () => {
    let inflight = 0;
    let peak = 0;
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(15);
        inflight -= 1;
        return jsonResponse({ echo: req.path }, 200, 15);
      },
    };
    // Recorded as overlapping: every response arrived long after the next request began,
    // so the replay may keep them in flight together.
    const exchanges = Array.from({ length: 40 }, (_, i) =>
      makeExchange({
        index: i,
        tags: ['probe'],
        request: makeRequest({ path: `/p/${i}` }),
        response: jsonResponse({ echo: `/p/${i}` }, 200, 10_000),
      }),
    );
    const recording = await writeRecording(exchanges);
    const run = await replay({
      recording,
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
    });
    logFailedAttempt(run);
    expect(peak).toBe(4);
    // Overlap is read from the run's own fields: the first four sends go out before the first
    // acknowledgement, so the pool was full from the start.
    expect(run.exchanges[3]!.sent_at_ms).toBeLessThan(run.exchanges[0]!.acked_at_ms ?? -Infinity);
    // Forty sends of 15 ms at concurrency 4 take about 150 ms on a quiet machine. The bound is
    // generous because a bound of 600 ms fails under CPU contention on a shared machine, and
    // `peak` above is the proof of concurrency.
    expect(run.duration_ms).toBeLessThan(40 * 15 + 1500);
    // Under max pacing the scheduled time is taken in the same synchronous step as the send, so
    // the slip is near zero by construction. Only a pause of the whole process between the two
    // readings, such as a long garbage collection, can reach the bound, which the retry covers.
    expect(run.pacing.slip_max_ms).toBeLessThan(10);
    expect(run.stats.overall.matches).toBe(40);
    expect(run.adapter).toBe('fake');
  });

  it('rejects contradictory options', async () => {
    await expect(replay({ recording: RECORDING, target: 'x', pace: 'fixed-rate' })).rejects.toThrow(
      /--rps/,
    );
    await expect(replay({ recording: RECORDING, target: 'x', rps: 5 })).rejects.toThrow(
      /fixed-rate/,
    );
    await expect(replay({ recording: RECORDING, target: 'x', concurrency: 0 })).rejects.toThrow(
      /concurrency/,
    );
    await expect(replay({ recording: RECORDING, target: 'x', limit: 0 })).rejects.toThrow(/limit/);
    await expect(replay({ recording: RECORDING, target: 'x', warmup: -1 })).rejects.toThrow(
      /warmup/,
    );
  });
});

describe('inconclusive outcomes and errors', () => {
  it('records a barrier timeout when an earlier exchange has not been acknowledged', async () => {
    // Overlapping in the recording, so the replay may keep them in flight. The fake
    // candidate answers the first exchange late and the barrier does not wait that long.
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        if (req.path === '/slow') await sleep(300);
        return jsonResponse({ ok: true }, 200, 1);
      },
    };
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['slow'],
        request: makeRequest({ path: '/slow' }),
        response: jsonResponse({ ok: true }, 200, 10_000),
      }),
      makeExchange({
        index: 1,
        tags: ['fast'],
        request: makeRequest({ path: '/fast' }),
        response: jsonResponse({ ok: true }, 200, 10_000),
      }),
      makeExchange({
        index: 2,
        tags: ['snapshot'],
        request: makeRequest({ path: '/snapshot' }),
        response: jsonResponse({ ok: true }, 200, 10_000),
      }),
    ];
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
      barrierTags: ['snapshot'],
      barrierTimeoutMs: 40,
      thresholds: parseThresholds('correctness:\n  mismatch_rate_max: 0\n'),
    });
    expect(run.verdict).toBe('inconclusive');
    expect(run.inconclusive[0]).toMatchObject({ kind: 'barrier_timeout' });
    expect(run.inconclusive[0]?.detail).toMatch(
      /GET \/snapshot .* waited 40 ms for 1 earlier exchange: /,
    );
    expect(run.pacing.barrier_waits).toBe(1);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('keeps the recorded happens-before order under max pacing', async () => {
    let inflight = 0;
    let peak = 0;
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        inflight -= 1;
        return jsonResponse({ echo: req.path }, 200, 1);
      },
    };
    // Recorded sequentially: each response arrived before the next request began.
    const exchanges = Array.from({ length: 12 }, (_, i) =>
      makeExchange({
        index: i,
        request: makeRequest({ path: `/s/${i}` }),
        response: jsonResponse({ echo: `/s/${i}` }, 200, 1),
      }),
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 8,
    });
    expect(peak).toBe(1);
    expect(run.stats.overall.matches).toBe(12);
    for (let i = 1; i < run.exchanges.length; i += 1) {
      expect(run.exchanges[i]?.sent_at_ms).toBeGreaterThanOrEqual(
        run.exchanges[i - 1]?.acked_at_ms ?? Infinity,
      );
    }
  });

  it('makes the run inconclusive when a control fails', async () => {
    const { url } = await startCandidate('off');
    const inner = new HttpAdapter(url);
    const broken = new Shim(inner, async (req, _ctx, next) => {
      const res = await next();
      return req.path === '/admin/restart' ? { ...res, status: 503 } : res;
    });
    const run = await demoRun(url, { adapter: broken });
    await broken.close();
    expect(run.verdict).toBe('inconclusive');
    expect(run.inconclusive).toHaveLength(1);
    expect(run.inconclusive[0]?.kind).toBe('control_failed');
    expect(run.inconclusive[0]?.detail).toMatch(
      /^POST \/admin\/restart \(\w+\): candidate answered 503, reference answered 200$/,
    );
    const restart = byTag(run, 'admin-restart')[0];
    expect(restart?.diff).toEqual({
      verdict: 'mismatch',
      findings: [
        { path: 'status', kind: 'status', tolerated: false, reference: 200, candidate: 503 },
      ],
    });
    expect(run.stats.overall.mismatches).toBe(0);
  });

  it('records transport failures as errors and keeps going', async () => {
    const run = await replay({
      recording: RECORDING,
      target: 'http://127.0.0.1:9',
      pace: 'max',
      concurrency: 2,
      limit: 5,
      thresholds: parseThresholds('errors:\n  rate_max: 0\n'),
    });
    expect(run.verdict).toBe('fail');
    expect(run.exchanges).toHaveLength(5);
    for (const e of run.exchanges) {
      expect(e.candidate).toBeNull();
      expect(e.diff).toBeNull();
      expect(e.acked_at_ms).toBeNull();
      expect(e.error).toMatch(/^connection: /);
    }
    expect(run.stats.overall.error_rate).toBe(1);
    expect(run.threshold_results[0]).toMatchObject({
      id: 'errors.rate_max',
      outcome: 'fail',
      measured: 1,
    });
  });

  it('stops on a signal, aborts the send in flight, and finishes with the results so far', async () => {
    const controller = new AbortController();
    const adapter: Adapter = {
      name: 'fake',
      async send(req, ctx) {
        if (ctx.index === 3) controller.abort();
        await sleep(20, undefined, { signal: ctx.signal });
        return jsonResponse({ echo: req.path }, 200, 1);
      },
    };
    // Recorded sequentially, so one exchange is in flight at a time.
    const exchanges = Array.from({ length: 12 }, (_, i) =>
      makeExchange({
        index: i,
        request: makeRequest({ path: `/s/${i}` }),
        response: jsonResponse({ echo: `/s/${i}` }, 200, 1),
      }),
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
      thresholds: parseThresholds('errors:\n  rate_max: 0\n'),
      signal: controller.signal,
    });
    expect(run.verdict).toBe('inconclusive');
    expect(run.inconclusive).toEqual([
      { kind: 'aborted', detail: 'stopped by signal after 4 of 12 exchanges' },
    ]);
    expect(run.recording.selected).toBe(12);
    expect(run.exchanges.map((e) => e.path)).toEqual(['/s/0', '/s/1', '/s/2', '/s/3']);
    expect(run.exchanges.slice(0, 3).every((e) => e.diff?.verdict === 'match')).toBe(true);
    expect(run.exchanges[3]).toMatchObject({ candidate: null, acked_at_ms: null, diff: null });
    expect(run.exchanges[3]?.error).toMatch(/^aborted: /);
    expect(run.stats.overall.count).toBe(4);
    expect(run.stats.overall.errors).toBe(1);
    // The run level condition wins over the failed threshold row.
    expect(run.threshold_results[0]).toMatchObject({ id: 'errors.rate_max', outcome: 'fail' });
    expect(run.pacing.achieved_rps).toBeGreaterThan(0);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  // Retried because the absolute bound below failed with stalls of 7 to 10 s when other suites
  // ran at the same time on a shared machine.
  it(
    'ends a long scheduled wait at once when stopped, and sends nothing on a signal already aborted',
    { retry: 2 },
    async () => {
      const adapter: Adapter = {
        name: 'fake',
        send: (req) => Promise.resolve(jsonResponse({ echo: req.path }, 200, 1)),
      };
      const exchanges = [0, 1].map((i) =>
        makeExchange({
          index: i,
          offset_ms: i * 5000,
          request: makeRequest({ path: `/g/${i}` }),
          response: jsonResponse({ echo: `/g/${i}` }, 200, 1),
        }),
      );
      const recording = await writeRecording(exchanges);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const run = await replay({
        recording,
        target: 'fake://',
        adapter,
        pace: 'as-recorded',
        maxGapMs: 0,
        signal: controller.signal,
      });
      logFailedAttempt(run);
      // The second exchange is scheduled 5000 ms after the first. The run's own duration shows the
      // wait ended on the stop, well before the schedule. A quiet machine measures about 55 ms.
      // The bound sits 2945 ms above that and still under the 5000 ms schedule, since 2000 ms on a
      // stopwatch around the call failed under CPU contention on a shared machine.
      expect(run.duration_ms).toBeLessThan(3000);
      expect(run.exchanges.map((e) => e.path)).toEqual(['/g/0']);
      expect(run.inconclusive).toEqual([
        { kind: 'aborted', detail: 'stopped by signal after 1 of 2 exchanges' },
      ]);
      expect(run.verdict).toBe('inconclusive');

      const none = await replay({
        recording,
        target: 'fake://',
        adapter,
        pace: 'max',
        signal: AbortSignal.abort(),
      });
      expect(none.exchanges).toEqual([]);
      expect(none.recording.selected).toBe(2);
      expect(none.inconclusive).toEqual([
        { kind: 'aborted', detail: 'stopped by signal after 0 of 2 exchanges' },
      ]);
      expect(none.verdict).toBe('inconclusive');
      expect(validate(none), validate.errors ?? '').toBe(true);
    },
  );

  it('never diffs a truncated body and reports body_too_large as a mismatch', async () => {
    const { url } = await startCandidate('off');
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['list-inventory'],
        request: makeRequest({ path: '/v1/inventory' }),
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          latency_ms: 2,
          truncated: true,
          body_sha256: 'a'.repeat(64),
          body_size: 5_000_000,
        },
      }),
    ];
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: url,
      pace: 'max',
      concurrency: 1,
    });
    expect(run.exchanges[0]?.candidate?.status).toBe(200);
    const diff = run.exchanges[0]?.diff;
    expect(diff?.verdict).toBe('mismatch');
    expect(diff?.findings).toHaveLength(1);
    expect(diff?.findings[0]).toMatchObject({
      path: '$',
      kind: 'body_too_large',
      tolerated: false,
    });
    expect(diff?.findings[0]?.detail).toContain('reference body (5000000 bytes)');
    expect(run.stats.overall.mismatches).toBe(1);
  });
});

describe('caller supplied headers', () => {
  let server: Server;
  let seen: Record<string, string | string[] | undefined>[] = [];

  afterEach(async () => {
    seen = [];
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('applies overrides to every request over recorded values', async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const exchanges = [0, 1].map((i) =>
      makeExchange({
        index: i,
        request: makeRequest({
          headers: { authorization: REDACTED, 'x-tenant': 'recorded', 'x-keep': 'yes' },
        }),
        response: jsonResponse({ ok: true }),
      }),
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: url,
      pace: 'max',
      headers: { Authorization: 'Bearer live', 'X-Tenant': 'override' },
    });
    expect(run.stats.overall.matches).toBe(2);
    expect(seen).toHaveLength(2);
    for (const h of seen) {
      expect(h.authorization).toBe('Bearer live');
      expect(h['x-tenant']).toBe('override');
      expect(h['x-keep']).toBe('yes');
    }
  });
});

describe('recorded query parameters', () => {
  let server: Server;
  let urls: string[] = [];

  afterEach(async () => {
    urls = [];
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('drops redacted parameters and applies overrides over the recorded query', async () => {
    server = createServer((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const query = {
      api_key: REDACTED,
      token: [REDACTED, REDACTED],
      mixed: [REDACTED, 'kept'],
      page: '2',
      sort: ['sku', 'asc'],
    };
    const exchanges = [0, 1].map((i) =>
      makeExchange({
        index: i,
        request: makeRequest({ path: '/v1/inventory', query }),
        response: jsonResponse({ ok: true }),
      }),
    );
    // A parameter is dropped when its value, or every value, is the marker. A mixed list is kept.
    expect(dropRedactedQuery(query)).toEqual({
      mixed: [REDACTED, 'kept'],
      page: '2',
      sort: ['sku', 'asc'],
    });
    const recording = await writeRecording(exchanges);
    const plain = await replay({ recording, target: url, pace: 'max' });
    expect(plain.stats.overall.matches).toBe(2);
    expect(urls).toEqual([
      '/v1/inventory?mixed=%3Credacted%3E&mixed=kept&page=2&sort=sku&sort=asc',
      '/v1/inventory?mixed=%3Credacted%3E&mixed=kept&page=2&sort=sku&sort=asc',
    ]);
    urls = [];
    const overridden = await replay({
      recording,
      target: url,
      pace: 'max',
      queryOverrides: { api_key: 'live-key', page: '7', extra: ['a', 'b'] },
    });
    expect(overridden.stats.overall.matches).toBe(2);
    expect(urls).toHaveLength(2);
    for (const sent of urls) {
      const params = new URL(sent, url).searchParams;
      expect(params.get('api_key')).toBe('live-key');
      expect(params.get('page')).toBe('7');
      expect(params.getAll('extra')).toEqual(['a', 'b']);
      expect(params.getAll('sort')).toEqual(['sku', 'asc']);
      expect(params.getAll('token')).toEqual([]);
    }
  });
});

describe('substitutions captured from a response header', () => {
  let server: Server;
  let urls: string[] = [];

  afterEach(async () => {
    urls = [];
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('rewrites a later path with the id the stand-in returns in its location header', async () => {
    server = createServer((req, res) => {
      urls.push(`${req.method} ${req.url}`);
      if (req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json', location: '/v1/orders/cand-7' });
        res.end(JSON.stringify({ created: true }));
        return;
      }
      const found = req.url === '/v1/orders/cand-7';
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ? { state: 'open' } : { error: 'not found' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['create-order'],
        request: makeRequest({ method: 'POST', path: '/v1/orders', body: { sku: 'A' } }),
        response: {
          ...jsonResponse({ created: true }, 201),
          headers: { 'content-type': 'application/json', location: '/v1/orders/ref-1' },
        },
      }),
      makeExchange({
        index: 1,
        tags: ['get-order'],
        request: makeRequest({ path: '/v1/orders/ref-1' }),
        response: jsonResponse({ state: 'open' }),
      }),
    ];
    const rules = parseDiffRules(
      [
        'substitutions:',
        '  - name: order_ref',
        '    capture: { tag: create-order, header: location, pattern: "^/v1/orders/(.+)$" }',
        '    apply: [path]',
      ].join('\n'),
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: url,
      pace: 'max',
      concurrency: 4,
      rules,
    });
    expect(urls).toEqual(['POST /v1/orders', 'GET /v1/orders/cand-7']);
    expect(run.stats.overall.matches).toBe(2);
    expect(run.stats.overall.mismatches).toBe(0);
  });
});

describe('scoped diff rules', () => {
  it('applies a rule scoped to a tag only to exchanges carrying that tag', async () => {
    // The candidate returns every list reversed. The keyed unordered rule is scoped to
    // the inventory tag, so it tolerates the order there and not on the orders list.
    const rows = [{ sku: 'A-100' }, { sku: 'B-200' }, { sku: 'C-300' }];
    const adapter: Adapter = {
      name: 'fake',
      send: () => Promise.resolve(jsonResponse({ items: [...rows].reverse() }, 200, 1)),
    };
    const exchanges = [
      { path: '/v1/inventory', tags: ['list-inventory'] },
      { path: '/v1/orders', tags: ['list-orders'] },
    ].map((x, i) =>
      makeExchange({
        index: i,
        tags: x.tags,
        request: makeRequest({ path: x.path }),
        response: jsonResponse({ items: rows }, 200, 1),
      }),
    );
    const rules = parseDiffRules(
      "unordered:\n  - path: '$.items'\n    key: '$.sku'\n    when: { tags: [list-inventory] }\n",
    );
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter,
      pace: 'max',
      rules,
    });
    const byTag: Record<string, string | undefined> = {};
    for (const e of run.exchanges) byTag[e.tags[0] ?? ''] = e.diff?.verdict;
    expect(byTag).toEqual({ 'list-inventory': 'match', 'list-orders': 'mismatch' });
  });
});
