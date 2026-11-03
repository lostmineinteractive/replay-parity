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
pacing:
  slip_max_ms: 250
`;

describe('parseThresholds', () => {
  it('parses the example from the spec', () => {
    expect(parseThresholds(example)).toEqual({
      latency: {
        min_samples: 1,
        overall: { p50_ms: 20, p99_ms: 80 },
        by_tag: { 'create-order': { p99_ms: 120 } },
        relative_to_reference: { p99_ratio_max: 1.5 },
      },
      correctness: {
        mismatch_rate_max: 0.001,
        by_tag: { 'create-order': { mismatch_rate_max: 0 } },
      },
      errors: { rate_max: 0 },
      pacing: { slip_max_ms: 250 },
      invariants: { fail_on_violation: true },
    });
  });

  it('fills every section for an empty file', () => {
    expect(parseThresholds('')).toEqual(emptyThresholds());
    expect(emptyThresholds()).toEqual({
      latency: { min_samples: 1, overall: {}, by_tag: {}, relative_to_reference: {} },
      correctness: { by_tag: {} },
      errors: {},
      pacing: {},
      invariants: { fail_on_violation: true },
    });
    expect(parseThresholds('invariants:\n  fail_on_violation: false\n').invariants).toEqual({
      fail_on_violation: false,
    });
    expect(() => parseThresholds('invariants:\n  gate: true\n')).toThrow(/unknown key "gate"/);
  });

  it('accepts min_samples at the latency level and inside each block', () => {
    const t = parseThresholds(
      'latency:\n  min_samples: 20\n  overall: { p99_ms: 1, min_samples: 5 }\n  by_tag:\n    a: { p99_ms: 1, min_samples: 2 }\n',
    );
    expect(t.latency.min_samples).toBe(20);
    expect(t.latency.overall.min_samples).toBe(5);
    expect(t.latency.by_tag.a?.min_samples).toBe(2);
    expect(() => parseThresholds('latency:\n  min_samples: 0\n')).toThrow(/latency\.min_samples/);
    expect(() => parseThresholds('latency:\n  overall: { min_samples: 1.5 }\n')).toThrow(
      /min_samples/,
    );
    expect(() => parseThresholds('pacing:\n  slip_max_ms: -1\n')).toThrow(/pacing\.slip_max_ms/);
    expect(() => parseThresholds('pacing:\n  slip_p50_ms: 1\n')).toThrow(/unknown key/);
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

  it('parses the completed matrix and leaves every new key absent when unused', () => {
    const t = parseThresholds(
      [
        'latency:',
        '  relative_to_reference:',
        '    p99_ratio_max: 1.5',
        '    by_tag:',
        '      a: { p50_ratio_max: 1.2 }',
        'errors:',
        '  by_tag:',
        '    a: { rate_max: 0.01 }',
        'throughput: { achieved_rps_min: 1 }',
      ].join('\n'),
    );
    expect(t.latency.relative_to_reference).toEqual({
      p99_ratio_max: 1.5,
      by_tag: { a: { p50_ratio_max: 1.2 } },
    });
    expect(t.errors.by_tag).toEqual({ a: { rate_max: 0.01 } });
    expect(t.throughput).toEqual({ achieved_rps_min: 1 });
    expect(t.status).toBeUndefined();
    const s = parseThresholds(
      "status:\n  by_tag:\n    get-order: { '404': { rate_max: 0.05 }, '500': { rate_max: 0 } }\n",
    );
    expect(s.status).toEqual({
      by_tag: { 'get-order': { '404': { rate_max: 0.05 }, '500': { rate_max: 0 } } },
    });
    expect(() =>
      parseThresholds("status:\n  by_tag:\n    a: { '4xx': { rate_max: 0 } }\n"),
    ).toThrow(/invalid key in record at status\.by_tag\.a\.4xx/i);
    expect(() =>
      parseThresholds("status:\n  by_tag:\n    a: { '404': { rate_max: 2 } }\n"),
    ).toThrow(/rate_max/);
    expect(() => parseThresholds('throughput: { achieved_rps_min: -1 }\n')).toThrow(
      /achieved_rps_min/,
    );
    expect(() => parseThresholds('errors:\n  by_tag:\n    a: { rate: 0 }\n')).toThrow(
      /unknown key/,
    );
  });

  it('loads from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-thr-'));
    const path = join(dir, 'thresholds.yaml');
    await writeFile(path, example);
    expect((await loadThresholds(path)).errors.rate_max).toBe(0);
  });
});
