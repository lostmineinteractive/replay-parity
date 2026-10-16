import { describe, expect, it } from 'vitest';
import { resolvePath, runLoad } from './run.js';
import {
  DEMO_TAG_RULES,
  LOAD_KINDS,
  SCENARIOS,
  SKUS,
  buildPlan,
  type LoadRequest,
} from './scenario.js';

describe('buildPlan', () => {
  it('is reproducible for a seed and runs every scenario', () => {
    const a = buildPlan(7);
    const b = buildPlan(7);
    expect(a).toEqual(b);
    expect(SCENARIOS).toHaveLength(12);
    const blocks = new Set(a.map((s) => s.block));
    for (const name of SCENARIOS) expect(blocks.has(name), name).toBe(true);
    expect(blocks.has('background')).toBe(true);
    expect(blocks.has('final')).toBe(true);
    const kinds = new Set(a.map((s) => s.kind));
    for (const kind of LOAD_KINDS) expect(kinds.has(kind), kind).toBe(true);
    expect(a.length).toBeGreaterThan(250);
    expect(a.length).toBeLessThan(400);
  });

  it('only references orders created earlier and numbers create steps in order', () => {
    const plan = buildPlan(3);
    let creates = 0;
    for (const step of plan) {
      if (step.createIndex !== undefined) {
        expect(step.createIndex).toBe(creates);
        creates += 1;
      }
      if (step.orderRef !== undefined) {
        expect(step.path).toContain('{order}');
        expect(step.orderRef).toBeLessThan(creates);
      } else {
        expect(step.path).not.toContain('{order}');
      }
    }
    expect(creates).toBeGreaterThan(12);
  });

  it('ends with a ledger read, a read of every order, and a ledger read', () => {
    const plan = buildPlan(11);
    const creates = plan.filter((s) => s.createIndex !== undefined).length;
    const tail = plan.slice(-(creates + 2));
    expect(tail[0]).toMatchObject({ kind: 'list-ledger', block: 'final' });
    expect(tail.at(-1)).toMatchObject({ kind: 'list-ledger', block: 'final' });
    const gets = tail.slice(1, -1);
    expect(gets.map((s) => s.orderRef)).toEqual(Array.from({ length: creates }, (_, i) => i));
    expect(gets.every((s) => s.kind === 'get-order' && s.block === 'final')).toBe(true);
  });

  it('reads the ledger after every scenario and includes the retry and restart shapes', () => {
    const plan = buildPlan(5);
    for (const name of SCENARIOS) {
      const idx = plan.findLastIndex((s) => s.block === name);
      expect(plan[idx], name).toMatchObject({ kind: 'list-ledger' });
    }
    const replay = plan.filter(
      (s) => s.block === 'disconnect-and-replay' && s.kind === 'create-order',
    );
    expect(replay).toHaveLength(3);
    const keys = new Set(replay.map((s) => s.headers?.['idempotency-key']));
    expect(keys.size).toBe(1);
    expect(replay[2]?.body?.qty).not.toBe(replay[0]?.body?.qty);
    const restart = plan
      .filter((s) => s.block === 'restart-around-ledger-commit')
      .map((s) => s.kind);
    expect(restart).toEqual([
      'list-ledger',
      'create-order',
      'admin-restart',
      'create-order',
      'list-ledger',
      'get-order',
      'list-ledger',
    ]);
    const race = plan.filter((s) => s.block === 'ship-cancel-race');
    const cancelAt = Date.parse(String(race[1]?.body?.originated_at));
    expect(Date.parse(String(race[2]?.body?.originated_at))).toBeLessThan(cancelAt);
    expect(Date.parse(String(race[3]?.body?.originated_at))).toBeGreaterThan(cancelAt);
    const dup = plan.filter(
      (s) => s.block === 'duplicate-shipment-delivery' && s.kind === 'ship-order',
    );
    expect(dup[0]?.body?.shipment_id).toBe(dup[1]?.body?.shipment_id);
  });

  it('produces valid request shapes', () => {
    for (const r of buildPlan(11)) {
      if (r.kind === 'create-order') {
        expect(r.method).toBe('POST');
        expect(SKUS).toContain(r.body?.sku);
        expect(r.body?.qty).toBeGreaterThanOrEqual(1);
        expect(r.body?.qty).toBeLessThanOrEqual(1000);
      } else if (r.kind === 'adjust-stock') {
        expect(r.path).toMatch(/^\/v1\/inventory\/[A-Z]-\d+\/adjust$/);
        expect(r.body?.delta).not.toBe(0);
      } else if (r.kind === 'ship-order') {
        expect(typeof r.body?.shipment_id).toBe('string');
        expect(Number.isNaN(Date.parse(String(r.body?.originated_at)))).toBe(false);
      } else if (r.kind === 'cancel-order') {
        expect(Number.isNaN(Date.parse(String(r.body?.originated_at)))).toBe(false);
      } else if (r.method === 'GET') {
        expect(r.body).toBeUndefined();
      }
    }
  });

  it('ships tag rules for every kind plus the reset control', () => {
    expect(DEMO_TAG_RULES).toHaveLength(10);
    for (const kind of LOAD_KINDS) {
      expect(
        DEMO_TAG_RULES.some((r) => r.endsWith(`=${kind}`)),
        kind,
      ).toBe(true);
    }
    expect(DEMO_TAG_RULES.some((r) => r.endsWith('=admin-reset'))).toBe(true);
  });
});

describe('resolvePath and runLoad', () => {
  it('fills the order placeholder from created ids', () => {
    const step: LoadRequest = {
      kind: 'get-order',
      method: 'GET',
      path: '/v1/orders/{order}',
      orderRef: 1,
      block: 'x',
    };
    expect(resolvePath(step, ['o-1', 'o-2'])).toBe('/v1/orders/o-2');
    expect(resolvePath(step, ['o-1', null])).toBe('/v1/orders/o-missing');
    expect(
      resolvePath({ kind: 'list-ledger', method: 'GET', path: '/v1/ledger', block: 'x' }, []),
    ).toBe('/v1/ledger');
  });

  it('sends the plan sequentially, resolves ids, and keeps idempotency keys', async () => {
    const calls: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | undefined;
    }[] = [];
    let counter = 0;
    const byKey = new Map<string, string>();
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = init?.headers as Record<string, string>;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: init?.body as string | undefined,
      });
      if (init?.method === 'POST' && url.endsWith('/v1/orders')) {
        const key = headers['idempotency-key'];
        let id = key === undefined ? undefined : byKey.get(key);
        if (id === undefined) {
          counter += 1;
          id = `o-${counter}`;
          if (key !== undefined) byKey.set(key, id);
        }
        return Promise.resolve(new Response(JSON.stringify({ order_id: id }), { status: 201 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    const summary = await runLoad({
      target: 'http://example.test',
      seed: 5,
      minGapMs: 0,
      maxGapMs: 0,
      fetchImpl,
    });
    const plan = buildPlan(5);
    expect(summary.sent).toBe(plan.length);
    expect(calls).toHaveLength(plan.length);
    expect(summary.byStatus['201']).toBe(summary.byKind['create-order']);
    expect(summary.orderIds.length).toBeLessThan(summary.byKind['create-order']);
    expect(summary.createdIds).toHaveLength(summary.byKind['create-order']);
    for (const call of calls) {
      expect(call.url.startsWith('http://example.test/')).toBe(true);
      expect(call.url).not.toContain('{order}');
      expect(call.headers.authorization).toBe('Bearer demo-token');
      if (call.body !== undefined) expect(call.headers['content-type']).toBe('application/json');
    }
    const retried = calls.filter((c) => c.headers['idempotency-key'] !== undefined);
    expect(retried.length).toBeGreaterThanOrEqual(7);
    const finalGets = calls.slice(-(summary.createdIds.length + 1), -1);
    expect(finalGets.every((c) => c.method === 'GET' && /\/v1\/orders\/o-\d+$/.test(c.url))).toBe(
      true,
    );
  });
});
