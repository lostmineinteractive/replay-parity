import {
  jsonResponse,
  makeExchange,
  makeRequest,
  makeResponse,
  parseDiffRules,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { DependencyIndex, SubstitutionTable } from './substitutions.js';

const rules = parseDiffRules(
  'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n  - name: shipment\n    capture: { tag: ship-order, path: "$.shipment_id" }\n    apply: [body]\n',
).substitutions;

const create = (index: number, id: string) =>
  makeExchange({
    index,
    tags: ['create-order'],
    request: makeRequest({ method: 'POST', path: '/v1/orders', body: { sku: 'A', qty: 1 } }),
    response: jsonResponse({ order_id: id }, 201),
  });

const selected = [
  create(0, 'o-1'),
  makeExchange({
    index: 1,
    tags: ['get-order'],
    request: makeRequest({ path: '/v1/orders/o-1' }),
    response: jsonResponse({ order_id: 'o-1' }),
  }),
  create(2, 'o-2'),
  makeExchange({
    index: 3,
    tags: ['ship-order'],
    request: makeRequest({
      method: 'POST',
      path: '/v1/orders/o-2/shipments',
      query: { ref: 'o-1', ids: ['o-2', 'x'] },
      body: { shipment_id: 's-1', order: 'o-1', nested: { list: ['o-2', 7] } },
    }),
    response: jsonResponse({ shipment_id: 's-1' }, 201),
  }),
  create(4, 'o-1'),
  makeExchange({
    index: 5,
    tags: ['get-order'],
    request: makeRequest({ path: '/v1/orders/o-12' }),
    response: jsonResponse({ error: 'not_found' }, 404),
  }),
];

describe('DependencyIndex', () => {
  const index = new DependencyIndex(selected, rules);

  it('finds the first producer of each value used by a request', () => {
    expect(index.dependenciesOf(1, selected[1]!.request)).toEqual([0]);
    expect(index.dependenciesOf(3, selected[3]!.request)).toEqual([0, 2]);
  });

  it('ignores values produced later, by itself, or never', () => {
    expect(index.dependenciesOf(0, selected[0]!.request)).toEqual([]);
    expect(index.dependenciesOf(5, selected[5]!.request)).toEqual([]);
    // o-12 is not o-1: whole segments only.
    expect(index.dependenciesOf(5, makeRequest({ path: '/v1/orders/o-12' }))).toEqual([]);
  });

  it('answers the same when built one exchange at a time in recording order', () => {
    const streamed = new DependencyIndex([], rules);
    expect(streamed.empty).toBe(false);
    selected.forEach((exchange, i) => {
      expect(streamed.dependenciesOf(i, exchange.request)).toEqual(
        index.dependenciesOf(i, exchange.request),
      );
      streamed.add(exchange, i);
    });
    expect(new DependencyIndex(selected, []).empty).toBe(true);
  });

  it('respects the apply list', () => {
    // The shipment rule applies to bodies only, so a path segment equal to s-1 is no dependency.
    expect(index.dependenciesOf(4, makeRequest({ path: '/v1/shipments/s-1' }))).toEqual([]);
    expect(
      index.dependenciesOf(4, makeRequest({ method: 'POST', path: '/x', body: { id: 's-1' } })),
    ).toEqual([3]);
  });

  it('matches numbers written as path text', () => {
    const numeric = [
      makeExchange({
        index: 0,
        tags: ['create-order'],
        response: jsonResponse({ order_id: 41 }, 201),
      }),
    ];
    const idx = new DependencyIndex(numeric, rules);
    expect(idx.dependenciesOf(1, makeRequest({ path: '/v1/orders/41' }))).toEqual([0]);
    expect(idx.dependenciesOf(1, makeRequest({ path: '/v1/orders/410' }))).toEqual([]);
  });
});

describe('SubstitutionTable', () => {
  it('captures pairs and applies them to path, query, and body', () => {
    const table = new SubstitutionTable(rules);
    expect(table.apply(selected[3]!.request)).toBe(selected[3]!.request);
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-9' }),
    );
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-2' }),
      jsonResponse({ order_id: 'o-2' }),
    );
    table.capture(
      ['ship-order'],
      jsonResponse({ shipment_id: 's-1' }),
      jsonResponse({ shipment_id: 'S1' }),
    );
    expect(table.size).toBe(3);
    const applied = table.apply(selected[3]!.request);
    expect(applied.path).toBe('/v1/orders/o-2/shipments');
    expect(applied.query).toEqual({ ref: 'o-9', ids: ['o-2', 'x'] });
    expect(applied.body).toEqual({ shipment_id: 'S1', order: 'o-9', nested: { list: ['o-2', 7] } });
    expect(selected[3]!.request.body).toEqual({
      shipment_id: 's-1',
      order: 'o-1',
      nested: { list: ['o-2', 7] },
    });
    expect(table.apply(makeRequest({ path: '/v1/shipments/s-1' })).path).toBe('/v1/shipments/s-1');
  });

  it('keeps the first candidate value for a reference value', () => {
    const table = new SubstitutionTable(rules);
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-1' }),
    );
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-2' }),
    );
    expect(table.apply(makeRequest({ path: '/v1/orders/o-1' })).path).toBe('/v1/orders/o-1');
    expect(table.equivalences.get('order_id')?.get('"o-1"')).toBe('"o-1"');
  });

  it('ignores exchanges without the tag or without the value on both sides', () => {
    const table = new SubstitutionTable(rules);
    table.capture(
      ['get-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-2' }),
    );
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ error: 'x' }, 500),
    );
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: { nested: 1 } }),
      jsonResponse({ order_id: 'o-2' }),
    );
    expect(table.size).toBe(0);
  });

  it('leaves binary bodies alone', () => {
    const table = new SubstitutionTable(rules);
    table.capture(
      ['create-order'],
      jsonResponse({ order_id: 'o-1' }),
      jsonResponse({ order_id: 'o-2' }),
    );
    const binary = makeRequest({ method: 'POST', path: '/x', body: 'by0x', encoding: 'base64' });
    expect(table.apply(binary).body).toBe('by0x');
  });
});

describe('header and request captures', () => {
  const headerRules = parseDiffRules(
    [
      'substitutions:',
      '  - name: order_ref',
      '    capture: { tag: create-order, header: Location, pattern: "/v1/orders/([^/?]+)" }',
      '  - name: client_ref',
      '    capture: { tag: create-order, from: request, path: "$.client_ref" }',
      '    apply: [body]',
    ].join('\n'),
  ).substitutions;

  it('captures the first group of the pattern on a response header', () => {
    const table = new SubstitutionTable(headerRules);
    table.capture(
      ['create-order'],
      makeResponse({ status: 201, headers: { location: '/v1/orders/o-1' } }),
      makeResponse({ status: 201, headers: { location: '/v1/orders/c-9?x=1' } }),
    );
    expect(table.apply(makeRequest({ path: '/v1/orders/o-1' })).path).toBe('/v1/orders/c-9');
    expect(table.equivalences.get('order_ref')?.get('"o-1"')).toBe('"c-9"');
  });

  it('records nothing for a header that is absent or does not match on either side', () => {
    const table = new SubstitutionTable(headerRules);
    table.capture(
      ['create-order'],
      makeResponse({ headers: { location: '/v1/orders/o-1' } }),
      makeResponse({ headers: { location: '/elsewhere' } }),
    );
    table.capture(
      ['create-order'],
      makeResponse({ headers: {} }),
      makeResponse({ headers: { location: '/v1/orders/o-2' } }),
    );
    expect(table.size).toBe(0);
  });

  it('captures a request path from the recorded request and the request as sent', () => {
    const recorded = makeRequest({ method: 'POST', body: { client_ref: 'r-1' } });
    const sent = makeRequest({ method: 'POST', body: { client_ref: 'r-2' } });
    const table = new SubstitutionTable(headerRules);
    table.capture(['create-order'], jsonResponse({}), jsonResponse({}), { recorded, sent });
    expect(table.apply(makeRequest({ body: { ref: 'r-1' } })).body).toEqual({ ref: 'r-2' });

    // A bare request stands for both sides; without one a request capture records nothing.
    const same = new SubstitutionTable(headerRules);
    same.capture(['create-order'], jsonResponse({}), jsonResponse({}), recorded);
    expect(same.equivalences.get('client_ref')?.get('"r-1"')).toBe('"r-1"');
    const none = new SubstitutionTable(headerRules);
    none.capture(['create-order'], jsonResponse({}), jsonResponse({}));
    expect(none.size).toBe(0);
  });

  it('indexes header and request producers for the dependency wait', () => {
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['create-order'],
        request: makeRequest({ method: 'POST', body: { client_ref: 'r-1' } }),
        response: makeResponse({ status: 201, headers: { location: '/v1/orders/o-1' } }),
      }),
      makeExchange({ index: 1, request: makeRequest({ path: '/v1/orders/o-1' }) }),
      makeExchange({ index: 2, request: makeRequest({ method: 'POST', body: { c: 'r-1' } }) }),
    ];
    const index = new DependencyIndex(exchanges, headerRules);
    expect(index.dependenciesOf(1, exchanges[1]!.request)).toEqual([0]);
    expect(index.dependenciesOf(2, exchanges[2]!.request)).toEqual([0]);
  });
});
