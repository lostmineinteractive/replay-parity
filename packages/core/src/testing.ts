import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import type { JsonValue } from './json.js';
import type { Exchange, RecordedRequest, RecordedResponse } from './recording/types.js';
import { emptyRules } from './rules/schema.js';
import { StatsCollector } from './stats/collector.js';
import { evaluateThresholds } from './thresholds/evaluate.js';
import { emptyThresholds } from './thresholds/schema.js';
import { RUN_SCHEMA_VERSION, type ExchangeResult, type Run } from './run/schema.js';
import { decideVerdict } from './run/verdict.js';
import { encodeTime } from './ulid.js';

/**
 * Builders for tests across the workspace. Not used by the tool itself.
 */

export function makeRequest(over: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    method: 'GET',
    path: '/v1/items',
    query: {},
    headers: {},
    ...over,
  };
}

export function makeResponse(over: Partial<RecordedResponse> = {}): RecordedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    latency_ms: 10,
    body: { ok: true },
    ...over,
  };
}

export function jsonResponse(body: JsonValue, status = 200, latency_ms = 10): RecordedResponse {
  return makeResponse({ body, status, latency_ms });
}

const BASE_TS = Date.UTC(2026, 9, 16, 18, 22, 3, 123);

export function fixedUlid(index: number): string {
  return `${encodeTime(BASE_TS + index)}${'0'.repeat(16 - String(index).length)}${index}`;
}

export function makeExchange(over: Partial<Exchange> & { index?: number } = {}): Exchange {
  const { index = 0, ...rest } = over;
  return {
    id: fixedUlid(index),
    ts: new Date(BASE_TS + index * 100).toISOString(),
    offset_ms: index * 100,
    adapter: 'http',
    request: makeRequest(),
    response: makeResponse(),
    tags: ['get-items'],
    ...rest,
  };
}

export function makeExchangeResult(over: Partial<ExchangeResult> = {}): ExchangeResult {
  return {
    id: fixedUlid(0),
    tags: ['get-items'],
    method: 'GET',
    path: '/v1/items',
    warmup: false,
    control: false,
    dependency: false,
    scheduled_at_ms: 0,
    sent_at_ms: 1,
    acked_at_ms: 13,
    reference: { status: 200, latency_ms: 10 },
    candidate: { status: 200, latency_ms: 12 },
    error: null,
    diff: { verdict: 'match', findings: [] },
    ...over,
  };
}

/** Builds a small, internally consistent run with three exchanges. */
export function makeRun(over: Partial<Run> = {}): Run {
  const exchanges: ExchangeResult[] = over.exchanges ?? [
    makeExchangeResult({ id: fixedUlid(0), scheduled_at_ms: 0, sent_at_ms: 1, acked_at_ms: 13 }),
    makeExchangeResult({
      id: fixedUlid(1),
      tags: ['create-item'],
      method: 'POST',
      path: '/v1/items',
      scheduled_at_ms: 100,
      sent_at_ms: 103,
      acked_at_ms: 128,
      reference: { status: 201, latency_ms: 20 },
      candidate: { status: 201, latency_ms: 25 },
      diff: {
        verdict: 'mismatch',
        findings: [
          {
            path: '$.total',
            kind: 'value',
            tolerated: false,
            reference: 12.38,
            candidate: 12.37,
            detail: 'no tolerance rule covers this path',
          },
        ],
      },
    }),
    makeExchangeResult({
      id: fixedUlid(2),
      scheduled_at_ms: 200,
      sent_at_ms: 200,
      acked_at_ms: null,
      candidate: null,
      error: 'connect ECONNREFUSED',
      diff: null,
    }),
  ];
  const collector = new StatsCollector();
  for (const e of exchanges) {
    if (e.warmup || e.control || e.dependency) continue;
    collector.record({
      tags: e.tags,
      verdict: e.diff?.verdict ?? null,
      candidateLatencyMs: e.candidate?.latency_ms ?? null,
      referenceLatencyMs: e.reference.latency_ms,
    });
  }
  const stats = over.stats ?? collector.finish();
  const thresholds = over.thresholds ?? emptyThresholds();
  const pacing: Run['pacing'] = over.pacing ?? {
    mode: 'as-recorded',
    rps: null,
    concurrency: 4,
    requested_rps: null,
    achieved_rps: 10,
    slip_p50_ms: 1,
    slip_max_ms: 3,
    barrier_tags: [],
    barrier_timeout_ms: 10_000,
    barrier_waits: 0,
    max_gap_ms: 30_000,
    gaps_capped: 0,
  };
  const evaluation = evaluateThresholds(thresholds, stats, { slip_max_ms: pacing.slip_max_ms });
  const inconclusive = over.inconclusive ?? evaluation.inconclusive;
  const verdict = decideVerdict({ threshold_results: evaluation.results, inconclusive });
  return {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: fixedUlid(99),
    created_at: new Date(BASE_TS).toISOString(),
    verdict,
    inconclusive,
    recording: {
      path: 'recording.jsonl',
      exchanges: exchanges.length,
      selected: exchanges.length,
      first_ts: new Date(BASE_TS).toISOString(),
      last_ts: new Date(BASE_TS + 200).toISOString(),
      recording_sha256: null,
    },
    target: 'http://localhost:3001',
    adapter: 'http',
    pacing,
    warmup: 0,
    filter: { tag: null, include_dependencies: true, dependencies: 0 },
    limit: null,
    duration_ms: 300,
    rules: emptyRules(),
    thresholds,
    threshold_results: evaluation.results,
    stats,
    exchanges,
    exchanges_path: null,
    candidate_recording: null,
    invariants: { reference: null, candidate: null },
    reproduction: null,
    ...over,
  };
}

function interopDefault<T>(mod: unknown): T {
  // CommonJS modules arrive either as { default: exports } or as the exports value itself.
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    return interopDefault<T>(mod.default);
  }
  return mod as T;
}

export interface RunValidator {
  (data: unknown): boolean;
  errors: string | null;
}

/** Compiles the run JSON Schema with ajv (draft 2020-12). For tests only; ajv is a dev dependency. */
export async function compileRunValidator(): Promise<RunValidator> {
  const ajvModule = await import('ajv/dist/2020.js');
  const formatsModule = await import('ajv-formats');
  const Ajv = interopDefault<typeof Ajv2020>(ajvModule);
  const addFormats = interopDefault<FormatsPlugin>(formatsModule);
  const { runJsonSchema } = await import('./run/io.js');
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(runJsonSchema());
  const validator = ((data: unknown): boolean => {
    const ok = validate(data) === true;
    validator.errors = ok ? null : ajv.errorsText(validate.errors, { separator: '; ' });
    return ok;
  }) as RunValidator;
  validator.errors = null;
  return validator;
}
