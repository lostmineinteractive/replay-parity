import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createScenario, type LoadKind } from './scenario.js';

export interface LoadOptions {
  /** Base URL to send to, normally the capture proxy. */
  target: string;
  count: number;
  seed?: number | undefined;
  minGapMs?: number | undefined;
  maxGapMs?: number | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface LoadSummary {
  sent: number;
  byKind: Record<LoadKind, number>;
  byStatus: Record<string, number>;
  orderIds: string[];
  durationMs: number;
  latenciesMs: number[];
}

/**
 * Sends the scenario sequentially with a random gap between requests. The
 * sequential order keeps state changes in a reproducible order, which the
 * replay then repeats under `as-recorded` pacing.
 */
export async function runLoad(options: LoadOptions): Promise<LoadSummary> {
  const scenario = createScenario(options.seed ?? 42);
  const fetchImpl = options.fetchImpl ?? fetch;
  const minGap = options.minGapMs ?? 20;
  const maxGap = options.maxGapMs ?? 60;
  const baseHeaders = { authorization: 'Bearer demo-token', ...options.headers };
  const summary: LoadSummary = {
    sent: 0,
    byKind: { 'create-order': 0, 'get-order': 0, 'list-inventory': 0, 'adjust-stock': 0 },
    byStatus: {},
    orderIds: [],
    durationMs: 0,
    latenciesMs: [],
  };
  const startedAt = performance.now();
  for (let i = 0; i < options.count; i += 1) {
    if (i > 0) await sleep(minGap + scenario.random() * (maxGap - minGap));
    const req = scenario.next(summary.orderIds);
    const headers: Record<string, string> = { ...baseHeaders };
    let body: string | undefined;
    if (req.body) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const t0 = performance.now();
    const res = await fetchImpl(`${options.target}${req.path}`, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    summary.latenciesMs.push(performance.now() - t0);
    summary.sent += 1;
    summary.byKind[req.kind] += 1;
    summary.byStatus[String(res.status)] = (summary.byStatus[String(res.status)] ?? 0) + 1;
    if (req.kind === 'create-order' && res.status === 201) {
      const parsed = JSON.parse(text) as { order_id?: unknown };
      if (typeof parsed.order_id === 'string') summary.orderIds.push(parsed.order_id);
    }
    options.log?.(`${req.method} ${req.path} -> ${res.status}`);
  }
  summary.durationMs = performance.now() - startedAt;
  return summary;
}
