import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildPlan, type LoadKind, type LoadRequest } from './scenario.js';

export interface LoadOptions {
  /** Base URL to send to, normally the capture proxy. */
  target: string;
  seed?: number | undefined;
  backgroundPerBlock?: number | undefined;
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
  /** Distinct order ids returned by create steps, in first seen order. */
  orderIds: string[];
  /** Order id per create step index, or null when the create did not return one. */
  createdIds: (string | null)[];
  durationMs: number;
  latenciesMs: number[];
}

export function resolvePath(step: LoadRequest, createdIds: readonly (string | null)[]): string {
  if (step.orderRef === undefined) return step.path;
  return step.path.replace('{order}', createdIds[step.orderRef] ?? 'o-missing');
}

/**
 * Sends the plan sequentially with a random gap between requests. The
 * sequential order keeps state changes in a reproducible order, which the
 * replay then repeats under `as-recorded` pacing.
 */
export async function runLoad(options: LoadOptions): Promise<LoadSummary> {
  const seed = options.seed ?? 42;
  const plan = buildPlan(seed, { backgroundPerBlock: options.backgroundPerBlock });
  const pace = (() => {
    let a = (seed ^ 0x9e3779b9) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const fetchImpl = options.fetchImpl ?? fetch;
  const minGap = options.minGapMs ?? 20;
  const maxGap = options.maxGapMs ?? 60;
  const baseHeaders = { authorization: 'Bearer demo-token', ...options.headers };
  const summary: LoadSummary = {
    sent: 0,
    byKind: {
      'create-order': 0,
      'get-order': 0,
      'cancel-order': 0,
      'set-quantity': 0,
      'ship-order': 0,
      'list-inventory': 0,
      'adjust-stock': 0,
      'list-ledger': 0,
      'admin-restart': 0,
    },
    byStatus: {},
    orderIds: [],
    createdIds: [],
    durationMs: 0,
    latenciesMs: [],
  };
  const startedAt = performance.now();
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i] as LoadRequest;
    if (i > 0) await sleep(minGap + pace() * (maxGap - minGap));
    const headers: Record<string, string> = { ...baseHeaders, ...step.headers };
    let body: string | undefined;
    if (step.body) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(step.body);
    }
    const path = resolvePath(step, summary.createdIds);
    const t0 = performance.now();
    const res = await fetchImpl(`${options.target}${path}`, {
      method: step.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    summary.latenciesMs.push(performance.now() - t0);
    summary.sent += 1;
    summary.byKind[step.kind] += 1;
    summary.byStatus[String(res.status)] = (summary.byStatus[String(res.status)] ?? 0) + 1;
    if (step.createIndex !== undefined) {
      let id: string | null = null;
      if (res.status === 201) {
        const parsed = JSON.parse(text) as { order_id?: unknown };
        if (typeof parsed.order_id === 'string') id = parsed.order_id;
      }
      summary.createdIds[step.createIndex] = id;
      if (id !== null && !summary.orderIds.includes(id)) summary.orderIds.push(id);
    }
    options.log?.(`${step.method} ${path} -> ${res.status} (${step.block})`);
  }
  summary.durationMs = performance.now() - startedAt;
  return summary;
}
