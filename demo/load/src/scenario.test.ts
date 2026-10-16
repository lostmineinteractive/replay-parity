import { describe, expect, it } from 'vitest';
import { runLoad } from './run.js';
import { DEMO_TAG_RULES, SKUS, createScenario, type LoadKind } from './scenario.js';

describe('createScenario', () => {
  it('is reproducible for a seed and covers every kind', () => {
    const a = createScenario(7);
    const b = createScenario(7);
    const ids = ['o-1', 'o-2'];
    const seqA = Array.from({ length: 50 }, () => a.next(ids));
    const seqB = Array.from({ length: 50 }, () => b.next(ids));
    expect(seqA).toEqual(seqB);
    const kinds = new Set(seqA.map((r) => r.kind));
    expect([...kinds].sort()).toEqual([
      'adjust-stock',
      'create-order',
      'get-order',
      'list-inventory',
    ]);
  });

  it('creates orders until ids exist, then looks them up, including unknown ids', () => {
    const s = createScenario(3);
    const noIds = Array.from({ length: 40 }, () => s.next([]));
    expect(noIds.some((r) => r.kind === 'get-order')).toBe(false);
    const withIds = Array.from({ length: 400 }, () => s.next(['o-1']));
    const gets = withIds.filter((r) => r.kind === 'get-order');
    expect(gets.length).toBeGreaterThan(50);
    expect(gets.some((r) => r.path === '/v1/orders/o-1')).toBe(true);
    expect(gets.some((r) => /\/v1\/orders\/o-9\d\d\d$/.test(r.path))).toBe(true);
  });

  it('produces valid request shapes', () => {
    const s = createScenario(11);
    for (const r of Array.from({ length: 200 }, () => s.next(['o-5']))) {
      if (r.kind === 'create-order') {
        expect(r.method).toBe('POST');
        expect(SKUS).toContain(r.body?.sku);
        expect(r.body?.qty).toBeGreaterThanOrEqual(1);
        expect(r.body?.qty).toBeLessThanOrEqual(6);
      } else if (r.kind === 'adjust-stock') {
        expect(r.path).toMatch(/^\/v1\/inventory\/[A-Z]-\d+\/adjust$/);
        expect(r.body?.delta).not.toBe(0);
      } else {
        expect(r.method).toBe('GET');
        expect(r.body).toBeUndefined();
      }
    }
  });

  it('ships tag rules for the four kinds', () => {
    expect(DEMO_TAG_RULES).toHaveLength(4);
    for (const kind of ['create-order', 'get-order', 'list-inventory', 'adjust-stock']) {
      expect(DEMO_TAG_RULES.some((r) => r.endsWith(`=${kind}`))).toBe(true);
    }
  });
});

describe('runLoad', () => {
  it('sends sequentially, tracks ids and statuses, and sends the demo auth header', async () => {
    const calls: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | undefined;
    }[] = [];
    let counter = 0;
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
        counter += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ order_id: `o-${counter}` }), { status: 201 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    const summary = await runLoad({
      target: 'http://example.test',
      count: 40,
      seed: 5,
      minGapMs: 0,
      maxGapMs: 0,
      fetchImpl,
    });
    expect(summary.sent).toBe(40);
    expect(calls).toHaveLength(40);
    expect(summary.orderIds.length).toBe(summary.byKind['create-order']);
    expect(summary.byStatus['201']).toBe(summary.byKind['create-order']);
    expect(summary.latenciesMs).toHaveLength(40);
    const total = (Object.keys(summary.byKind) as LoadKind[]).reduce(
      (n, k) => n + summary.byKind[k],
      0,
    );
    expect(total).toBe(40);
    for (const call of calls) {
      expect(call.url.startsWith('http://example.test/')).toBe(true);
      expect(call.headers.authorization).toBe('Bearer demo-token');
      if (call.method === 'POST') expect(call.headers['content-type']).toBe('application/json');
    }
  });
});
