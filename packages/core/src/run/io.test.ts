import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileRunValidator,
  fixedUlid,
  makeExchangeResult,
  makeRun,
  type RunValidator,
} from '../testing.js';
import { parseThresholds } from '../thresholds/schema.js';
import { ConfigError } from '../yaml.js';
import { parseRun, readRun, runJsonSchema, serializeRun, writeRun } from './io.js';
import type { InvariantReport } from '../invariants/schema.js';
import {
  AgentStopReasonSchema,
  ExchangeResultSchema,
  GeneratedCaseSchema,
  PacingSchema,
  RUN_SCHEMA_VERSION,
  RunSchema,
  type AgentReport,
} from './schema.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

const agent: AgentReport = {
  model: 'claude-sonnet-5-5',
  rounds: 2,
  max_rounds: 3,
  budget_usd: 2,
  cost_usd: 0.42,
  input_tokens: 12_000,
  output_tokens: 3_000,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  proposed: 16,
  valid: 15,
  executed: 15,
  kept: 2,
  stop_reason: 'no_new_cases',
  prompt_versions: { 'system.md': 'abc' },
  transcript_path: 'agent-transcript.json',
  cases_path: 'generated-cases.jsonl',
  cases: [
    {
      id: 'case-1',
      round: 1,
      hypothesis: 'rounding differs when qty is odd',
      tags: ['create-order'],
      steps: [
        {
          request: {
            method: 'POST',
            path: '/v1/orders',
            query: {},
            headers: {},
            body: { sku: 'A', qty: 3 },
          },
        },
      ],
      repeat: 1,
      dedupe_key: 'mismatch:$.total',
      reference: { status: 201, latency_ms: 3 },
      candidate: { status: 201, latency_ms: 4 },
      latency: null,
      error: null,
      diff: {
        verdict: 'mismatch',
        findings: [
          { path: '$.total', kind: 'value', tolerated: false, reference: 1, candidate: 2 },
        ],
      },
      latency_breach: null,
      revealed: '$.total differs',
    },
  ],
};

describe('run model', () => {
  it('validates the fixture run against the zod schema and the JSON Schema', () => {
    const run = makeRun();
    expect(RunSchema.parse(run)).toEqual(run);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('validates a run with an agent section', () => {
    const run = makeRun({ agent });
    expect(RunSchema.parse(run)).toEqual(run);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('rejects malformed runs through both validators', () => {
    const broken = { ...makeRun(), verdict: 'maybe' };
    expect(validate(broken)).toBe(false);
    expect(validate.errors).toContain('verdict');
    expect(RunSchema.safeParse(broken).success).toBe(false);
    expect(validate({ ...makeRun(), extra: 1 })).toBe(false);
    const badKind = { ...makeRun(), inconclusive: [{ kind: 'unknown', detail: 'x' }] };
    expect(validate(badKind)).toBe(false);
    expect(RunSchema.safeParse(badKind).success).toBe(false);
  });

  it('carries the three verdicts and the inconclusive conditions', () => {
    const fixture = makeRun();
    expect(fixture.verdict).toBe('pass');
    expect(fixture.inconclusive).toEqual([]);

    const thresholds = parseThresholds('latency:\n  min_samples: 10\n  overall: { p99_ms: 100 }\n');
    const thin = makeRun({ thresholds });
    expect(thin.verdict).toBe('inconclusive');
    expect(thin.threshold_results[0]?.outcome).toBe('inconclusive');
    expect(thin.inconclusive).toEqual([
      {
        kind: 'insufficient_samples',
        detail: 'latency.overall.p99_ms: 2 successful samples, minimum 10',
      },
    ]);
    expect(validate(thin), validate.errors ?? '').toBe(true);

    const barrier = makeRun({
      thresholds: parseThresholds('correctness:\n  mismatch_rate_max: 0\n'),
      inconclusive: [{ kind: 'barrier_timeout', detail: 'list-ledger waited 10000 ms' }],
    });
    expect(barrier.threshold_results[0]?.outcome).toBe('fail');
    expect(barrier.verdict).toBe('inconclusive');
    expect(validate(barrier), validate.errors ?? '').toBe(true);

    const failing = makeRun({
      thresholds: parseThresholds('correctness:\n  mismatch_rate_max: 0\n'),
    });
    expect(failing.verdict).toBe('fail');
  });

  it('carries the invariants section and the candidate recording path', () => {
    const report: InvariantReport = {
      system: 'candidate',
      recording: 'candidate.jsonl',
      exchanges: 10,
      commands: 6,
      snapshots: { ledger_reads: 2, stock_reads: 3, order_reads: 4 },
      results: [
        {
          id: 1,
          name: 'shipment-applied-once',
          statement: 'An accepted shipment event changes stock on hand exactly once.',
          status: 'violated',
          checks: 3,
          evidence: [
            {
              subject: 'order o-7',
              expected: 5,
              observed: 8,
              detail: 'shipped counts shp-3 twice',
              exchange_id: 'abc',
            },
          ],
        },
      ],
      violations: 1,
      inconclusive: [],
    };
    const run = makeRun({
      candidate_recording: 'candidate.jsonl',
      invariants: { reference: null, candidate: report },
    });
    expect(RunSchema.parse(run)).toEqual(run);
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(makeRun().invariants).toEqual({ reference: null, candidate: null });
    const badStatus = {
      ...run,
      invariants: {
        reference: null,
        candidate: { ...report, results: [{ ...report.results[0], status: 'maybe' }] },
      },
    };
    expect(RunSchema.safeParse(badStatus).success).toBe(false);
    expect(validate(badStatus)).toBe(false);
  });

  it('carries the reproduction section', () => {
    const run = makeRun({
      reproduction: {
        rule: 'invariant:candidate:shipment-applied-once',
        original_steps: 21,
        reduced_steps: 4,
        attempts: 9,
        successful: true,
        label: 'reduced reproduction',
        duration_ms: 812,
        recording: 'reduced-reproduction.jsonl',
        steps: [
          {
            id: 'a',
            method: 'POST',
            path: '/v1/orders',
            tags: ['create-order'],
            body: { sku: 'H-800', qty: 2 },
            quantity_reduced: true,
            changed: [
              { path: '$.qty', from: 5, to: 2 },
              { path: '$.note', from: 'a note', to: '' },
            ],
          },
          {
            id: 'b',
            method: 'GET',
            path: '/v1/orders/o-7',
            tags: ['get-order'],
            quantity_reduced: false,
          },
        ],
      },
    });
    expect(RunSchema.parse(run)).toEqual(run);
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(makeRun().reproduction).toBeNull();
    const badChange = structuredClone(run);
    (badChange.reproduction?.steps[0]?.changed as unknown[]).push({ path: '$.x', from: 1 });
    expect(RunSchema.safeParse(badChange).success).toBe(false);
    expect(validate(badChange)).toBe(false);
    const badLabel = { ...run, reproduction: { ...run.reproduction, label: 'minimal' } };
    expect(RunSchema.safeParse(badLabel).success).toBe(false);
    expect(validate(badLabel)).toBe(false);
  });

  it('records barrier settings, acknowledgement times, and the control flag', () => {
    const run = makeRun();
    expect(run.pacing).toMatchObject({
      barrier_tags: [],
      barrier_timeout_ms: 10_000,
      barrier_waits: 0,
    });
    expect(run.exchanges.map((e) => [e.control, e.acked_at_ms])).toEqual([
      [false, 13],
      [false, 128],
      [false, null],
    ]);
    const control = makeRun({
      exchanges: [makeExchangeResult({ tags: ['admin-restart'], control: true })],
    });
    expect(control.stats.overall.count).toBe(0);
    expect(validate(control), validate.errors ?? '').toBe(true);
  });

  it('records the gap cap, the dependency flag, and the filter settings', () => {
    const run = makeRun();
    expect(run.pacing).toMatchObject({ max_gap_ms: 30_000, gaps_capped: 0 });
    expect(run.filter).toEqual({ tag: null, include_dependencies: true, dependencies: 0 });
    expect(run.exchanges.every((e) => e.dependency === false)).toBe(true);
    expect(validate(run), validate.errors ?? '').toBe(true);

    const capped = makeRun({
      pacing: { ...run.pacing, max_gap_ms: null, gaps_capped: 0 },
      filter: { tag: 'get-order', include_dependencies: true, dependencies: 2 },
      exchanges: [
        makeExchangeResult({ tags: ['create-order'], dependency: true }),
        makeExchangeResult({ id: fixedUlid(1), tags: ['get-order'] }),
      ],
    });
    expect(RunSchema.parse(capped)).toEqual(capped);
    expect(validate(capped), validate.errors ?? '').toBe(true);
    // A dependency exchange is replayed but not counted, like a warmup exchange.
    expect(capped.stats.overall.count).toBe(1);
    expect(capped.stats.by_tag['create-order']).toBeUndefined();

    expect(PacingSchema.safeParse({ ...run.pacing, max_gap_ms: 0 }).success).toBe(false);
    expect(PacingSchema.safeParse({ ...run.pacing, gaps_capped: -1 }).success).toBe(false);
    const { dependency: _dependency, ...withoutFlag } = makeExchangeResult();
    expect(ExchangeResultSchema.safeParse(withoutFlag).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, filter: { tag: null } }).success).toBe(false);
    expect(validate({ ...run, filter: { tag: null } })).toBe(false);
  });

  it('carries the recording hash, accepts null, and reads a file without the field', () => {
    const sha256 = 'a'.repeat(64);
    const run = makeRun();
    expect(run.recording.recording_sha256).toBeNull();
    expect(validate(run), validate.errors ?? '').toBe(true);
    const hashed = makeRun({ recording: { ...run.recording, recording_sha256: sha256 } });
    expect(RunSchema.parse(hashed)).toEqual(hashed);
    expect(validate(hashed), validate.errors ?? '').toBe(true);
    expect(parseRun(serializeRun(hashed)).recording.recording_sha256).toBe(sha256);
    const { recording_sha256: _hash, ...older } = run.recording;
    const parsed = parseRun(JSON.stringify({ ...run, recording: older }));
    expect(parsed.recording.recording_sha256).toBeUndefined();
    expect(validate({ ...run, recording: older }), validate.errors ?? '').toBe(true);
    const upper = { ...run, recording: { ...run.recording, recording_sha256: 'A'.repeat(64) } };
    expect(RunSchema.safeParse(upper).success).toBe(false);
    expect(validate(upper)).toBe(false);
    const short = { ...run, recording: { ...run.recording, recording_sha256: 'abc' } };
    expect(RunSchema.safeParse(short).success).toBe(false);
    expect(validate(short)).toBe(false);
  });

  it('accepts a stop by signal as an agent stop reason', () => {
    expect(AgentStopReasonSchema.safeParse('aborted').success).toBe(true);
    expect(AgentStopReasonSchema.safeParse('tired').success).toBe(false);
    const run = makeRun({ agent: { ...agent, stop_reason: 'aborted' } });
    expect(RunSchema.parse(run)).toEqual(run);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('serializes and parses', () => {
    const run = makeRun();
    const text = serializeRun(run);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRun(text)).toEqual(run);
  });

  it('names the problem when parsing fails', () => {
    expect(() => parseRun('{oops', 'r.json')).toThrow(ConfigError);
    expect(() => parseRun('{oops', 'r.json')).toThrow(/r\.json: invalid JSON/);
    expect(() =>
      parseRun(JSON.stringify({ ...makeRun(), pacing: { mode: 'slow' } }), 'r.json'),
    ).toThrow(/pacing\.mode/);
  });

  it('migrates on read and names the file when the version is wrong', () => {
    const current = makeRun({ agent });
    expect(current.schema_version).toBe(RUN_SCHEMA_VERSION);
    expect(parseRun(serializeRun(current))).toEqual(current);
    const newer = JSON.stringify({ ...makeRun(), schema_version: RUN_SCHEMA_VERSION + 1 });
    expect(() => parseRun(newer, 'r.json')).toThrow(ConfigError);
    expect(() => parseRun(newer, 'r.json')).toThrow(/^r\.json: .*newer version of rp/);
    const older = JSON.stringify({ ...makeRun(), schema_version: 0 });
    expect(() => parseRun(older, 'r.json')).toThrow(/^r\.json: no migration from version 0/);
    const { schema_version: _v, ...unversioned } = makeRun();
    expect(() => parseRun(JSON.stringify(unversioned), 'r.json')).toThrow(
      /^r\.json: schema_version is missing/,
    );
    expect(() => parseRun('[]', 'r.json')).toThrow(/^r\.json: .*expected object/);
  });

  it('reads a version 1 run written before the sidecar and the scale fields existed', () => {
    const { exchanges_path: _p, ...v2 } = makeRun();
    const v1 = { ...v2, schema_version: 1 };
    const read = parseRun(JSON.stringify(v1), 'v1.json');
    expect(read.schema_version).toBe(2);
    expect(read.exchanges_path).toBeNull();
    expect(read.pacing.session_key).toBeUndefined();
    expect(read.stats.retried).toBeUndefined();
    expect(read.exchanges).toEqual(v1.exchanges);
  });

  it('writes and reads a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-run-'));
    const path = join(dir, 'run.json');
    const run = makeRun();
    await writeRun(path, run);
    expect(await readRun(path)).toEqual(run);
    await expect(readRun(join(dir, 'missing.json'))).rejects.toThrow(ConfigError);
  });

  it('keeps the committed JSON Schema in sync with the zod schema', async () => {
    const committed = await readFile(
      resolve(import.meta.dirname, '../../schema/run.schema.json'),
      'utf8',
    );
    expect(JSON.parse(committed)).toEqual(runJsonSchema());
  });
});

describe('GeneratedCaseSchema', () => {
  const request = { method: 'GET', path: '/v1/orders/{{id}}' };

  it('accepts one to three steps with captures', () => {
    const ok = GeneratedCaseSchema.safeParse({
      hypothesis: 'h',
      tags: ['get-order'],
      steps: [
        {
          request: { method: 'POST', path: '/v1/orders', body: { sku: 'A', qty: 1 } },
          capture: { name: 'id', path: '$.order_id' },
        },
        { request },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects zero or more than three steps, bad capture names, and unknown keys', () => {
    const base = { hypothesis: 'h', tags: ['t'] };
    expect(GeneratedCaseSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(
      GeneratedCaseSchema.safeParse({
        ...base,
        steps: [{ request }, { request }, { request }, { request }],
      }).success,
    ).toBe(false);
    expect(
      GeneratedCaseSchema.safeParse({
        ...base,
        steps: [{ request, capture: { name: 'bad-name', path: '$.x' } }],
      }).success,
    ).toBe(false);
    expect(
      GeneratedCaseSchema.safeParse({
        ...base,
        steps: [{ request, capture: { name: 'ok', path: '$..x' } }],
      }).success,
    ).toBe(false);
    expect(
      GeneratedCaseSchema.safeParse({ hypothesis: 'h', tags: [], steps: [{ request }] }).success,
    ).toBe(false);
    expect(GeneratedCaseSchema.safeParse({ ...base, steps: [{ request }], extra: 1 }).success).toBe(
      false,
    );
  });
});
