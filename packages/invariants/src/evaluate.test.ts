import {
  jsonResponse,
  makeExchange,
  makeRequest,
  type Exchange,
  type JsonValue,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { formatMilli, parseCommands, parseDecimalMilli } from './order-lifecycle/commands.js';
import { evaluateInvariants } from './evaluate.js';

/** A small recording builder. Each call appends one exchange. */
class Log {
  readonly exchanges: Exchange[] = [];

  add(
    method: 'GET' | 'POST',
    path: string,
    body: JsonValue | null,
    status: number,
    response: JsonValue,
    options: { key?: string; latency?: number } = {},
  ): this {
    const index = this.exchanges.length;
    this.exchanges.push(
      makeExchange({
        index,
        tags: [],
        request: makeRequest({
          method,
          path,
          ...(body === null ? {} : { body }),
          headers: options.key === undefined ? {} : { 'idempotency-key': options.key },
        }),
        response: jsonResponse(response, status, options.latency ?? 1),
      }),
    );
    return this;
  }
}

interface ViewOver {
  status?: string;
  quantity?: number;
  shipped?: number;
  remaining?: number;
  canceled_unshipped?: number;
  canceled_at?: string | null;
  sku?: string;
  unit_price?: number;
}

function view(id: string, over: ViewOver = {}): JsonValue {
  const quantity = over.quantity ?? 3;
  const shipped = over.shipped ?? 0;
  const status =
    over.status ?? (shipped === 0 ? 'OPEN' : shipped >= quantity ? 'SHIPPED' : 'PARTIALLY_SHIPPED');
  const closed = status === 'CANCELED' || status === 'REJECTED';
  return {
    order_id: id,
    status,
    items: [{ sku: over.sku ?? 'A', qty: quantity, unit_price: over.unit_price ?? 2.5 }],
    total: 7.5,
    quantity,
    shipped,
    remaining: over.remaining ?? (closed ? 0 : quantity - shipped),
    canceled_unshipped: over.canceled_unshipped ?? (status === 'CANCELED' ? quantity - shipped : 0),
    created_at: '2026-10-16T12:00:00.000Z',
    canceled_at: over.canceled_at ?? null,
  };
}

function ledger(stock: Record<string, number>, receivables: string): JsonValue {
  const stock_on_hand: Record<string, string> = {};
  for (const [k, v] of Object.entries(stock)) stock_on_hand[k] = String(v);
  return { stock_on_hand, receivables };
}

function shipmentView(
  id: string,
  orderId: string,
  quantity: number,
  over: ViewOver = {},
): JsonValue {
  return {
    shipment_id: id,
    order_id: orderId,
    quantity,
    originated_at: 'T',
    status: over.status ?? 'PARTIALLY_SHIPPED',
    shipped: over.shipped ?? quantity,
    remaining: over.remaining ?? 0,
  };
}

const T1 = '2026-10-16T12:00:01.000Z';
const T5 = '2026-10-16T12:00:05.000Z';
const T9 = '2026-10-16T12:00:09.000Z';

/** A healthy sequence: one order, one shipment, consistent reads. */
function healthy(): Log {
  return new Log()
    .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'))
    .add('POST', '/v1/orders', { sku: 'A', qty: 3 }, 201, view('o-1'))
    .add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-1', quantity: 2, originated_at: T1 },
      201,
      shipmentView('s-1', 'o-1', 2, { shipped: 2, remaining: 1 }),
    )
    .add('GET', '/v1/orders/o-1', null, 200, view('o-1', { shipped: 2 }))
    .add('GET', '/v1/ledger', null, 200, ledger({ A: 8 }, '5.000'));
}

function result(log: Log, id: number) {
  const report = evaluateInvariants(log.exchanges, { system: 'test' });
  return report.results.find((r) => r.id === id)!;
}

describe('parsing helpers', () => {
  it('parses and formats decimal thousandths exactly', () => {
    expect(parseDecimalMilli('29.985')).toBe(29985);
    expect(parseDecimalMilli('5')).toBe(5000);
    expect(parseDecimalMilli('-1.5')).toBe(-1500);
    expect(parseDecimalMilli('0.1')).toBe(100);
    expect(parseDecimalMilli('1.2345')).toBeNull();
    expect(parseDecimalMilli('abc')).toBeNull();
    expect(formatMilli(29985)).toBe('29.985');
    expect(formatMilli(-5)).toBe('-0.005');
  });

  it('maps exchanges to commands and leaves the rest as other', () => {
    const commands = parseCommands(healthy().exchanges);
    expect(commands.map((c) => c.kind)).toEqual([
      'read-ledger',
      'create',
      'shipment',
      'read-order',
      'read-ledger',
    ]);
    const other = parseCommands(
      new Log()
        .add('GET', '/healthz', null, 200, { ok: true })
        .add('POST', '/v1/orders', { nope: 1 }, 400, { error: 'invalid_request' })
        .add('POST', '/v1/orders/o-1/cancel', {}, 400, { error: 'invalid_request' })
        .add('POST', '/admin/restart', null, 200, { restarted: true })
        .add('POST', '/admin/reset', null, 200, { reset: true })
        .add('GET', '/v1/inventory', null, 200, { items: [{ sku: 'A', on_hand: 4 }] })
        .add('POST', '/v1/inventory/A/adjust', { delta: 2 }, 200, { sku: 'A', on_hand: 6 })
        .exchanges,
    );
    expect(other.map((c) => c.kind)).toEqual([
      'other',
      'other',
      'other',
      'restart',
      'reset',
      'read-inventory',
      'adjust',
    ]);
    const create = commands[1]!;
    expect(create.kind === 'create' && create.payload).toBe('{"qty":3,"sku":"A"}');
    expect(commands[0]!.ackedMs).toBe(1);
  });
});

describe('evaluateInvariants on a healthy recording', () => {
  it('holds every applicable rule and marks the rest not applicable', () => {
    const report = evaluateInvariants(healthy().exchanges, { system: 'ref', recording: 'r.jsonl' });
    expect(report.system).toBe('ref');
    expect(report.recording).toBe('r.jsonl');
    expect(report.violations).toBe(0);
    expect(report.inconclusive).toEqual([]);
    expect(report.commands).toBe(2);
    expect(report.snapshots).toEqual({ ledger_reads: 2, stock_reads: 2, order_reads: 1 });
    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      [1, 'holds'],
      [2, 'holds'],
      [3, 'holds'],
      [4, 'holds'],
      [5, 'holds'],
      [6, 'holds'],
      [7, 'not_applicable'],
      [8, 'not_applicable'],
      [9, 'holds'],
      [10, 'holds'],
    ]);
    expect(report.results.every((r) => r.evidence.length === 0)).toBe(true);
    expect(report.results[0]?.statement).toMatch(/exactly once/);
  });

  it('is not applicable everywhere on an empty recording', () => {
    const report = evaluateInvariants([]);
    expect(report.results.every((r) => r.status === 'not_applicable')).toBe(true);
    expect(report.violations).toBe(0);
  });
});

describe('rule 1, shipment applied once', () => {
  it('catches a repeated delivery that was applied again', () => {
    const log = healthy().add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-1', quantity: 2, originated_at: T1 },
      201,
      shipmentView('s-1', 'o-1', 2, { shipped: 2, remaining: 1 }),
    );
    expect(result(log, 1).status).toBe('holds');
    log.add('GET', '/v1/orders/o-1', null, 200, view('o-1', { shipped: 4, quantity: 4 }));
    const r = result(log, 1);
    expect(r.status).toBe('violated');
    expect(r.checks).toBe(1);
    expect(r.evidence[0]).toMatchObject({ subject: 'order o-1', expected: 2, observed: 4 });
    expect(r.evidence[0]?.detail).toContain('s-1 delivered 2 times');
  });
});

describe('rule 2, shipped within quantity', () => {
  it('catches an over shipped view, an accepted over delivery, and a quantity below shipped', () => {
    const over = healthy().add(
      'GET',
      '/v1/orders/o-1',
      null,
      200,
      view('o-1', { shipped: 5, remaining: -2 }),
    );
    expect(result(over, 2).evidence[0]).toMatchObject({
      expected: 'shipped at most 3',
      observed: 5,
    });

    const beyond = healthy().add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-2', quantity: 2, originated_at: T1 },
      201,
      shipmentView('s-2', 'o-1', 2),
    );
    expect(result(beyond, 2).evidence[0]).toMatchObject({
      subject: 'shipment s-2',
      expected: 'quantity at most 1',
      observed: 2,
    });

    const below = healthy().add(
      'POST',
      '/v1/orders/o-1/quantity',
      { quantity: 1 },
      200,
      view('o-1', { quantity: 1, shipped: 2, remaining: -1 }),
    );
    expect(
      result(below, 2).evidence.some((e) => e.detail.includes('below the shipped amount')),
    ).toBe(true);
  });
});

describe('rule 3, shipped never decreases', () => {
  it('catches a view where shipped went down', () => {
    const log = healthy().add('GET', '/v1/orders/o-1', null, 200, view('o-1', { shipped: 0 }));
    const r = result(log, 3);
    expect(r.status).toBe('violated');
    expect(r.evidence[0]).toMatchObject({ expected: 'shipped at least 2', observed: 0 });
    expect(result(healthy(), 3)).toMatchObject({ status: 'holds', checks: 1 });
  });
});

describe('rule 4, remaining arithmetic and cancellation', () => {
  it('catches wrong remaining, a quantity that is not the last accepted one, and canceled quantities', () => {
    const wrong = healthy().add(
      'GET',
      '/v1/orders/o-1',
      null,
      200,
      view('o-1', { shipped: 2, remaining: 3 }),
    );
    expect(result(wrong, 4).evidence[0]?.detail).toBe('remaining is not total minus shipped');

    const additive = healthy().add(
      'POST',
      '/v1/orders/o-1/quantity',
      { quantity: 5 },
      200,
      view('o-1', { quantity: 8, shipped: 2 }),
    );
    expect(result(additive, 4).evidence[0]).toMatchObject({ expected: 5, observed: 8 });

    const canceled = healthy()
      .add(
        'POST',
        '/v1/orders/o-1/cancel',
        { originated_at: T5 },
        200,
        view('o-1', { status: 'CANCELED', shipped: 2, canceled_at: T5 }),
      )
      .add(
        'GET',
        '/v1/orders/o-1',
        null,
        200,
        view('o-1', {
          status: 'CANCELED',
          shipped: 2,
          canceled_at: T5,
          remaining: 1,
          canceled_unshipped: 3,
        }),
      );
    const evidence = result(canceled, 4).evidence;
    expect(evidence.map((e) => e.detail)).toEqual([
      'remaining after CANCELED',
      'unshipped canceled quantity is not total minus shipped',
    ]);
  });

  it('expects pre cancel shipments to be applied and post cancel shipments to be rejected', () => {
    const base = () =>
      healthy().add(
        'POST',
        '/v1/orders/o-1/cancel',
        { originated_at: T5 },
        200,
        view('o-1', { status: 'CANCELED', shipped: 2, canceled_at: T5 }),
      );
    const dropped = base().add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-2', quantity: 1, originated_at: T1 },
      409,
      { error: 'order_canceled' },
    );
    expect(result(dropped, 4).evidence[0]).toMatchObject({
      subject: 'shipment s-2',
      expected: 'accepted',
      observed: 'rejected with 409',
    });
    const late = base().add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-3', quantity: 1, originated_at: T9 },
      201,
      shipmentView('s-3', 'o-1', 1, { status: 'CANCELED', shipped: 3 }),
    );
    expect(result(late, 4).evidence[0]).toMatchObject({
      expected: 'rejected',
      observed: 'accepted with 201',
    });
    const fine = base()
      .add(
        'POST',
        '/v1/orders/o-1/shipments',
        { shipment_id: 's-2', quantity: 1, originated_at: T1 },
        201,
        shipmentView('s-2', 'o-1', 1, { status: 'CANCELED', shipped: 3 }),
      )
      .add(
        'POST',
        '/v1/orders/o-1/shipments',
        { shipment_id: 's-3', quantity: 1, originated_at: T9 },
        409,
        { error: 'order_canceled' },
      );
    expect(result(fine, 4).status).toBe('holds');
  });
});

describe('rule 5, stock on hand', () => {
  it('localizes a wrong stock delta to the interval and names what happened in it', () => {
    const log = healthy()
      .add('POST', '/v1/inventory/A/adjust', { delta: -1 }, 200, { sku: 'A', on_hand: 7 })
      .add(
        'POST',
        '/v1/orders/o-1/shipments',
        { shipment_id: 's-1', quantity: 2, originated_at: T1 },
        201,
        shipmentView('s-1', 'o-1', 2),
      )
      .add('GET', '/v1/inventory', null, 200, { items: [{ sku: 'A', on_hand: 5 }] });
    const r = result(log, 5);
    expect(r.status).toBe('violated');
    expect(r.checks).toBe(2);
    expect(r.evidence[0]).toMatchObject({ expected: -1, observed: -3 });
    expect(r.evidence[0]?.detail).toContain('adjust -1, shipment s-1 delivered again');
    expect(result(healthy(), 5)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('is not applicable with fewer than two stock reads and inconclusive for unknown orders', () => {
    const one = new Log().add('GET', '/v1/ledger', null, 200, ledger({ A: 1 }, '0.000'));
    expect(result(one, 5).status).toBe('not_applicable');
    const unknown = new Log()
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'))
      .add(
        'POST',
        '/v1/orders/o-9/shipments',
        { shipment_id: 'x', quantity: 1, originated_at: T1 },
        201,
        shipmentView('x', 'o-9', 1),
      )
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 9 }, '1.000'));
    expect(result(unknown, 5).status).toBe('inconclusive');
  });
});

describe('rule 6, receivables', () => {
  it('compares receivable deltas in decimal', () => {
    const log = healthy().add('GET', '/v1/ledger', null, 200, ledger({ A: 8 }, '7.500'));
    const r = result(log, 6);
    expect(r.status).toBe('violated');
    expect(r.evidence[0]).toMatchObject({ expected: '0.000', observed: '2.500' });
    expect(result(healthy(), 6)).toMatchObject({ status: 'holds', checks: 1 });
  });
});

describe('rule 7, rejected orders', () => {
  it('flags an accepted shipment on a rejected order', () => {
    const log = new Log()
      .add('POST', '/v1/orders', { sku: 'A', qty: 3 }, 201, view('o-1', { status: 'REJECTED' }))
      .add(
        'POST',
        '/v1/orders/o-1/shipments',
        { shipment_id: 's-1', quantity: 1, originated_at: T1 },
        409,
        { error: 'invalid_state' },
      );
    expect(result(log, 7)).toMatchObject({ status: 'holds', checks: 1 });
    log.add(
      'POST',
      '/v1/orders/o-1/shipments',
      { shipment_id: 's-2', quantity: 1, originated_at: T1 },
      201,
      shipmentView('s-2', 'o-1', 1),
    );
    expect(result(log, 7).evidence[0]).toMatchObject({ observed: 'shipment s-2 accepted' });
  });
});

describe('rule 8, idempotency keys', () => {
  const create = (log: Log, id: string, qty: number, key: string, status = 201) =>
    log.add(
      'POST',
      '/v1/orders',
      { sku: 'A', qty },
      status,
      status === 201 ? view(id, { quantity: qty }) : { error: 'idempotency_conflict' },
      { key },
    );

  it('holds for a clean retry and a rejected conflict', () => {
    const log = new Log();
    create(log, 'o-1', 3, 'k');
    create(log, 'o-1', 3, 'k');
    create(log, 'o-1', 4, 'k', 409);
    expect(result(log, 8)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a second order, an accepted conflicting payload, and a rejected retry', () => {
    const second = new Log();
    create(second, 'o-1', 3, 'k');
    create(second, 'o-2', 3, 'k');
    expect(result(second, 8).evidence[0]).toMatchObject({
      expected: 'one order',
      observed: ['o-1', 'o-2'],
    });

    const conflict = new Log();
    create(conflict, 'o-1', 3, 'k');
    create(conflict, 'o-2', 4, 'k');
    expect(result(conflict, 8).evidence.some((e) => e.detail.includes('different payloads'))).toBe(
      true,
    );

    const rejectedRetry = new Log();
    create(rejectedRetry, 'o-1', 3, 'k');
    create(rejectedRetry, 'o-1', 3, 'k', 409);
    expect(result(rejectedRetry, 8).evidence[0]?.detail).toContain(
      'retry with the same payload was rejected',
    );
  });
});

describe('rule 9, retries never reset state', () => {
  it('counts orders against distinct creates and keys', () => {
    const log = new Log()
      .add('POST', '/v1/orders', { sku: 'A', qty: 1 }, 201, view('o-1', { quantity: 1 }))
      .add('POST', '/v1/orders', { sku: 'A', qty: 2 }, 201, view('o-2', { quantity: 2 }), {
        key: 'k',
      })
      .add('POST', '/admin/restart', null, 200, { restarted: true })
      .add('POST', '/v1/orders', { sku: 'A', qty: 2 }, 201, view('o-3', { quantity: 2 }), {
        key: 'k',
      });
    const r = result(log, 9);
    expect(r.status).toBe('violated');
    expect(r.evidence[0]).toMatchObject({ subject: 'orders created', expected: 2, observed: 3 });
    expect(r.evidence[0]?.detail).toContain('o-3 (key k)');
  });

  it('flags a repeated delivery that answers differently and an order that vanished', () => {
    const log = healthy()
      .add(
        'POST',
        '/v1/orders/o-1/shipments',
        { shipment_id: 's-1', quantity: 2, originated_at: T1 },
        201,
        shipmentView('s-1', 'o-1', 5),
      )
      .add('GET', '/v1/orders/o-1', null, 404, { error: 'not_found' });
    const r = result(log, 9);
    expect(r.evidence.map((e) => e.subject)).toEqual(['shipment s-1', 'order o-1']);
    expect(r.evidence[1]?.observed).toBe('status 404');
  });
});

describe('rule 10, allocation', () => {
  it('recomputes the decision from the stock baseline and live allocations', () => {
    const log = new Log()
      .add('POST', '/v1/orders', { sku: 'A', qty: 6 }, 201, view('o-1', { quantity: 6 }))
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'))
      .add(
        'POST',
        '/v1/orders',
        { sku: 'A', qty: 5 },
        201,
        view('o-2', { quantity: 5, status: 'REJECTED' }),
      )
      .add('POST', '/v1/orders', { sku: 'A', qty: 4 }, 201, view('o-3', { quantity: 4 }));
    expect(result(log, 10)).toMatchObject({ status: 'holds', checks: 3 });
    log.add('POST', '/v1/orders', { sku: 'A', qty: 1 }, 201, view('o-4', { quantity: 1 }));
    const r = result(log, 10);
    expect(r.status).toBe('violated');
    expect(r.evidence[0]).toMatchObject({
      subject: 'order o-4',
      expected: 'REJECTED',
      observed: 'OPEN',
    });
    expect(r.evidence[0]?.detail).toBe(
      'qty 1 against 0 available (10 on hand, 10 allocated to live orders)',
    );
  });

  it('is inconclusive without a stock read for the sku', () => {
    const log = new Log().add(
      'POST',
      '/v1/orders',
      { sku: 'Z', qty: 1 },
      201,
      view('o-1', { sku: 'Z', quantity: 1 }),
    );
    expect(result(log, 10)).toMatchObject({ status: 'inconclusive', checks: 1 });
  });
});

describe('epochs and completion', () => {
  it('starts a new epoch at an accepted reset', () => {
    const log = healthy()
      .add('POST', '/admin/reset', null, 200, { reset: true })
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'))
      .add('POST', '/v1/orders', { sku: 'A', qty: 3 }, 201, view('o-1'))
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'));
    const report = evaluateInvariants(log.exchanges);
    expect(report.violations).toBe(0);
    expect(report.results.find((r) => r.id === 5)).toMatchObject({ status: 'holds', checks: 2 });
    expect(report.results.find((r) => r.id === 9)).toMatchObject({ status: 'holds', checks: 2 });
  });

  it('names snapshot_before_ack when a command was in flight at the final ledger read', () => {
    const log = new Log()
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'))
      .add('POST', '/v1/orders', { sku: 'A', qty: 3 }, 201, view('o-1'), { latency: 500 })
      .add('GET', '/v1/ledger', null, 200, ledger({ A: 10 }, '0.000'));
    const report = evaluateInvariants(log.exchanges);
    expect(report.inconclusive).toEqual([
      {
        kind: 'snapshot_before_ack',
        detail: expect.stringContaining('1 accepted command was still in flight') as string,
      },
    ]);
    expect(evaluateInvariants(healthy().exchanges).inconclusive).toEqual([]);
  });
});
