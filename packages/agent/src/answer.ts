import {
  GeneratedCaseSchema,
  GeneratedCaseStepSchema,
  MAX_CASE_REPEAT,
  isJsonObject,
  type JsonValue,
} from '@replay-parity/core';
import { z } from 'zod';

/**
 * The shape the model answers with under a schema constrained call. It is
 * the case schema with the three open ended parts of a request encoded in a
 * form a constrained decoder can produce: `query` and `headers` as lists of
 * name and value pairs instead of maps, and the body as JSON text in
 * `body_json` instead of a JSON value. Structured outputs accept neither a
 * map with arbitrary keys nor a recursive schema, and a JSON value is both.
 *
 * `decodeCase` turns an answer in this shape back into the case schema and
 * leaves an answer in the plain shape alone, so a free text answer from the
 * mock client still validates. Every other field is taken from the case
 * schema itself, so the two cannot drift apart.
 */
const PairSchema = z.object({ name: z.string().min(1), value: z.string() }).strict();

export const AnswerRequestSchema = z
  .object({
    method: z.string().min(1),
    path: z.string().startsWith('/'),
    query: z.array(PairSchema).optional(),
    headers: z.array(PairSchema).optional(),
    body_json: z.string().optional(),
  })
  .strict();

export const AnswerStepSchema = z
  .object({
    request: AnswerRequestSchema,
    capture: GeneratedCaseStepSchema.shape.capture,
  })
  .strict();

export const AnswerCaseSchema = z
  .object({
    hypothesis: GeneratedCaseSchema.shape.hypothesis,
    tags: GeneratedCaseSchema.shape.tags,
    steps: z.array(AnswerStepSchema).min(1).max(3),
    repeat: z.number().int().min(1).max(MAX_CASE_REPEAT).optional(),
  })
  .strict();

export const AnswerSchema = z.object({ cases: z.array(AnswerCaseSchema) }).strict();

export type Answer = z.output<typeof AnswerSchema>;

export type Decoded = { ok: true; value: unknown } | { ok: false; reason: string };

function isPair(value: unknown): value is { name: string; value: string } {
  return (
    isJsonObject(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.value === 'string'
  );
}

/** A list of pairs as a map. A repeated name becomes a list of values when `multi` is set, else the last value wins. */
function pairsToMap(
  pairs: unknown[],
  multi: boolean,
  lowerCase: boolean,
): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (const pair of pairs) {
    if (!isPair(pair)) return null;
    const name = lowerCase ? pair.name.toLowerCase() : pair.name;
    const previous = out[name];
    if (previous === undefined || !multi) {
      out[name] = pair.value;
    } else {
      out[name] = Array.isArray(previous) ? [...previous, pair.value] : [previous, pair.value];
    }
  }
  return out;
}

function decodeRequest(request: unknown, step: number): Decoded {
  if (!isJsonObject(request)) return { ok: true, value: request };
  const out: Record<string, JsonValue> = { ...request };
  if (Array.isArray(request.query)) {
    const query = pairsToMap(request.query, true, false);
    if (query === null) {
      return { ok: false, reason: `step ${step} query must be a list of {name, value} pairs` };
    }
    out.query = query;
  }
  if (Array.isArray(request.headers)) {
    const headers = pairsToMap(request.headers, false, true);
    if (headers === null) {
      return { ok: false, reason: `step ${step} headers must be a list of {name, value} pairs` };
    }
    out.headers = headers;
  }
  if ('body_json' in request) {
    if (typeof request.body_json !== 'string') {
      return { ok: false, reason: `step ${step} body_json must be a string of JSON text` };
    }
    if ('body' in request) return { ok: false, reason: `step ${step} has both body and body_json` };
    delete out.body_json;
    const text = request.body_json.trim();
    if (text.length > 0) {
      try {
        out.body = JSON.parse(text) as JsonValue;
      } catch (err) {
        return {
          ok: false,
          reason: `step ${step} body_json is not valid JSON: ${(err as Error).message}`,
        };
      }
    }
  }
  return { ok: true, value: out };
}

/**
 * Brings one raw case from the answer shape to the case shape. A case that
 * is not an object, or whose steps are not a list, is returned as it is so
 * the case schema reports the problem in its own words.
 */
export function decodeCase(raw: unknown): Decoded {
  if (!isJsonObject(raw) || !Array.isArray(raw.steps)) return { ok: true, value: raw };
  const steps: JsonValue[] = [];
  for (let i = 0; i < raw.steps.length; i += 1) {
    const step = raw.steps[i];
    if (!isJsonObject(step)) {
      steps.push(step as JsonValue);
      continue;
    }
    const request = decodeRequest(step.request, i + 1);
    if (!request.ok) return request;
    steps.push({ ...step, request: request.value as JsonValue });
  }
  return { ok: true, value: { ...raw, steps } };
}
