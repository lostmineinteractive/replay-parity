import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KeptCaseSchema,
  RunSchema,
  compileRunValidator,
  parseDiffRules,
  parseThresholds,
  readRecording,
  type Exchange,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { buildApp as buildCandidate } from '@replay-parity/demo-candidate';
import { buildApp as buildReference } from '@replay-parity/demo-reference';
import { HttpAdapter, replayExchanges, type Adapter } from '@replay-parity/replay';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import {
  MockModelClient,
  PRICES_AS_OF,
  runAgent,
  writeCaseRecording,
  type AgentOptions,
  type MockAnswer,
  type MockModelClientOptions,
} from '../src/index.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');
const RULES = parseDiffRules(
  'ignore: ["$.created_at"]\nsubstitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\ncontrols:\n  tags: [admin-restart, admin-reset]\n',
);
const THRESHOLDS = parseThresholds('correctness:\n  mismatch_rate_max: 0\n');
const SLOW_CREATES = parseThresholds('latency:\n  by_tag:\n    create-order: { max_ms: 0.0001 }\n');

let validate: RunValidator;
let recording: Exchange[];
let run: Run;
let reference: HttpAdapter;
let candidate: HttpAdapter;
let refUrl: string;
let candUrl: string;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  validate = await compileRunValidator();
  recording = await readRecording(RECORDING);
  const ref = buildReference();
  const cand = buildCandidate({ divergences: 'on', seed: 1 });
  await ref.listen({ port: 0, host: '127.0.0.1' });
  await cand.listen({ port: 0, host: '127.0.0.1' });
  closers.push(
    () => ref.close(),
    () => cand.close(),
  );
  refUrl = `http://127.0.0.1:${(ref.server.address() as AddressInfo).port}`;
  candUrl = `http://127.0.0.1:${(cand.server.address() as AddressInfo).port}`;
  // Both systems take the recording first, so they stand in the same state and assign the same
  // ids to the cases that follow, the way they do after make demo.
  await replayExchanges(recording, { target: refUrl, pace: 'max', concurrency: 1, rules: RULES });
  run = await replayExchanges(recording, {
    target: candUrl,
    pace: 'max',
    concurrency: 1,
    rules: RULES,
    thresholds: THRESHOLDS,
  });
  reference = new HttpAdapter(refUrl);
  candidate = new HttpAdapter(candUrl);
  closers.push(
    () => reference.close(),
    () => candidate.close(),
  );
}, 60_000);

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
});

const roundingCase = {
  hypothesis: 'a quantity of 3 at a price ending in .995 lands on a half cent',
  tags: ['create-order'],
  steps: [{ request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 3 } } }],
};
const unknownCase = {
  hypothesis: 'an unknown order id answers 200 instead of 404',
  tags: ['get-order'],
  steps: [{ request: { method: 'GET', path: '/v1/orders/o-does-not-exist' } }],
};
const twoStepCase = {
  hypothesis: 'reading a created order shows the rounded total',
  tags: ['get-order'],
  steps: [
    {
      request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 3 } },
      capture: { name: 'id', path: '$.order_id' },
    },
    { request: { method: 'GET', path: '/v1/orders/{{id}}' } },
  ],
};
// 7 x 9.995 = 69.965, a half cent that half up and half even round apart.
const sameCase = {
  hypothesis: 'another quantity with a half cent total',
  tags: ['create-order'],
  steps: [{ request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 7 } } }],
};
const matchingCase = {
  hypothesis: 'an even quantity rounds the same way',
  tags: ['create-order'],
  steps: [{ request: { method: 'POST', path: '/v1/orders', body: { sku: 'B-200', qty: 2 } } }],
};

async function agent(
  answers: MockAnswer[],
  over: Partial<AgentOptions> = {},
  mock: Partial<MockModelClientOptions> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'rp-agent-'));
  const client = new MockModelClient(answers, {
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 5000, output_tokens: 1000 },
    ...mock,
  });
  const outcome = await runAgent({
    run,
    recording,
    rules: RULES,
    thresholds: THRESHOLDS,
    adapters: { reference, candidate },
    client,
    budgetUsd: 2,
    maxRounds: 3,
    casesPerRound: 4,
    transcriptPath: join(dir, 'agent-transcript.json'),
    casesPath: join(dir, 'generated-cases.jsonl'),
    ...over,
  });
  return { ...outcome, client };
}

describe('the agent loop on the mock client', () => {
  it('keeps new findings, dedupes by path set, runs two step cases per side, and stops when a round adds nothing', async () => {
    const { report, transcript, cases, client } = await agent([
      JSON.stringify({ cases: [roundingCase, unknownCase, twoStepCase, matchingCase] }),
      JSON.stringify({ cases: [sameCase] }),
    ]);
    expect(report.stop_reason).toBe('no_new_cases');
    expect(report.rounds).toBe(2);
    expect(report.proposed).toBe(5);
    expect(report.valid).toBe(5);
    expect(report.executed).toBe(5);
    expect(report.kept).toBe(2);
    expect(cases.map((c) => c.id)).toEqual(['case-1-1', 'case-1-2']);
    expect(cases[0]).toMatchObject({
      dedupe_key: 'mismatch:$.total',
      tags: ['create-order'],
      round: 1,
    });
    expect(cases[0]?.revealed).toContain('$.total');
    expect(cases[1]?.dedupe_key).toBe('mismatch:$,status');
    expect(cases[1]?.reference?.status).toBe(404);
    expect(cases[1]?.candidate?.status).toBe(200);
    // The two step case read each system's own order id, so only the rounded total differs,
    // which the first case already revealed.
    expect(transcript.rounds[0]?.not_kept).toEqual([
      { id: 'case-1-3', reason: 'same as a kept case (mismatch:$.total)' },
      { id: 'case-1-4', reason: 'no difference and no latency breach' },
    ]);
    expect(transcript.rounds[1]?.not_kept).toEqual([
      { id: 'case-2-1', reason: 'same as a kept case (mismatch:$.total)' },
    ]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.request.user).toContain('case-1-1 [create-order]');
    expect(client.calls[1]?.request.user).toContain('Round 2 of 3');
    // The stable prefix is identical across rounds, so a caching client reuses it.
    const prefix = client.calls[0]?.request.cachePrefixLength ?? 0;
    expect(prefix).toBeGreaterThan(1000);
    expect(client.calls[1]?.request.cachePrefixLength).toBe(prefix);
    expect(client.calls[1]?.request.user.slice(0, prefix)).toBe(
      client.calls[0]?.request.user.slice(0, prefix),
    );
    expect(report.cost_usd).toBeCloseTo((2 * (5000 * 2 + 1000 * 10)) / 1_000_000, 6);
    expect(report.input_tokens).toBe(10_000);
    for (const c of cases) expect(KeptCaseSchema.safeParse(c).success).toBe(true);
    const withAgent = { ...run, agent: report };
    expect(RunSchema.safeParse(withAgent).success).toBe(true);
    expect(validate(withAgent), validate.errors ?? '').toBe(true);
    expect(transcript.prompt_versions['system.md']).toMatch(/^[0-9a-f]{12}$/);
  }, 60_000);

  it('keeps a latency breach under its own key', async () => {
    const { cases, report } = await agent(
      [JSON.stringify({ cases: [matchingCase] }), JSON.stringify({ cases: [matchingCase] })],
      { thresholds: SLOW_CREATES },
    );
    expect(report.stop_reason).toBe('no_new_cases');
    expect(cases).toHaveLength(1);
    expect(cases[0]?.dedupe_key).toBe('latency:create-order:max_ms');
    expect(cases[0]?.latency_breach).toBe('latency:create-order:max_ms');
    expect(cases[0]?.diff?.verdict).toBe('match');
    expect(cases[0]?.repeat).toBe(1);
    expect(cases[0]?.latency?.candidate.count).toBe(1);
    expect(cases[0]?.revealed).toMatch(
      /^candidate answered in [\d.]+ ms, over the create-order max_ms limit of 0.0001 ms$/,
    );
  });

  // Retried because the bounds below are of tens of milliseconds and the stand ins run in this
  // process, where stalls of 7 to 10 s were observed when other suites ran at the same time on
  // a shared machine. A stall is measured as latency and cannot be told from the 40 ms delay.
  it(
    'repeats a latency case and judges the sample percentile, which one run cannot show',
    { retry: 2 },
    async () => {
      // Two stand ins that answer the same body. The slow one delays every second call by 40 ms,
      // so a single run sees a fast answer and a sample of ten sees the tail at p90.
      const servers: Server[] = [];
      const stub = (slow: boolean): Promise<string> =>
        new Promise((resolveUrl) => {
          let calls = 0;
          const server = createServer((req, res) => {
            req.resume();
            req.on('end', () => {
              calls += 1;
              const answer = (): void => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"sku":"F-600","on_hand":12}');
              };
              if (slow && calls % 2 === 0) setTimeout(answer, 40);
              else answer();
            });
          });
          servers.push(server);
          server.listen(0, '127.0.0.1', () =>
            resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
          );
        });
      const fast = new HttpAdapter(await stub(false));
      const slow = new HttpAdapter(await stub(true));
      try {
        const single = {
          hypothesis: 'one adjustment is slow',
          tags: ['adjust-stock'],
          steps: [
            { request: { method: 'POST', path: '/v1/inventory/F-600/adjust', body: { delta: 1 } } },
          ],
        };
        const repeated = { ...single, hypothesis: 'adjustments have a slow tail', repeat: 10 };
        const { cases, report, transcript } = await agent(
          [JSON.stringify({ cases: [single, repeated] }), JSON.stringify({ cases: [repeated] })],
          {
            adapters: { reference: fast, candidate: slow },
            thresholds: parseThresholds('latency:\n  by_tag:\n    adjust-stock: { p90_ms: 20 }\n'),
          },
        );
        // Logs the latency fields of a failed attempt, so a retry is never silent in the output.
        onTestFailed(({ task }) => {
          const failures = task.result?.errors ?? [];
          console.error(
            `attempt failed: ${failures[failures.length - 1]?.message ?? 'no error recorded'}\n` +
              `kept ${JSON.stringify(cases.map((k) => ({ id: k.id, latency: k.latency })))}\n` +
              `not kept ${JSON.stringify(transcript.rounds.map((r) => r.not_kept))}`,
          );
        });
        expect(report.stop_reason).toBe('no_new_cases');
        expect(report.executed).toBe(3);
        expect(cases).toHaveLength(1);
        const c = cases[0]!;
        expect(c.id).toBe('case-1-2');
        expect(c.repeat).toBe(10);
        expect(c.dedupe_key).toBe('latency:adjust-stock:p90_ms');
        expect(c.latency?.candidate.count).toBe(10);
        expect(c.latency?.reference.count).toBe(10);
        expect(c.latency?.candidate.p90_ms).toBeGreaterThanOrEqual(35);
        // Read from the case's own fields: the slow tail sits above the median, and the reference,
        // which never delays, is faster than the candidate at p90. The absolute bounds are generous
        // because a quiet machine measures a candidate p50 of 0.5 ms and a reference p90 of 0.3 ms,
        // and the bound of 20 ms they replace is one stall away from failing.
        expect(c.latency?.candidate.p50_ms).toBeLessThan(c.latency?.candidate.p90_ms ?? 0);
        expect(c.latency?.reference.p90_ms).toBeLessThan(c.latency?.candidate.p90_ms ?? 0);
        expect(c.latency?.candidate.p50_ms).toBeLessThan(20 + 1500);
        expect(c.latency?.reference.p90_ms).toBeLessThan(20 + 1500);
        expect(c.diff?.verdict).toBe('match');
        expect(c.revealed).toMatch(
          /^candidate p90 over 10 runs was [\d.]+ ms, over the adjust-stock p90_ms limit of 20 ms$/,
        );
        expect(transcript.rounds[0]?.not_kept).toEqual([
          { id: 'case-1-1', reason: 'no difference and no latency breach' },
        ]);
        expect(transcript.rounds[1]?.not_kept).toEqual([
          { id: 'case-2-1', reason: 'same as a kept case (latency:adjust-stock:p90_ms)' },
        ]);
        for (const k of cases) expect(KeptCaseSchema.safeParse(k).success).toBe(true);
      } finally {
        await fast.close();
        await slow.close();
        for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
      }
    },
  );

  it('stops on the budget, on max rounds, on a refusal, and on an unreadable answer', async () => {
    // One call is estimated at under ten cents, a second one would cross the budget.
    const pricey = await agent([JSON.stringify({ cases: [roundingCase] })], { budgetUsd: 0.1 });
    expect(pricey.report.stop_reason).toBe('budget');
    expect(pricey.report.rounds).toBe(1);
    expect(pricey.report.kept).toBe(1);

    const tooCheap = await agent([JSON.stringify({ cases: [roundingCase] })], {
      budgetUsd: 0.0001,
    });
    expect(tooCheap.report.stop_reason).toBe('budget');
    expect(tooCheap.report.rounds).toBe(0);
    expect(tooCheap.client.calls).toHaveLength(0);

    const rounds = await agent(
      [
        JSON.stringify({ cases: [roundingCase] }),
        JSON.stringify({ cases: [unknownCase] }),
        JSON.stringify({ cases: [matchingCase] }),
      ],
      { maxRounds: 2 },
    );
    expect(rounds.report.stop_reason).toBe('max_rounds');
    expect(rounds.report.rounds).toBe(2);
    expect(rounds.report.kept).toBe(2);

    const refused = await agent([{ text: '', stop_reason: 'refusal' }]);
    expect(refused.report.stop_reason).toBe('model_refusal');
    expect(refused.report.kept).toBe(0);
    expect(refused.transcript.rounds[0]?.stop_reason).toBe('refusal');

    const garbage = await agent(['I would rather not.']);
    expect(garbage.report.stop_reason).toBe('no_valid_cases');
    expect(garbage.transcript.rounds[0]?.parse_error).toContain('invalid JSON');

    const failing = await agent([() => Promise.reject(new Error('boom')) as unknown as string]);
    expect(failing.report.stop_reason).toBe('error');
  }, 60_000);

  it('stops at the next case boundary on a signal and reports it', async () => {
    const controller = new AbortController();
    // The signal arrives while the first case is in flight, so the case finishes and the
    // second one is never sent.
    const tripping: Adapter = {
      name: candidate.name,
      send(req, ctx) {
        controller.abort();
        return candidate.send(req, ctx);
      },
    };
    const { report, transcript, cases, client } = await agent(
      [
        JSON.stringify({ cases: [unknownCase, roundingCase] }),
        JSON.stringify({ cases: [roundingCase] }),
      ],
      { adapters: { reference, candidate: tripping }, signal: controller.signal },
    );
    expect(report.stop_reason).toBe('aborted');
    expect(transcript.stop_reason).toBe('aborted');
    expect(report.rounds).toBe(1);
    expect(report.valid).toBe(2);
    expect(report.executed).toBe(1);
    expect(cases.map((c) => c.id)).toEqual(['case-1-1']);
    expect(transcript.rounds).toHaveLength(1);
    expect(transcript.rounds[0]?.executed).toBe(1);
    expect(client.calls).toHaveLength(1);
    const withAgent = { ...run, agent: report };
    expect(RunSchema.safeParse(withAgent).success).toBe(true);
    expect(validate(withAgent), validate.errors ?? '').toBe(true);

    // A signal already aborted stops before the first model call.
    const before = await agent([JSON.stringify({ cases: [unknownCase] })], {
      signal: AbortSignal.abort(),
    });
    expect(before.report).toMatchObject({ stop_reason: 'aborted', rounds: 0, executed: 0 });
    expect(before.client.calls).toHaveLength(0);
  });

  it('records a case whose capture fails as an error without keeping it', async () => {
    const broken = {
      hypothesis: 'capture from a missing field',
      tags: ['get-order'],
      steps: [
        {
          request: { method: 'POST', path: '/v1/orders', body: { sku: 'A-100', qty: 1 } },
          capture: { name: 'id', path: '$.nope' },
        },
        { request: { method: 'GET', path: '/v1/orders/{{id}}' } },
      ],
    };
    const { report, transcript } = await agent([JSON.stringify({ cases: [broken] })]);
    expect(report.kept).toBe(0);
    expect(report.stop_reason).toBe('no_new_cases');
    expect(transcript.rounds[0]?.not_kept[0]?.reason).toContain(
      'capture id found nothing at $.nope',
    );
  });

  it('records the estimator, the pricing, and the isolation mode in the transcript', async () => {
    const counted = await agent(
      [JSON.stringify({ cases: [roundingCase] }), JSON.stringify({ cases: [] })],
      {},
      { countTokens: (request) => request.system.length + request.user.length },
    );
    const first = counted.transcript.rounds[0]!;
    expect(first.estimator).toBe('count_tokens');
    const request = counted.client.calls[0]!.request;
    const tokens = request.system.length + request.user.length;
    expect(first.estimate_usd).toBeCloseTo((tokens * 2 + 8192 * 10) / 1_000_000, 9);
    expect(first.schema_constrained).toBe(false);
    expect(first.fallback_ran).toBe(false);
    expect(first.answered_by).toBeUndefined();
    expect(counted.transcript).toMatchObject({
      pricing_as_of: PRICES_AS_OF,
      pricing_assumed: false,
      pricing_path: null,
      isolation: { reset_between_cases: false, case_concurrency: 1 },
    });

    // A counter that fails leaves the heuristic in charge, and the mock without one never counts.
    const failing = await agent(
      [JSON.stringify({ cases: [roundingCase] })],
      {},
      {
        countTokens: () => {
          throw new Error('offline');
        },
      },
    );
    expect(failing.transcript.rounds[0]?.estimator).toBe('heuristic');
    expect(failing.transcript.rounds[0]?.estimate_usd).toBeCloseTo(
      (Math.ceil(tokens / 3) * 2 + 8192 * 10) / 1_000_000,
      9,
    );
    const plain = await agent([JSON.stringify({ cases: [roundingCase] })]);
    expect(plain.transcript.rounds[0]?.estimator).toBe('heuristic');

    // A supplied table prices the calls, the estimate, and is named in the transcript.
    const priced = await agent([JSON.stringify({ cases: [roundingCase] })], {
      prices: { 'claude-sonnet-5-5': { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } },
      pricingPath: 'prices.json',
    });
    // The single answer repeats, so the loop makes two calls before it stops.
    expect(priced.report.rounds).toBe(2);
    expect(priced.report.cost_usd).toBeCloseTo((2 * (5000 * 1 + 1000 * 2)) / 1_000_000, 9);
    expect(priced.transcript.pricing_path).toBe('prices.json');
    expect(priced.transcript.pricing_assumed).toBe(false);
    const assumed = await agent(
      [JSON.stringify({ cases: [roundingCase] })],
      {},
      { model: 'some-new-model' },
    );
    expect(assumed.transcript.pricing_assumed).toBe(true);

    // A response that names another model is priced by that model.
    const fellBack = await agent([
      () => ({
        text: JSON.stringify({ cases: [roundingCase] }),
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 5000,
          output_tokens: 1000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        model: 'claude-sonnet-5',
        fallback_ran: true,
        schema_constrained: true,
      }),
    ]);
    expect(fellBack.transcript.rounds[0]).toMatchObject({
      answered_by: 'claude-sonnet-5',
      fallback_ran: true,
      schema_constrained: true,
    });
    expect(fellBack.report.rounds).toBe(2);
    expect(fellBack.report.cost_usd).toBeCloseTo((2 * (5000 * 2 + 1000 * 10)) / 1_000_000, 9);
  }, 60_000);

  it('exports the kept cases as a recording whose replay reproduces the mismatches', async () => {
    // Every exported step carries the case's tags, so the two step case is tagged by its create
    // and the substitution rule captures the order id from it on replay.
    const twoStepCreate = { ...twoStepCase, tags: ['create-order'] };
    const { exchanges, cases, report } = await agent([
      JSON.stringify({ cases: [twoStepCreate, unknownCase, matchingCase] }),
      JSON.stringify({ cases: [] }),
    ]);
    expect(report.kept).toBe(2);
    expect(cases.map((c) => c.id)).toEqual(['case-1-1', 'case-1-2']);
    // One exchange per step, the two step case first, offsets growing by the reference latency.
    expect(exchanges.map((e) => e.id)).toEqual(['case-1-1:1', 'case-1-1:2', 'case-1-2:1']);
    expect(exchanges.map((e) => e.tags)).toEqual([
      ['create-order', 'agent:case-1-1'],
      ['create-order', 'agent:case-1-1'],
      ['get-order', 'agent:case-1-2'],
    ]);
    expect(exchanges[0]?.offset_ms).toBe(0);
    expect(exchanges[1]?.offset_ms).toBe(exchanges[0]!.response.latency_ms);
    expect(exchanges[2]?.offset_ms).toBe(
      exchanges[0]!.response.latency_ms + exchanges[1]!.response.latency_ms,
    );
    expect(Date.parse(exchanges[0]!.ts)).toBe(Date.parse(run.created_at));
    expect(exchanges[0]?.request.method).toBe('POST');
    expect(exchanges[0]?.request.headers['content-type']).toBe('application/json');
    // The second step's placeholder was resolved from the reference's own order id.
    expect(exchanges[1]?.request.path).toMatch(/^\/v1\/orders\/o-\d+$/);
    expect(exchanges[0]?.response.status).toBe(201);
    expect(exchanges[2]?.response.status).toBe(404);

    const dir = await mkdtemp(join(tmpdir(), 'rp-agent-export-'));
    const path = join(dir, 'agent-cases.jsonl');
    expect(await writeCaseRecording(path, exchanges)).toBe(3);
    const back = await readRecording(path);
    expect(back).toEqual(exchanges);

    // Replaying the export against the same candidate finds the same two divergences. The
    // reference takes it too, so both systems keep assigning the same ids to later tests.
    const replayed = await replayExchanges(back, {
      target: candUrl,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      thresholds: THRESHOLDS,
    });
    const onReference = await replayExchanges(back, {
      target: refUrl,
      pace: 'max',
      concurrency: 1,
      rules: RULES,
      thresholds: THRESHOLDS,
    });
    expect(onReference.verdict).toBe('pass');
    expect(replayed.verdict).toBe('fail');
    const byId = new Map(replayed.exchanges.map((e) => [e.id, e]));
    // The candidate already served this create once, so it assigns the next id and `$.order_id`
    // differs on the create the way it does for any system that has moved on; the captured pair
    // tolerates the ids from then on. `$.total` is the divergence the case was kept for.
    const untolerated = (id: string): string[] =>
      byId
        .get(id)
        ?.diff?.findings.filter((f) => !f.tolerated)
        .map((f) => f.path) ?? [];
    expect(byId.get('case-1-1:1')?.diff?.verdict).toBe('mismatch');
    expect(untolerated('case-1-1:1').filter((p) => p !== '$.order_id')).toEqual(['$.total']);
    expect(byId.get('case-1-1:2')?.diff?.verdict).toBe('mismatch');
    expect(untolerated('case-1-1:2')).toEqual(['$.total']);
    expect(byId.get('case-1-2:1')?.diff?.verdict).toBe('mismatch');
    expect(untolerated('case-1-2:1')).toEqual(['status', '$']);
    expect(byId.get('case-1-2:1')?.candidate?.status).toBe(200);
  }, 60_000);

  it('resets both systems before every case, runs cases in parallel only without resets, and stops when a reset fails', async () => {
    const counts = { reference: 0, candidate: 0 };
    const reset = (side: keyof typeof counts) => (): Promise<void> => {
      counts[side] += 1;
      return Promise.resolve();
    };
    const answers = [
      JSON.stringify({ cases: [roundingCase, unknownCase, matchingCase] }),
      JSON.stringify({ cases: [sameCase] }),
    ];
    const isolated = await agent(answers, {
      resets: { reference: reset('reference'), candidate: reset('candidate') },
      caseConcurrency: 4,
    });
    expect(isolated.report.executed).toBe(4);
    expect(counts).toEqual({ reference: 4, candidate: 4 });
    expect(isolated.transcript.isolation).toEqual({
      reset_between_cases: true,
      case_concurrency: 1,
    });
    expect(isolated.cases.map((c) => c.id)).toEqual(['case-1-1', 'case-1-2']);

    const parallel = await agent(answers, { caseConcurrency: 2 });
    expect(parallel.transcript.isolation).toEqual({
      reset_between_cases: false,
      case_concurrency: 2,
    });
    expect(parallel.report.executed).toBe(4);
    // Results are judged in case order whatever the order they finish in.
    expect(parallel.cases.map((c) => c.id)).toEqual(['case-1-1', 'case-1-2']);
    expect(parallel.transcript.rounds[0]?.not_kept).toEqual([
      { id: 'case-1-3', reason: 'no difference and no latency breach' },
    ]);
    expect(parallel.transcript.rounds[1]?.not_kept).toEqual([
      { id: 'case-2-1', reason: 'same as a kept case (mismatch:$.total)' },
    ]);

    const broken = await agent(answers, {
      resets: { candidate: () => Promise.reject(new Error('reset answered 500')) },
    });
    expect(broken.report.stop_reason).toBe('error');
    expect(broken.report.executed).toBe(0);
    expect(broken.transcript.rounds[0]?.error).toBe(
      'reset before case-1-1 failed: reset answered 500',
    );
    expect(broken.transcript.rounds[0]?.stop_reason).toBe('end_turn');
  }, 60_000);
});
