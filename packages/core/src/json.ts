import { createHash } from 'node:crypto';

/**
 * JSON value helpers shared by the recording format, the differ, and the report model.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
// A recursive alias through Record is rejected by TypeScript, so this stays an index signature.
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'undefined';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonType(value: JsonValue | undefined): JsonType {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  return 'boolean';
}

/**
 * Serializes a JSON value with object keys sorted at every level, so two
 * structurally equal values always produce the same string.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Returns a copy of `obj` without the properties whose value is `undefined`.
 * Useful for building objects that must satisfy `exactOptionalPropertyTypes`.
 */
export function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
