import { isJsonObject, type JsonValue, type Segment } from '@replay-parity/core';

/**
 * Helpers for changing one value inside a JSON body. A path here is the
 * concrete segments a JSONPath match reports, which are keys and indices.
 */

/** The value at `segments`, or undefined when the path does not lead anywhere. */
export function valueAt(
  doc: JsonValue | undefined,
  segments: readonly Segment[],
): JsonValue | undefined {
  let value: JsonValue | undefined = doc;
  for (const segment of segments) {
    if (value === undefined) return undefined;
    if (segment.type === 'key' && isJsonObject(value)) {
      value = Object.hasOwn(value, segment.name) ? value[segment.name] : undefined;
    } else if (segment.type === 'index' && Array.isArray(value)) {
      value = value[segment.index];
    } else {
      return undefined;
    }
  }
  return value;
}

/** A copy of `doc` with the value at `segments` replaced. A path that leads nowhere returns `doc` unchanged. */
export function setAt(doc: JsonValue, segments: readonly Segment[], value: JsonValue): JsonValue {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (head.type === 'key' && isJsonObject(doc) && Object.hasOwn(doc, head.name)) {
    return { ...doc, [head.name]: setAt(doc[head.name] as JsonValue, rest, value) };
  }
  if (head.type === 'index' && Array.isArray(doc) && head.index < doc.length) {
    return doc.map((item, i) => (i === head.index ? setAt(item, rest, value) : item));
  }
  return doc;
}

/**
 * The smallest value of the same kind: a string becomes "", an array [], an
 * object {}. Undefined when the value is already that, or is not one of those
 * kinds.
 */
export function minimalValue(value: JsonValue): JsonValue | undefined {
  if (typeof value === 'string') return value === '' ? undefined : '';
  if (Array.isArray(value)) return value.length === 0 ? undefined : [];
  if (isJsonObject(value)) return Object.keys(value).length === 0 ? undefined : {};
  return undefined;
}
