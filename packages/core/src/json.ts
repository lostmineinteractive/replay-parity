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

// Lossless numbers

/**
 * A JSON number whose text JavaScript cannot keep, stored as its source
 * text: an integer beyond 2^53, a decimal such as `1.10`, an exponent such as
 * `1e2`, or `-0`. Any number whose `JSON.stringify(Number(text))` differs
 * from its text is one. An object whose only member is `$num` holding a JSON
 * number text is read as a lossless number wherever bodies are compared or
 * sent, so that shape is reserved in stored bodies.
 */
export interface LosslessNumber {
  $num: string;
}

/** The grammar of a JSON number. */
export const JSON_NUMBER_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

export function isLosslessNumber(value: unknown): value is LosslessNumber {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === '$num' &&
    typeof value.$num === 'string' &&
    JSON_NUMBER_TEXT.test(value.$num)
  );
}

/** True when JavaScript keeps a number text through `Number` and `JSON.stringify`. */
export function numberTextRoundTrips(text: string): boolean {
  return JSON.stringify(Number(text)) === text;
}

const NUMBER_AT = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** The end of the string literal that opens at `start`, one past its closing quote. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x5c) {
      i += 2;
    } else if (ch === 0x22) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return i;
}

/** True when some number token in valid JSON text would change through a JavaScript round trip. */
function hasLossyNumber(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x22) {
      i = stringEnd(text, i);
    } else if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      NUMBER_AT.lastIndex = i;
      const token = NUMBER_AT.exec(text)?.[0] ?? '';
      if (token.length === 0) return true;
      if (!numberTextRoundTrips(token)) return true;
      i += token.length;
    } else {
      i += 1;
    }
  }
  return false;
}

/** True when a value holds an object of the reserved `$num` shape. */
export function containsLosslessNumber(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsLosslessNumber);
  if (!isJsonObject(value)) return false;
  if (isLosslessNumber(value)) return true;
  return Object.values(value).some(containsLosslessNumber);
}

/** A parser for text that `JSON.parse` has already accepted, so it checks nothing. */
class LosslessParser {
  private i = 0;
  constructor(private readonly text: string) {}

  parse(): JsonValue {
    return this.value();
  }

  private space(): void {
    while (this.i < this.text.length) {
      const ch = this.text.charCodeAt(this.i);
      if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) return;
      this.i += 1;
    }
  }

  private value(): JsonValue {
    this.space();
    switch (this.text[this.i]) {
      case '{':
        return this.object();
      case '[':
        return this.array();
      case '"':
        return this.string();
      case 't':
        this.i += 4;
        return true;
      case 'f':
        this.i += 5;
        return false;
      case 'n':
        this.i += 4;
        return null;
      default:
        return this.number();
    }
  }

  private string(): string {
    const end = stringEnd(this.text, this.i);
    const value = JSON.parse(this.text.slice(this.i, end)) as string;
    this.i = end;
    return value;
  }

  private number(): JsonValue {
    NUMBER_AT.lastIndex = this.i;
    const token = NUMBER_AT.exec(this.text)?.[0] ?? '';
    this.i += token.length;
    return numberTextRoundTrips(token) ? Number(token) : { $num: token };
  }

  private array(): JsonValue[] {
    this.i += 1;
    const out: JsonValue[] = [];
    this.space();
    if (this.text[this.i] === ']') {
      this.i += 1;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.space();
      // A comma or the closing bracket.
      const ch = this.text[this.i];
      this.i += 1;
      if (ch === ']') return out;
    }
  }

  private object(): JsonObject {
    this.i += 1;
    const out: JsonObject = {};
    this.space();
    if (this.text[this.i] === '}') {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.space();
      const key = this.string();
      this.space();
      // The colon.
      this.i += 1;
      // Defined rather than assigned, so a key such as `__proto__` is an own member as JSON.parse makes it.
      Object.defineProperty(out, key, {
        value: this.value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.space();
      const ch = this.text[this.i];
      this.i += 1;
      if (ch === '}') return out;
    }
  }
}

/**
 * Parses JSON text like `JSON.parse`, except that a number whose text would
 * change through a JavaScript round trip becomes `{"$num": "<text>"}`. Text
 * with no such number gives exactly what `JSON.parse` gives. Throws a
 * `SyntaxError` for text `JSON.parse` rejects.
 */
export function parseJsonLossless(text: string): JsonValue {
  const plain = JSON.parse(text) as JsonValue;
  if (!hasLossyNumber(text)) return plain;
  return new LosslessParser(text).parse();
}

function writeLossless(value: JsonValue): string {
  if (isLosslessNumber(value)) return value.$num;
  if (Array.isArray(value)) return `[${value.map(writeLossless).join(',')}]`;
  if (isJsonObject(value)) {
    const parts = Object.keys(value).map(
      (k) => `${JSON.stringify(k)}:${writeLossless(value[k] as JsonValue)}`,
    );
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Serializes like `JSON.stringify`, except that a lossless number is written
 * as its original text, so `1.10` goes back on the wire as `1.10`.
 */
export function stringifyJsonLossless(value: JsonValue): string {
  return containsLosslessNumber(value) ? writeLossless(value) : JSON.stringify(value);
}
