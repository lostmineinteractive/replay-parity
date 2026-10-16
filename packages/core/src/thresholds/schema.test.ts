import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { emptyThresholds, loadThresholds, parseThresholds } from './schema.js';

const example = `
latency:
  overall: { p50_ms: 20, p99_ms: 80 }
  by_tag:
    create-order: { p99_ms: 120 }
  relative_to_reference:
    p99_ratio_max: 1.5
correctness:
  mismatch_rate_max: 0.001
  by_tag:
    create-order: { mismatch_rate_max: 0 }
errors:
  rate_max: 0.0
`;

describe('parseThresholds', () => {
  it('parses the example from the spec', () => {
    expect(parseThresholds(example)).toEqual({
      latency: {
        overall: { p50_ms: 20, p99_ms: 80 },
        by_tag: { 'create-order': { p99_ms: 120 } },
        relative_to_reference: { p99_ratio_max: 1.5 },
      },
      correctness: {
        mismatch_rate_max: 0.001,
        by_tag: { 'create-order': { mismatch_rate_max: 0 } },
      },
      errors: { rate_max: 0 },
    });
  });

  it('fills every section for an empty file', () => {
    expect(parseThresholds('')).toEqual(emptyThresholds());
    expect(emptyThresholds()).toEqual({
      latency: { overall: {}, by_tag: {}, relative_to_reference: {} },
      correctness: { by_tag: {} },
      errors: {},
    });
  });

  it('accepts every metric name', () => {
    const t = parseThresholds(
      'latency:\n  overall: { p50_ms: 1, p90_ms: 2, p99_ms: 3, p999_ms: 4, max_ms: 5, mean_ms: 6 }\n  relative_to_reference: { p50_ratio_max: 1, p90_ratio_max: 1, p99_ratio_max: 1, p999_ratio_max: 1, max_ratio_max: 1, mean_ratio_max: 1 }\n',
    );
    expect(Object.keys(t.latency.overall)).toHaveLength(6);
    expect(Object.keys(t.latency.relative_to_reference)).toHaveLength(6);
  });

  it('rejects unknown keys and out of range rates', () => {
    expect(() => parseThresholds('latency:\n  overall: { p95_ms: 1 }\n', 't.yaml')).toThrow(
      ConfigError,
    );
    expect(() => parseThresholds('latency:\n  overall: { p95_ms: 1 }\n', 't.yaml')).toThrow(
      /unknown key "p95_ms" at latency\.overall/,
    );
    expect(() => parseThresholds('correctness:\n  mismatch_rate_max: 2\n')).toThrow(
      /correctness\.mismatch_rate_max/,
    );
    expect(() =>
      parseThresholds('latency:\n  relative_to_reference: { p99_ratio_max: 0 }\n'),
    ).toThrow(/p99_ratio_max/);
  });

  it('loads from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-thr-'));
    const path = join(dir, 'thresholds.yaml');
    await writeFile(path, example);
    expect((await loadThresholds(path)).errors.rate_max).toBe(0);
  });
});
