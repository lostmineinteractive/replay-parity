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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelClient, runAgent, type AgentOptions, type MockAnswer } from '../src/index.js';

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
  const refUrl = `http://127.0.0.1:${(ref.server.address() as AddressInfo).port}`;
  const candUrl = `http://127.0.0.1:${(cand.server.address() as AddressInfo).port}`;
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

async function agent(answers: MockAnswer[], over: Partial<AgentOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rp-agent-'));
  const client = new MockModelClient(answers, {
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 5000, output_tokens: 1000 },
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

  it('repeats a latency case and judges the sample percentile, which one run cannot show', async () => {
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
      expect(c.latency?.candidate.p50_ms).toBeLessThan(20);
      expect(c.latency?.reference.p90_ms).toBeLessThan(20);
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
  });

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
});
