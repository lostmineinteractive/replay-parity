import { describe, expect, it } from 'vitest';
import { TagRuleError, parseTagRule, tagsFor } from './tag-rules.js';

describe('parseTagRule', () => {
  it('parses rules with and without a method', () => {
    expect(parseTagRule('POST /v1/orders=create-order')).toEqual({
      method: 'POST',
      glob: '/v1/orders',
      tag: 'create-order',
    });
    expect(parseTagRule('/v1/inventory/*/adjust=adjust-stock')).toEqual({
      method: null,
      glob: '/v1/inventory/*/adjust',
      tag: 'adjust-stock',
    });
    expect(parseTagRule('  get /v1/**=read.all ')).toEqual({
      method: 'GET',
      glob: '/v1/**',
      tag: 'read.all',
    });
  });

  it('rejects malformed rules', () => {
    for (const bad of ['', '/v1/orders', '=tag', 'POST=tag', '/a b=tag', '/a=tag with space']) {
      expect(() => parseTagRule(bad), bad).toThrow(TagRuleError);
    }
  });
});

describe('tagsFor', () => {
  const rules = [
    parseTagRule('POST /v1/orders=create-order'),
    parseTagRule('GET /v1/orders/*=get-order'),
    parseTagRule('/v1/inventory=list-inventory'),
    parseTagRule('POST /v1/inventory/*/adjust=adjust-stock'),
  ];

  it('returns the first matching tag or nothing', () => {
    expect(tagsFor(rules, 'POST', '/v1/orders')).toEqual(['create-order']);
    expect(tagsFor(rules, 'get', '/v1/orders/o-1')).toEqual(['get-order']);
    expect(tagsFor(rules, 'GET', '/v1/inventory')).toEqual(['list-inventory']);
    expect(tagsFor(rules, 'POST', '/v1/inventory/A-100/adjust')).toEqual(['adjust-stock']);
    expect(tagsFor(rules, 'GET', '/v1/orders')).toEqual([]);
    expect(tagsFor(rules, 'GET', '/healthz')).toEqual([]);
    expect(tagsFor([], 'GET', '/v1/orders')).toEqual([]);
  });
});
