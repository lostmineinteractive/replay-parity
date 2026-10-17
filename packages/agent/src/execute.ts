import {
  LATENCY_METRICS,
  canonicalJson,
  explainFinding,
  get,
  mergeHeaders,
  dropRedactedHeaders,
  isJsonObject,
  type Diff,
  type Differ,
  type GeneratedCase,
  type HeaderMap,
  type JsonValue,
  type RecordedRequest,
  type RecordedResponse,
  type Thresholds,
  type ValueEquivalences,
} from '@replay-parity/core';
import { describeSendError, type Adapter } from '@replay-parity/replay';

/**
 * Runs one case against one system, step by step, resolving `{{name}}` from
 * that system's own captures. Both systems run independently, so a create
 * then get sequence reads each system's own id.
 */
export interface SideResult {
  responses: RecordedResponse[];
  captures: Map<string, string | number>;
  error: string | null;
}

export interface CaseExecution {
  reference: SideResult;
  candidate: SideResult;
  diff: Diff | null;
  error: string | null;
  latency_breach: string | null;
  dedupe_key: string | null;
  revealed: string;
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

export async function runSide(
  c: GeneratedCase,
  adapter: Adapter,
  headers: HeaderMap,
  id: string,
): Promise<SideResult> {
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

/** A single sample breaches when it exceeds any configured absolute limit for its tag or overall. */
export function latencyBreach(
  thresholds: Thresholds,
  tags: readonly string[],
  latencyMs: number,
): string | null {
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
      if (limit !== undefined && latencyMs > limit) return `latency:${scope}:${metric}_ms`;
    }
  }
  return null;
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
    return { ...base, diff: null, error, latency_breach: null, dedupe_key: null, revealed: error };
  }
  const refFinal = reference.responses[reference.responses.length - 1]!;
  const candFinal = candidate.responses[candidate.responses.length - 1]!;
  const diff = differ.diff(refFinal, candFinal, equivalences(reference, candidate));
  const breach = latencyBreach(thresholds, c.tags, candFinal.latency_ms);
  const untolerated = diff.findings.filter((f) => !f.tolerated);
  let dedupe_key: string | null = null;
  let revealed = 'no difference';
  if (diff.verdict === 'mismatch') {
    dedupe_key = `mismatch:${[...new Set(untolerated.map((f) => f.path))].sort().join(',')}`;
    revealed = untolerated
      .slice(0, 2)
      .map((f) => explainFinding(f))
      .join(' ');
  } else if (breach !== null) {
    dedupe_key = breach;
    revealed = `candidate answered in ${candFinal.latency_ms} ms, over the ${breach.split(':').slice(1).join(' ')} limit`;
  }
  return { ...base, diff, error: null, latency_breach: breach, dedupe_key, revealed };
}
