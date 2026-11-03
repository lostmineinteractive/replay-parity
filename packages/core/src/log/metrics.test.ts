import { describe, expect, it } from 'vitest';
import { HISTOGRAM_EDGES_MS } from '../stats/histogram.js';
import {
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  formatMetricValue,
  replayMetrics,
} from './metrics.js';

describe('MetricsRegistry', () => {
  it('renders counters and gauges with help and type lines in registration order', () => {
    const registry = new MetricsRegistry();
    const sent = registry.counter('rp_sent_total', 'Sent.');
    const inflight = registry.gauge('rp_inflight', 'In flight.');
    sent.inc();
    sent.inc(2);
    inflight.set(5);
    inflight.inc();
    inflight.dec(3);
    expect(registry.render()).toBe(
      [
        '# HELP rp_sent_total Sent.',
        '# TYPE rp_sent_total counter',
        'rp_sent_total 3',
        '# HELP rp_inflight In flight.',
        '# TYPE rp_inflight gauge',
        'rp_inflight 3',
        '',
      ].join('\n'),
    );
    expect(sent.value).toBe(3);
    expect(inflight.value).toBe(3);
    expect(registry.names()).toEqual(['rp_sent_total', 'rp_inflight']);
  });

  it('renders a histogram with cumulative buckets, +Inf, sum, and count', () => {
    const registry = new MetricsRegistry();
    const h = registry.histogram('lat_ms', 'Latency.', [1, 10, 100]);
    for (const v of [0.5, 1, 7, 10.5, 1000]) h.observe(v);
    expect(h.buckets()).toEqual([2, 3, 4]);
    expect(h.count).toBe(5);
    expect(h.sum).toBe(1019);
    expect(h.edges).toEqual([1, 10, 100]);
    expect(registry.render()).toBe(
      [
        '# HELP lat_ms Latency.',
        '# TYPE lat_ms histogram',
        'lat_ms_bucket{le="1"} 2',
        'lat_ms_bucket{le="10"} 3',
        'lat_ms_bucket{le="100"} 4',
        'lat_ms_bucket{le="+Inf"} 5',
        'lat_ms_sum 1019',
        'lat_ms_count 5',
        '',
      ].join('\n'),
    );
  });

  it('returns the same metric for the same name and refuses a different kind', () => {
    const registry = new MetricsRegistry();
    const a = registry.counter('c', 'first');
    const b = registry.counter('c', 'second');
    expect(a).toBe(b);
    expect(() => registry.gauge('c', 'x')).toThrow(/already registered as a counter/);
    expect(() => registry.histogram('c', 'x', [1])).toThrow(RangeError);
  });

  it('rejects bad names, edges, and values', () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter('1bad', 'x')).toThrow(/invalid metric name/);
    expect(() => registry.counter('has space', 'x')).toThrow(RangeError);
    expect(() => registry.histogram('h', 'x', [])).toThrow(/at least one edge/);
    expect(() => registry.histogram('h', 'x', [1, 1])).toThrow(/must increase/);
    expect(() => registry.histogram('h', 'x', [Number.NaN])).toThrow(RangeError);
    const c = registry.counter('c', 'x');
    expect(() => c.inc(-1)).toThrow(/never goes down/);
    expect(() => c.inc(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const g = registry.gauge('g', 'x');
    expect(() => g.set(Number.NaN)).toThrow(RangeError);
    const h = registry.histogram('ok', 'x', [1]);
    expect(() => h.observe(Number.NaN)).toThrow(RangeError);
  });

  it('escapes newlines and backslashes in help and renders an empty registry as empty', () => {
    const registry = new MetricsRegistry();
    expect(registry.render()).toBe('');
    registry.counter('c', 'two\nlines \\ slash');
    expect(registry.render()).toContain('# HELP c two\\nlines \\\\ slash');
  });

  it('formats infinities the way the text format spells them', () => {
    expect(formatMetricValue(1.5)).toBe('1.5');
    expect(formatMetricValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatMetricValue(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(PROMETHEUS_CONTENT_TYPE).toContain('version=0.0.4');
  });
});

describe('replayMetrics', () => {
  it('registers the six replay metrics on the run histogram edges', () => {
    const m = replayMetrics();
    expect(m.registry.names()).toEqual([
      'rp_exchanges_sent_total',
      'rp_exchanges_acked_total',
      'rp_exchanges_errors_total',
      'rp_exchanges_mismatches_total',
      'rp_inflight',
      'rp_candidate_latency_ms',
    ]);
    expect(m.latency.edges).toEqual(HISTOGRAM_EDGES_MS);
    m.sent.inc();
    m.acked.inc();
    m.latency.observe(12);
    m.inflight.set(1);
    const text = m.registry.render();
    expect(text).toContain('# TYPE rp_candidate_latency_ms histogram');
    expect(text).toContain('rp_candidate_latency_ms_bucket{le="+Inf"} 1');
    expect(text).toContain(
      `rp_candidate_latency_ms_bucket{le="${String(HISTOGRAM_EDGES_MS[0])}"} 0`,
    );
    expect(text).toContain('rp_candidate_latency_ms_bucket{le="10000"} 1');
    expect(text).toContain('rp_inflight 1');
  });

  it('reuses a given registry', () => {
    const registry = new MetricsRegistry();
    registry.counter('other', 'x');
    const m = replayMetrics(registry);
    expect(m.registry).toBe(registry);
    expect(registry.names()[0]).toBe('other');
  });
});
