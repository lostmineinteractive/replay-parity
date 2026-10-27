import { Buffer } from 'node:buffer';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, type JsonValue } from '../json.js';
import { makeExchange } from '../testing.js';
import type { BodyFields } from './body.js';
import { RecordingParseError, parseRecordingText } from './reader.js';
import type { Exchange, Query, RecordedRequest, RecordedResponse } from './types.js';

/**
 * Property based tests for the recording reader. Fixed seed, see
 * ../differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

const KEYS = ['a', 'b', 'items', 'a b', ''];
const scalar: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1000, max: 1000 }),
  fc
    .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
    .map((x) => (x === 0 ? 0 : x)),
  fc.string({ unit: 'grapheme', maxLength: 6 }),
);
const { value: jsonValue } = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 2, depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 3 }).map((d) => ({ ...d })),
  ),
}));

const hex64 = fc
  .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(''));

/** Every body form the schema accepts: absent, JSON, JSON with a coding note, base64, truncated. */
const bodyArb: fc.Arbitrary<BodyFields> = fc.oneof(
  fc.constant({}),
  jsonValue.map((body) => ({ body })),
  fc
    .tuple(jsonValue, fc.constantFrom('gzip', 'br', 'gzip, br'))
    .map(([body, content_encoding]) => ({ body, content_encoding })),
  fc
    .uint8Array({ maxLength: 8 })
    .map((b) => ({ body: Buffer.from(b).toString('base64'), encoding: 'base64' as const })),
  fc
    .tuple(hex64, fc.nat({ max: 10_000_000 }))
    .map(([body_sha256, body_size]) => ({ truncated: true as const, body_sha256, body_size })),
);

const headersArb = fc
  .dictionary(
    fc.constantFrom('content-type', 'x-a', 'authorization'),
    fc.string({ maxLength: 8 }),
    { maxKeys: 3 },
  )
  .map((h) => ({ ...h }));
const queryArb: fc.Arbitrary<Query> = fc
  .dictionary(
    fc.constantFrom('a', 'b', 'ids'),
    fc.oneof(fc.string({ maxLength: 4 }), fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 })),
    { maxKeys: 3 },
  )
  .map((q) => ({ ...q }));

const requestArb: fc.Arbitrary<RecordedRequest> = fc
  .tuple(
    fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'),
    fc.array(fc.constantFrom('v1', 'orders', 'o-1', 'a b'), { maxLength: 3 }),
    queryArb,
    headersArb,
    bodyArb,
  )
  .map(([method, segs, query, headers, body]) => ({
    method,
    path: `/${segs.join('/')}`,
    query,
    headers,
    ...body,
  }));

const responseArb: fc.Arbitrary<RecordedResponse> = fc
  .tuple(
    fc.integer({ min: 100, max: 599 }),
    headersArb,
    fc.double({ min: 0, max: 10_000, noNaN: true }).map((x) => (x === 0 ? 0 : x)),
    bodyArb,
  )
  .map(([status, headers, latency_ms, body]) => ({ status, headers, latency_ms, ...body }));

const tagsArb = fc.array(fc.constantFrom('a', 'b', 'create-order'), { maxLength: 3 });

/** A list of exchanges whose offsets never decrease. */
const exchangesArb = fc
  .array(fc.tuple(fc.nat({ max: 500 }), requestArb, responseArb, tagsArb), {
    minLength: 1,
    maxLength: 8,
  })
  .map((rows) => {
    let offset = 0;
    return rows.map(([gap, request, response, tags], index) => {
      offset += gap;
      return makeExchange({ index, offset_ms: offset, request, response, tags });
    });
  });

interface Layout {
  /** Blank lines placed before each row. */
  blanks: number[];
  newline: string;
  trailing: boolean;
}

function layoutArb(rows: number): fc.Arbitrary<Layout> {
  return fc.record({
    blanks: fc.array(fc.nat({ max: 2 }), { minLength: rows, maxLength: rows }),
    newline: fc.constantFrom('\n', '\r\n'),
    trailing: fc.boolean(),
  });
}

function serialize(exchanges: readonly Exchange[], layout: Layout): string {
  const lines: string[] = [];
  exchanges.forEach((e, i) => {
    for (let b = 0; b < (layout.blanks[i] ?? 0); b += 1) lines.push(b % 2 === 0 ? '' : '   ');
    lines.push(JSON.stringify(e));
  });
  return lines.join(layout.newline) + (layout.trailing ? layout.newline : '');
}

/** The 1 based line of row `index` under the layout. */
function lineOf(layout: Layout, index: number): number {
  let line = 0;
  for (let i = 0; i <= index; i += 1) line += (layout.blanks[i] ?? 0) + 1;
  return line;
}

const withLayout = exchangesArb.chain((exchanges) =>
  fc.tuple(fc.constant(exchanges), layoutArb(exchanges.length)),
);

describe('parseRecordingText properties', () => {
  it('round trips any list of exchanges with non decreasing offsets', () => {
    fc.assert(
      fc.property(withLayout, ([exchanges, layout]) => {
        const parsed = parseRecordingText(serialize(exchanges, layout));
        expect(parsed).toEqual(exchanges);
        expect(canonicalJson(parsed as unknown as JsonValue)).toBe(
          canonicalJson(exchanges as unknown as JsonValue),
        );
      }),
      params,
    );
  });

  it('rejects a list where one offset decreases and names the line', () => {
    const cases = withLayout
      .filter(([exchanges]) => exchanges.length >= 2)
      .chain(([exchanges, layout]) =>
        fc
          .tuple(fc.integer({ min: 1, max: exchanges.length - 1 }), fc.nat({ max: 500 }))
          .map(([at, drop]) => ({ exchanges, layout, at, drop })),
      )
      .filter(({ exchanges, at }) => (exchanges[at - 1] as Exchange).offset_ms > 0);
    fc.assert(
      fc.property(cases, ({ exchanges, layout, at, drop }) => {
        const previous = (exchanges[at - 1] as Exchange).offset_ms;
        const lower = Math.max(0, previous - 1 - drop);
        const broken = exchanges.map((e, i) => (i === at ? { ...e, offset_ms: lower } : e));
        const text = serialize(broken, layout);
        const line = lineOf(layout, at);
        let caught: unknown;
        try {
          parseRecordingText(text);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(RecordingParseError);
        const error = caught as RecordingParseError;
        expect(error.line).toBe(line);
        expect(error.message).toBe(
          `recording line ${line}: offset_ms ${lower} is lower than the previous offset ${previous}`,
        );
      }),
      params,
    );
  });
});
