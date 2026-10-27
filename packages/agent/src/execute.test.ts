import { REDACTED, exactSummary, makeRequest, parseThresholds } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  describeBreach,
  latencyBreach,
  mismatchKey,
  resolveRequest,
  substituteRequest,
} from './execute.js';

describe('substituteRequest and resolveRequest', () => {
  const captures = new Map<string, string | number>([
    ['id', 'o-7'],
    ['qty', 3],
  ]);
  const request = makeRequest({
    method: 'POST',
    path: '/v1/orders/{{id}}/lines',
    query: { expand: '{{id}}', fields: ['total', '{{missing}}'] },
    headers: { Authorization: REDACTED, 'X-Trace': 't-1' },
    body: { order: '{{id}}', qty: '{{qty}}', note: 'order {{id}} x{{qty}}' },
  });

  it('resolves captures everywhere, defaults the JSON content type, and keeps the redaction marker', () => {
    const substituted = substituteRequest(request, captures);
    expect(substituted.path).toBe('/v1/orders/o-7/lines');
    expect(substituted.query).toEqual({ expand: 'o-7', fields: ['total', '{{missing}}'] });
    // An exact placeholder keeps the captured type, a placeholder inside text becomes text.
    expect(substituted.body).toEqual({ order: 'o-7', qty: 3, note: 'order o-7 x3' });
    expect(substituted.headers).toEqual({
      authorization: REDACTED,
      'x-trace': 't-1',
      'content-type': 'application/json',
    });
    // The input is left alone.
    expect(request.headers).toEqual({ Authorization: REDACTED, 'X-Trace': 't-1' });
  });

  it('sends without the redacted header and with the caller supplied headers on top', () => {
    const sent = resolveRequest(request, captures, { 'X-Trace': 't-2', authorization: 'Bearer t' });
    expect(sent.headers).toEqual({
      'x-trace': 't-2',
      'content-type': 'application/json',
      authorization: 'Bearer t',
    });
    expect(sent.path).toBe('/v1/orders/o-7/lines');
    const noBody = resolveRequest(makeRequest({ method: 'GET', path: '/x' }), new Map(), {});
    expect(noBody.headers).toEqual({});
    expect(noBody.body).toBeUndefined();
  });
});

describe('mismatchKey', () => {
  it('sorts and dedupes top level paths', () => {
    expect(mismatchKey(['$.total'])).toBe('mismatch:$.total');
    expect(mismatchKey(['status', '$', 'status'])).toBe('mismatch:$,status');
    expect(mismatchKey(['$.b', '$.a'])).toBe('mismatch:$.a,$.b');
  });

  it('folds array positions and cuts a path inside an array at the row', () => {
    expect(mismatchKey(['$.items[0].name', '$.items[1].name'])).toBe('mismatch:$.items[*]');
    expect(mismatchKey(['$.items[3].on_hand', '$.items[5].sku'])).toBe('mismatch:$.items[*]');
    expect(mismatchKey(['$.items[2].lines[4].qty'])).toBe('mismatch:$.items[*].lines[*]');
    expect(mismatchKey(['$.items[0].sku', '$.total'])).toBe('mismatch:$.items[*],$.total');
    expect(mismatchKey(['$.items[0]'])).toBe('mismatch:$.items[*]');
  });
});

describe('latencyBreach', () => {
  const thresholds = parseThresholds(
    'latency:\n  overall: { p99_ms: 100 }\n  by_tag:\n    create-order: { p50_ms: 10, max_ms: 50 }\n',
  );

  it('names the first scope and metric a sample exceeds, overall before the tag', () => {
    const one = (ms: number) => exactSummary([ms]);
    expect(latencyBreach(thresholds, ['create-order'], one(5))).toBeNull();
    expect(latencyBreach(thresholds, ['create-order'], one(20))).toMatchObject({
      key: 'latency:create-order:p50_ms',
      scope: 'create-order',
      metric: 'p50',
      limit_ms: 10,
      measured_ms: 20,
    });
    expect(latencyBreach(thresholds, ['get-order'], one(20))).toBeNull();
    expect(latencyBreach(thresholds, ['get-order'], one(200))?.key).toBe('latency:overall:p99_ms');
  });

  it('judges a repeated case on the percentiles of the sample', () => {
    // Five fast runs and five slow ones: the p50 stays under its limit, the max does not.
    const sample = exactSummary([1, 2, 3, 4, 5, 60, 61, 62, 63, 64]);
    expect(sample.p50_ms).toBe(5);
    const breach = latencyBreach(thresholds, ['create-order'], sample);
    expect(breach).toMatchObject({ key: 'latency:create-order:max_ms', measured_ms: 64 });
    expect(describeBreach(breach!, 10)).toBe(
      'candidate max over 10 runs was 64 ms, over the create-order max_ms limit of 50 ms',
    );
    expect(describeBreach({ ...breach!, measured_ms: 12 }, 1)).toBe(
      'candidate answered in 12 ms, over the create-order max_ms limit of 50 ms',
    );
  });
});
