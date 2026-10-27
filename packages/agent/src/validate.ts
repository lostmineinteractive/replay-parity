import {
  DEFAULT_REDACTED_HEADERS,
  GeneratedCaseSchema,
  REDACTED,
  formatZodError,
  isJsonObject,
  type GeneratedCase,
  type JsonValue,
} from '@replay-parity/core';
import { decodeCase } from './answer.js';

/**
 * Turns a model answer into valid cases. Anything outside the shape is
 * dropped with a reason that goes to the transcript. A schema constrained
 * answer arrives in the answer shape and is decoded first; a plain answer
 * is taken as it is, so both validate the same way.
 */
export interface Dropped {
  index: number;
  reason: string;
}

export interface ValidationResult {
  cases: GeneratedCase[];
  dropped: Dropped[];
  /** Set when the whole answer could not be read. */
  parse_error?: string | undefined;
  proposed: number;
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function parseAnswer(text: string): { cases: unknown[] } | { error: string } {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(body);
  if (fence) body = fence[1] as string;
  const start = body.search(/[[{]/);
  if (start > 0) body = body.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { error: `invalid JSON: ${(err as Error).message}` };
  }
  if (Array.isArray(parsed)) return { cases: parsed };
  if (isJsonObject(parsed) && Array.isArray(parsed.cases)) return { cases: parsed.cases };
  return { error: 'expected an object with a cases array' };
}

function* strings(value: JsonValue | undefined): Generator<string> {
  if (value === undefined) return;
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* strings(item);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) yield* strings(item);
  }
}

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/** Every placeholder in a step must name a capture from an earlier step. */
export function checkPlaceholders(c: GeneratedCase): string | null {
  const captured = new Set<string>();
  for (let i = 0; i < c.steps.length; i += 1) {
    const step = c.steps[i]!;
    const used = new Set<string>();
    for (const name of placeholdersIn(step.request.path)) used.add(name);
    for (const value of Object.values(step.request.query)) {
      for (const v of Array.isArray(value) ? value : [value])
        for (const name of placeholdersIn(v)) used.add(name);
    }
    for (const text of strings(step.request.body))
      for (const name of placeholdersIn(text)) used.add(name);
    for (const name of used) {
      if (!captured.has(name))
        return `step ${i + 1} uses {{${name}}} which no earlier step captured`;
    }
    if (step.capture) captured.add(step.capture.name);
  }
  return null;
}

/** A header with a redacted name must be left out or carry the redaction marker. */
export function checkRedaction(c: GeneratedCase, redacted: readonly string[]): string | null {
  const names = new Set(redacted.map((n) => n.toLowerCase()));
  for (let i = 0; i < c.steps.length; i += 1) {
    for (const [name, value] of Object.entries(c.steps[i]!.request.headers)) {
      if (names.has(name.toLowerCase()) && value !== REDACTED) {
        return `step ${i + 1} sets header ${name.toLowerCase()} to a value other than ${REDACTED}`;
      }
    }
  }
  return null;
}

export function validateCases(
  text: string,
  knownTags: readonly string[],
  redacted: readonly string[] = DEFAULT_REDACTED_HEADERS,
): ValidationResult {
  const parsed = parseAnswer(text);
  if ('error' in parsed) return { cases: [], dropped: [], parse_error: parsed.error, proposed: 0 };
  const cases: GeneratedCase[] = [];
  const dropped: Dropped[] = [];
  const tags = new Set(knownTags);
  parsed.cases.forEach((raw, index) => {
    const decoded = decodeCase(raw);
    if (!decoded.ok) {
      dropped.push({ index, reason: decoded.reason });
      return;
    }
    const result = GeneratedCaseSchema.safeParse(decoded.value);
    if (!result.success) {
      dropped.push({ index, reason: formatZodError(result.error) });
      return;
    }
    const c = result.data;
    const unknown = c.tags.find((t) => !tags.has(t));
    if (unknown !== undefined) {
      dropped.push({ index, reason: `unknown tag ${JSON.stringify(unknown)}` });
      return;
    }
    const placeholder = checkPlaceholders(c);
    if (placeholder !== null) {
      dropped.push({ index, reason: placeholder });
      return;
    }
    const redaction = checkRedaction(c, redacted);
    if (redaction !== null) {
      dropped.push({ index, reason: redaction });
      return;
    }
    cases.push(c);
  });
  return { cases, dropped, proposed: parsed.cases.length };
}
