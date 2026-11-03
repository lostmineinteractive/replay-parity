import { HISTOGRAM_EDGES_MS } from '../stats/histogram.js';

/**
 * A metrics registry rendered in the Prometheus text format, with no
 * dependency. Counters only go up, gauges go both ways, and a histogram
 * counts observations at or under each of its edges the way Prometheus
 * buckets do, cumulatively, with `+Inf` holding every observation.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export interface Counter {
  inc(n?: number): void;
  readonly value: number;
}

export interface Gauge {
  set(value: number): void;
  inc(n?: number): void;
  dec(n?: number): void;
  readonly value: number;
}

export interface Histogram {
  observe(value: number): void;
  readonly count: number;
  readonly sum: number;
  readonly edges: readonly number[];
  /** Observations at or under each edge, cumulative, in edge order. */
  buckets(): number[];
}

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface Entry {
  kind: MetricKind;
  help: string;
  metric: CounterImpl | GaugeImpl | HistogramImpl;
}

function finite(value: number, what: string): void {
  if (!Number.isFinite(value))
    throw new RangeError(`${what} must be a finite number, got ${String(value)}`);
}

class CounterImpl implements Counter {
  value = 0;

  inc(n = 1): void {
    finite(n, 'a counter increment');
    if (n < 0) throw new RangeError(`a counter never goes down, got ${String(n)}`);
    this.value += n;
  }
}

class GaugeImpl implements Gauge {
  value = 0;

  set(value: number): void {
    finite(value, 'a gauge value');
    this.value = value;
  }

  inc(n = 1): void {
    finite(n, 'a gauge increment');
    this.value += n;
  }

  dec(n = 1): void {
    finite(n, 'a gauge decrement');
    this.value -= n;
  }
}

class HistogramImpl implements Histogram {
  count = 0;
  sum = 0;
  readonly edges: readonly number[];
  private readonly counts: number[];

  constructor(edges: readonly number[]) {
    if (edges.length === 0) throw new RangeError('a histogram needs at least one edge');
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i] as number;
      finite(edge, 'a histogram edge');
      if (i > 0 && !(edge > (edges[i - 1] as number))) {
        throw new RangeError('histogram edges must increase');
      }
    }
    this.edges = [...edges];
    this.counts = new Array<number>(edges.length).fill(0);
  }

  observe(value: number): void {
    finite(value, 'an observation');
    this.count += 1;
    this.sum += value;
    for (let i = 0; i < this.edges.length; i += 1) {
      if (value <= (this.edges[i] as number)) this.counts[i] = (this.counts[i] as number) + 1;
    }
  }

  buckets(): number[] {
    return [...this.counts];
  }
}

/** A number as the text format writes it. */
export function formatMetricValue(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export class MetricsRegistry {
  private readonly entries = new Map<string, Entry>();

  private register<T extends Entry['metric']>(
    name: string,
    kind: MetricKind,
    help: string,
    create: () => T,
  ): T {
    if (!NAME.test(name)) throw new RangeError(`invalid metric name ${JSON.stringify(name)}`);
    const existing = this.entries.get(name);
    if (existing !== undefined) {
      if (existing.kind !== kind) {
        throw new RangeError(`metric ${name} is already registered as a ${existing.kind}`);
      }
      return existing.metric as T;
    }
    const metric = create();
    this.entries.set(name, { kind, help, metric });
    return metric;
  }

  /** The counter named `name`, created on the first call and returned again after. */
  counter(name: string, help: string): Counter {
    return this.register(name, 'counter', help, () => new CounterImpl());
  }

  gauge(name: string, help: string): Gauge {
    return this.register(name, 'gauge', help, () => new GaugeImpl());
  }

  histogram(name: string, help: string, edges: readonly number[]): Histogram {
    return this.register(name, 'histogram', help, () => new HistogramImpl(edges));
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** The whole registry in the Prometheus text format, in registration order. */
  render(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.entries) {
      lines.push(`# HELP ${name} ${escapeHelp(entry.help)}`);
      lines.push(`# TYPE ${name} ${entry.kind}`);
      const metric = entry.metric;
      if (metric instanceof HistogramImpl) {
        const counts = metric.buckets();
        metric.edges.forEach((edge, i) => {
          lines.push(
            `${name}_bucket{le="${formatMetricValue(edge)}"} ${formatMetricValue(counts[i] as number)}`,
          );
        });
        lines.push(`${name}_bucket{le="+Inf"} ${formatMetricValue(metric.count)}`);
        lines.push(`${name}_sum ${formatMetricValue(metric.sum)}`);
        lines.push(`${name}_count ${formatMetricValue(metric.count)}`);
      } else {
        lines.push(`${name} ${formatMetricValue(metric.value)}`);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}

/** The metrics `rp replay` serves, on one registry. */
export interface ReplayMetrics {
  registry: MetricsRegistry;
  sent: Counter;
  acked: Counter;
  errors: Counter;
  mismatches: Counter;
  inflight: Gauge;
  /** Candidate latency in milliseconds, with the run's log spaced bin edges. */
  latency: Histogram;
}

export function replayMetrics(registry: MetricsRegistry = new MetricsRegistry()): ReplayMetrics {
  return {
    registry,
    sent: registry.counter('rp_exchanges_sent_total', 'Exchanges sent to the candidate.'),
    acked: registry.counter('rp_exchanges_acked_total', 'Exchanges the candidate answered.'),
    errors: registry.counter(
      'rp_exchanges_errors_total',
      'Exchanges that failed to send, timed out, or were aborted.',
    ),
    mismatches: registry.counter(
      'rp_exchanges_mismatches_total',
      'Exchanges whose response differed from the recording under the rules.',
    ),
    inflight: registry.gauge('rp_inflight', 'Exchanges sent and not yet acknowledged.'),
    latency: registry.histogram(
      'rp_candidate_latency_ms',
      'Candidate latency in milliseconds, in the log spaced bins of the run.',
      HISTOGRAM_EDGES_MS,
    ),
  };
}
