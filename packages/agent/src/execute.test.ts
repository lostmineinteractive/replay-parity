import { parseThresholds } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { latencyBreach, mismatchKey } from './execute.js';

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

  it('names the first scope and metric a sample exceeds, by tag before overall', () => {
    expect(latencyBreach(thresholds, ['create-order'], 5)).toBeNull();
    expect(latencyBreach(thresholds, ['create-order'], 20)).toBe('latency:create-order:p50_ms');
    expect(latencyBreach(thresholds, ['get-order'], 20)).toBeNull();
    expect(latencyBreach(thresholds, ['get-order'], 200)).toBe('latency:overall:p99_ms');
  });
});
