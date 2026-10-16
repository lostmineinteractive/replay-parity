import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileRunValidator, makeRun, type RunValidator } from '../testing.js';
import { ConfigError } from '../yaml.js';
import { parseRun, readRun, runJsonSchema, serializeRun, writeRun } from './io.js';
import { GeneratedCaseSchema, RunSchema, type AgentReport } from './schema.js';

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
      dedupe_key: 'mismatch:$.total',
      reference: { status: 201, latency_ms: 3 },
      candidate: { status: 201, latency_ms: 4 },
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
