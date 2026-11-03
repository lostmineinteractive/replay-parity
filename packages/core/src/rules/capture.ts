import { get, parsePath } from '../jsonpath/index.js';
import type { RecordedRequest, RecordedResponse } from '../recording/types.js';
import { compilePattern } from './pattern.js';
import type { SubstitutionCapture } from './schema.js';

/**
 * Reads the value a substitution captures from one side of an exchange. A
 * body capture reads the response body, or the request body with
 * `from: request`. A header capture reads the named response header and,
 * with a pattern, the first group of its first match, or the whole match
 * when the pattern has no group. Only a string or a number is a value.
 */
export function captureValue(
  capture: SubstitutionCapture,
  response: RecordedResponse,
  request?: RecordedRequest,
): string | number | undefined {
  if (capture.header !== undefined) {
    const text = response.headers[capture.header.toLowerCase()];
    if (text === undefined) return undefined;
    if (capture.pattern === undefined) return text;
    const m = compilePattern(capture.pattern).exec(text);
    if (m === null) return undefined;
    return m[1] ?? m[0];
  }
  const body = capture.from === 'request' ? request?.body : response.body;
  const value = get(body, parsePath(capture.path as string));
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/** Where a capture reads: `$.order_id`, `request:$.client_ref`, or `header:location`. */
export function captureSource(capture: SubstitutionCapture): string {
  if (capture.header !== undefined) return `header:${capture.header.toLowerCase()}`;
  return capture.from === 'request'
    ? `request:${capture.path as string}`
    : (capture.path as string);
}

/** The capture in words: `$.order_id from the response body`, `header location through /v1/orders/(.+)$`. */
export function describeCapture(capture: SubstitutionCapture): string {
  if (capture.header !== undefined) {
    const name = capture.header.toLowerCase();
    return capture.pattern === undefined
      ? `header ${name}`
      : `header ${name} through ${capture.pattern}`;
  }
  return `${capture.path as string} from the ${capture.from === 'request' ? 'request' : 'response'} body`;
}
