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
  type Exchange,
  type RecordedRequest,
  type RecordedResponse,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp, type DivergenceSetting } from '@replay-parity/demo-candidate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HttpAdapter,
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
  it('passes with zero mismatches, flags the control, and writes a valid run and candidate recording', async () => {
    const { url } = await startCandidate('off');
    const dir = await tempDir();
    const candidateRecording = join(dir, 'candidate.jsonl');
    const run = await demoRun(url, {
      candidateRecording,
      headers: { authorization: 'Bearer replay-token' },
      thresholds: parseThresholds(
        'correctness:\n  mismatch_rate_max: 0\nerrors:\n  rate_max: 0\nlatency:\n  min_samples: 20\n  overall: { p99_ms: 500 }\npacing:\n  slip_max_ms: 250\n',
      ),
    });

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
  });

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
    expect(run.filter).toEqual({ tag: 'list-inventory' });
    expect(run.limit).toBe(10);
    expect(run.warmup).toBe(3);
  });

  it('honors recorded gaps under as-recorded pacing', async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { pace: 'as-recorded', concurrency: 8, limit: 25 });
    const offsets: number[] = [];
    for (const line of (await readFile(RECORDING, 'utf8')).split('\n').slice(0, 25)) {
      offsets.push((JSON.parse(line) as Exchange).offset_ms);
    }
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual(
      offsets.map((o) => o - offsets[0]!),
    );
    expect(run.pacing.slip_max_ms).toBeLessThan(60);
    expect(run.duration_ms).toBeGreaterThanOrEqual(offsets[24]! - offsets[0]!);
    expect(run.pacing.requested_rps).toBeCloseTo((24 * 1000) / (offsets[24]! - offsets[0]!), 1);
    // The engine clamps a slip at zero: a timer that fires early is not ahead of schedule.
    const slips = run.exchanges
      .map((e) => Math.max(0, e.sent_at_ms - e.scheduled_at_ms))
      .sort((a, b) => a - b);
    expect(run.pacing.slip_max_ms).toBeCloseTo(slips[slips.length - 1]!, 3);
    expect(run.pacing.slip_p50_ms).toBeCloseTo(slips[Math.floor((slips.length - 1) / 2)]!, 3);
  });

  it('approximates the requested rate under fixed-rate pacing', async () => {
    const { url } = await startCandidate('off');
    const run = await demoRun(url, { pace: 'fixed-rate', rps: 100, limit: 40 });
    expect(run.pacing).toMatchObject({ mode: 'fixed-rate', rps: 100, requested_rps: 100 });
    expect(run.exchanges.map((e) => e.scheduled_at_ms)).toEqual(
      Array.from({ length: 40 }, (_, i) => i * 10),
    );
    expect(run.duration_ms).toBeGreaterThanOrEqual(390);
    expect(run.duration_ms).toBeLessThan(800);
    expect(run.pacing.achieved_rps).toBeGreaterThan(50);
    expect(run.pacing.achieved_rps).toBeLessThanOrEqual(103);
  });

  it('keeps the pool full under max without exceeding the concurrency', async () => {
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
    expect(peak).toBe(4);
    expect(run.duration_ms).toBeLessThan(40 * 15);
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
