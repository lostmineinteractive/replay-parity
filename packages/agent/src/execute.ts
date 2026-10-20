import {
  LATENCY_METRICS,
  canonicalJson,
  exactSummary,
  explainFinding,
  get,
  mergeHeaders,
  dropRedactedHeaders,
  isJsonObject,
  metricValue,
  type CaseLatency,
  type Diff,
  type Differ,
  type GeneratedCase,
  type HeaderMap,
  type JsonValue,
  type LatencyMetric,
  type LatencySummary,
  type RecordedRequest,
  type RecordedResponse,
  type Thresholds,
  type ValueEquivalences,
} from '@replay-parity/core';
import { describeSendError, type Adapter } from '@replay-parity/replay';

/**
 * Runs one case against one system, step by step, resolving `{{name}}` from
 * that system's own captures. Both systems run independently, so a create
 * then get sequence reads each system's own id. A case with `repeat` above 1
 * runs that many times on each system, one run after another, and the
 * latency limits are judged on the percentiles of the sample.
 */
export interface SideResult {
  /** Responses of the first run. */
  responses: RecordedResponse[];
  /** Captures of the first run. */
  captures: Map<string, string | number>;
  /** Final step latency of every run that completed, in order. */
  latencies: number[];
  error: string | null;
}

export interface LatencyBreach {
  /** `latency:<scope>:<metric>_ms`, the dedupe key. */
  key: string;
  scope: string;
  metric: LatencyMetric;
  limit_ms: number;
  measured_ms: number;
}

export interface CaseExecution {
  reference: SideResult;
  candidate: SideResult;
  diff: Diff | null;
  /** Exact percentiles over the runs of each side, or null when a side failed. */
  latency: CaseLatency | null;
  error: string | null;
  latency_breach: string | null;
  dedupe_key: string | null;
  revealed: string;
}

interface Pass {
  responses: RecordedResponse[];
  captures: Map<string, string | number>;
  error: string | null;
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function substituteText(text: string, captures: ReadonlyMap<string, string | number>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = captures.get(name);
    return value === undefined ? whole : String(value);
  });
}

function substituteBody(
  value: JsonValue,
  captures: ReadonlyMap<string, string | number>,
): JsonValue {
  if (typeof value === 'string') {
    const exact = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(value);
    if (exact) {
      const captured = captures.get(exact[1] as string);
      if (captured !== undefined) return captured;
    }
    return substituteText(value, captures);
  }
  if (Array.isArray(value)) return value.map((v) => substituteBody(v, captures));
  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteBody(v, captures);
    return out;
  }
  return value;
}

export function resolveRequest(
  request: RecordedRequest,
  captures: ReadonlyMap<string, string | number>,
  headers: HeaderMap,
): RecordedRequest {
  const query: RecordedRequest['query'] = {};
  for (const [k, v] of Object.entries(request.query)) {
    query[k] = Array.isArray(v)
      ? v.map((x) => substituteText(x, captures))
      : substituteText(v, captures);
  }
  const merged = mergeHeaders(dropRedactedHeaders(request.headers), headers);
  const jsonBody = request.body !== undefined && request.encoding === undefined;
  // A JSON body goes out as JSON. The model is told it does not need to set the header.
  if (jsonBody && merged['content-type'] === undefined) merged['content-type'] = 'application/json';
  const out: RecordedRequest = {
    ...request,
    path: substituteText(request.path, captures),
    query,
    headers: merged,
  };
  if (jsonBody) out.body = substituteBody(request.body as JsonValue, captures);
  return out;
}

async function runOnce(
  c: GeneratedCase,
  adapter: Adapter,
  headers: HeaderMap,
  id: string,
): Promise<Pass> {
  const captures = new Map<string, string | number>();
  const responses: RecordedResponse[] = [];
  for (let i = 0; i < c.steps.length; i += 1) {
    const step = c.steps[i]!;
    const request = resolveRequest(step.request, captures, headers);
    let response: RecordedResponse;
    try {
      response = await adapter.send(request, {
        id: `${id}:${i + 1}`,
        index: i,
        tags: c.tags,
        signal: new AbortController().signal,
      });
    } catch (err) {
      return { responses, captures, error: `step ${i + 1}: ${describeSendError(err)}` };
    }
    responses.push(response);
    if (step.capture) {
      const value = get(response.body, step.capture.path);
      if (typeof value !== 'string' && typeof value !== 'number') {
        return {
          responses,
          captures,
          error: `step ${i + 1}: capture ${step.capture.name} found nothing at ${step.capture.path}`,
        };
      }
      captures.set(step.capture.name, value);
    }
  }
  return { responses, captures, error: null };
}

/** Runs the case `repeat` times, one run after another, and keeps the first run's responses. */
export async function runSide(
  c: GeneratedCase,
  adapter: Adapter,
  headers: HeaderMap,
  id: string,
): Promise<SideResult> {
  const latencies: number[] = [];
  let first: Pass | null = null;
  for (let run = 1; run <= c.repeat; run += 1) {
    const pass = await runOnce(c, adapter, headers, c.repeat === 1 ? id : `${id}:run-${run}`);
    first ??= pass;
    if (pass.error !== null) {
      const error = c.repeat === 1 ? pass.error : `run ${run}: ${pass.error}`;
      return { responses: first.responses, captures: first.captures, latencies, error };
    }
    latencies.push(pass.responses[pass.responses.length - 1]!.latency_ms);
  }
  const done = first as Pass;
  return { responses: done.responses, captures: done.captures, latencies, error: null };
}

/** The pairs of captured values, so the differ treats each system's own id as equivalent. */
function equivalences(reference: SideResult, candidate: SideResult): ValueEquivalences {
  const out = new Map<string, Map<string, string>>();
  for (const [name, refValue] of reference.captures) {
    const candValue = candidate.captures.get(name);
    if (candValue === undefined) continue;
    out.set(`capture:${name}`, new Map([[canonicalJson(refValue), canonicalJson(candValue)]]));
  }
  return out;
}

/**
 * The key a mismatch is deduped on: the sorted set of untolerated paths with
 * array positions folded into `[*]` and a path inside an array cut at the row.
 * A divergence that moves rows around therefore counts once, however many
 * fields differ and however many rows it touches, while two top level fields
 * stay two findings.
 */
export function mismatchKey(paths: readonly string[]): string {
  const keys = new Set<string>();
  for (const path of paths) {
    const folded = path.replace(/\[\d+\]/g, '[*]');
    const row = folded.lastIndexOf('[*]');
    keys.add(row === -1 ? folded : folded.slice(0, row + 3));
  }
  return `mismatch:${[...keys].sort().join(',')}`;
}

/**
 * The first configured limit the sample's percentile exceeds, overall first
 * and then by tag. One run is its own every percentile, so a single sample
 * breaches when it exceeds any limit for its tag or overall.
 */
export function latencyBreach(
  thresholds: Thresholds,
  tags: readonly string[],
  summary: LatencySummary,
): LatencyBreach | null {
  const scopes: [string, Partial<Record<string, number>>][] = [
    ['overall', thresholds.latency.overall],
  ];
  for (const tag of tags) {
    const limits = thresholds.latency.by_tag[tag];
    if (limits) scopes.push([tag, limits]);
  }
  for (const [scope, limits] of scopes) {
    for (const metric of LATENCY_METRICS) {
      const limit = limits[`${metric}_ms`];
      if (limit === undefined) continue;
      const measured = metricValue(summary, metric);
      if (measured > limit) {
        return {
          key: `latency:${scope}:${metric}_ms`,
          scope,
          metric,
          limit_ms: limit,
          measured_ms: measured,
        };
      }
    }
  }
  return null;
}

export function describeBreach(b: LatencyBreach, runs: number): string {
  const limit = `over the ${b.scope} ${b.metric}_ms limit of ${b.limit_ms} ms`;
  return runs === 1
    ? `candidate answered in ${b.measured_ms} ms, ${limit}`
    : `candidate ${b.metric} over ${runs} runs was ${b.measured_ms} ms, ${limit}`;
}

export async function executeCase(
  c: GeneratedCase,
  id: string,
  adapters: { reference: Adapter; candidate: Adapter },
  differ: Differ,
  thresholds: Thresholds,
  headers: HeaderMap = {},
): Promise<CaseExecution> {
  const [reference, candidate] = await Promise.all([
    runSide(c, adapters.reference, headers, `${id}:reference`),
    runSide(c, adapters.candidate, headers, `${id}:candidate`),
  ]);
  const base = { reference, candidate };
  if (reference.error !== null || candidate.error !== null) {
    const error = [
      reference.error === null ? null : `reference ${reference.error}`,
      candidate.error === null ? null : `candidate ${candidate.error}`,
    ]
      .filter((x): x is string => x !== null)
      .join('; ');
    return {
      ...base,
      diff: null,
      latency: null,
      error,
      latency_breach: null,
      dedupe_key: null,
      revealed: error,
    };
  }
  const refFinal = reference.responses[reference.responses.length - 1]!;
  const candFinal = candidate.responses[candidate.responses.length - 1]!;
  const diff = differ.diff(refFinal, candFinal, equivalences(reference, candidate));
  const latency: CaseLatency = {
    reference: exactSummary(reference.latencies),
    candidate: exactSummary(candidate.latencies),
  };
  const breach = latencyBreach(thresholds, c.tags, latency.candidate);
  const untolerated = diff.findings.filter((f) => !f.tolerated);
  let dedupe_key: string | null = null;
  let revealed = 'no difference';
  if (diff.verdict === 'mismatch') {
    dedupe_key = mismatchKey(untolerated.map((f) => f.path));
    revealed = untolerated
      .slice(0, 2)
      .map((f) => explainFinding(f))
      .join(' ');
  } else if (breach !== null) {
    dedupe_key = breach.key;
    revealed = describeBreach(breach, latency.candidate.count);
  }
  return {
    ...base,
    diff,
    latency,
    error: null,
    latency_breach: breach?.key ?? null,
    dedupe_key,
    revealed,
  };
}
