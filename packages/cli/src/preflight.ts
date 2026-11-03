import { performance } from 'node:perf_hooks';
import {
  get,
  parsePath,
  select,
  type DiffRules,
  type Exchange,
  type JsonValue,
  type Thresholds,
} from '@replay-parity/core';
import { hasUpstreamOptions, upstreamFetch } from '@replay-parity/replay';
import type { Upstream } from './upstream.js';

/**
 * The preflight: checks that run before anything is sent, shared by
 * `rp validate`, `rp replay`, and `rp shrink`. Each check is one line with a
 * level. `error` stops a replay; `warn` is reported and does not.
 */

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface Check {
  level: CheckLevel;
  /** The subject, such as `recording`, `thresholds`, `rules`, `barrier`, `target`, `reset`. */
  name: string;
  detail: string;
}

/** A URL to probe and the text to print for it, which is the unresolved form when it held a secret. */
export interface Probe {
  url: string;
  label: string;
  /** TLS and proxy settings the probe connects with, the same ones the replay uses. */
  upstream?: Upstream | undefined;
}

/** One request for a probe. Plain `fetch` unless TLS or proxy settings apply. */
async function probeRequest(
  probe: Probe,
  url: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
): Promise<{ status: number; ok: boolean }> {
  const signal = AbortSignal.timeout(timeoutMs);
  if (probe.upstream !== undefined && hasUpstreamOptions(probe.upstream)) {
    return upstreamFetch(url, { method, signal }, probe.upstream);
  }
  const res = await fetch(url, { method, signal, redirect: 'manual' });
  await res.body?.cancel();
  return { status: res.status, ok: res.ok };
}

export const PROBE_TIMEOUT_MS = 5000;

export interface PreflightInputs {
  recording: string;
  exchanges: readonly Exchange[];
  rules?: DiffRules | undefined;
  thresholds?: Thresholds | undefined;
  barrierTags?: readonly string[] | undefined;
  target?: Probe | undefined;
  reference?: Probe | undefined;
  reset?: Probe | undefined;
  probeTimeoutMs?: number | undefined;
}

const ok = (name: string, detail: string): Check => ({ level: 'ok', name, detail });
const warn = (name: string, detail: string): Check => ({ level: 'warn', name, detail });
const error = (name: string, detail: string): Check => ({ level: 'error', name, detail });

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** How many exchanges carry each tag. */
export function tagCounts(exchanges: readonly Exchange[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of exchanges) {
    for (const tag of e.tags) out.set(tag, (out.get(tag) ?? 0) + 1);
  }
  return out;
}

export function checkRecording(recording: string, exchanges: readonly Exchange[]): Check {
  const tags = tagCounts(exchanges);
  const detail = `${recording}: ${plural(exchanges.length, 'exchange')}, ${plural(tags.size, 'tag')}`;
  return exchanges.length === 0 ? warn('recording', detail) : ok('recording', detail);
}

/** Every tag named in `latency.by_tag` and `correctness.by_tag` must exist in the recording. */
export function checkThresholds(
  thresholds: Thresholds,
  tags: ReadonlyMap<string, number>,
): Check[] {
  const out: Check[] = [];
  const sections: [string, Record<string, unknown>][] = [
    ['latency.by_tag', thresholds.latency.by_tag],
    ['correctness.by_tag', thresholds.correctness.by_tag],
  ];
  for (const [section, byTag] of sections) {
    for (const tag of Object.keys(byTag)) {
      const count = tags.get(tag);
      out.push(
        count === undefined
          ? error('thresholds', `${section}.${tag} names a tag the recording does not have`)
          : ok('thresholds', `${section}.${tag} names ${plural(count, 'exchange')}`),
      );
    }
  }
  return out;
}

function isLeaf(value: JsonValue | undefined): boolean {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * Every substitution must have a producer exchange with a value at its capture
 * path, every control tag should name an exchange, and every ignore,
 * tolerance, and unordered path should match something in a response body.
 */
export function checkRules(rules: DiffRules, exchanges: readonly Exchange[]): Check[] {
  const out: Check[] = [];
  const tags = tagCounts(exchanges);
  for (const rule of rules.substitutions) {
    const { tag, path } = rule.capture;
    const producers = exchanges.filter((e) => e.tags.includes(tag));
    if (producers.length === 0) {
      out.push(
        error(
          'rules',
          `substitution ${rule.name} captures from tag ${tag}, which no exchange carries`,
        ),
      );
      continue;
    }
    const segments = parsePath(path);
    const producing = producers.filter((e) => isLeaf(get(e.response.body, segments))).length;
    out.push(
      producing === 0
        ? error(
            'rules',
            `substitution ${rule.name} captures ${path} from tag ${tag}, but none of its ${plural(producers.length, 'exchange')} has a value there`,
          )
        : ok(
            'rules',
            `substitution ${rule.name} captures ${path} from ${producing} of ${plural(producers.length, `${tag} exchange`)}`,
          ),
    );
  }
  for (const tag of rules.controls.tags) {
    const count = tags.get(tag);
    out.push(
      count === undefined
        ? warn('rules', `control tag ${tag} names no exchange`)
        : ok('rules', `control tag ${tag} names ${plural(count, 'exchange')}`),
    );
  }
  const paths: [string, string][] = [
    ...rules.ignore.map((p): [string, string] => ['ignore', p]),
    ...rules.tolerances.map((r): [string, string] => ['tolerance', r.path]),
    ...rules.unordered.map((r): [string, string] => ['unordered', r.path]),
  ];
  for (const [label, path] of paths) {
    const segments = parsePath(path);
    const matching = exchanges.filter((e) => select(e.response.body, segments).length > 0).length;
    out.push(
      matching === 0
        ? warn('rules', `${label} ${path} matches no response body`)
        : ok(
            'rules',
            `${label} ${path} matches ${plural(matching, 'response body').replace('bodys', 'bodies')}`,
          ),
    );
  }
  return out;
}

export function checkBarrierTags(
  barrierTags: readonly string[],
  tags: ReadonlyMap<string, number>,
): Check[] {
  return barrierTags.map((tag) => {
    const count = tags.get(tag);
    return count === undefined
      ? error('barrier', `tag ${tag} is not in the recording`)
      : ok('barrier', `tag ${tag} names ${plural(count, 'exchange')}`);
  });
}

function describeFailure(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'timed out';
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return e.message;
  }
  return String(e);
}

/** The URL to GET: the probe's path, or `/healthz` when the path is empty. */
export function healthUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/healthz';
  return parsed.href;
}

/** GET on the URL's path, or `/healthz` when it has none. Any status under 500 within the timeout is reachable. */
export async function probeHealth(
  name: string,
  probe: Probe,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Check> {
  let url: string;
  try {
    url = healthUrl(probe.url);
  } catch {
    return error(name, `${probe.label} is not a valid URL`);
  }
  const shown = url === probe.url ? probe.label : `${probe.label.replace(/\/$/, '')}/healthz`;
  const started = performance.now();
  try {
    const res = await probeRequest(probe, url, 'GET', timeoutMs);
    const ms = Math.round(performance.now() - started);
    return res.status < 500
      ? ok(name, `GET ${shown} answered ${res.status} in ${ms} ms`)
      : error(name, `GET ${shown} answered ${res.status}`);
  } catch (e) {
    return error(name, `GET ${shown} failed: ${describeFailure(e)} (${timeoutMs} ms limit)`);
  }
}

/** POST to the reset URL. A 2xx within the timeout passes. */
export async function probeReset(probe: Probe, timeoutMs = PROBE_TIMEOUT_MS): Promise<Check> {
  try {
    new URL(probe.url);
  } catch {
    return error('reset', `${probe.label} is not a valid URL`);
  }
  const started = performance.now();
  try {
    const res = await probeRequest(probe, probe.url, 'POST', timeoutMs);
    const ms = Math.round(performance.now() - started);
    return res.ok
      ? ok('reset', `POST ${probe.label} answered ${res.status} in ${ms} ms`)
      : error('reset', `POST ${probe.label} answered ${res.status}, expected 2xx`);
  } catch (e) {
    return error(
      'reset',
      `POST ${probe.label} failed: ${describeFailure(e)} (${timeoutMs} ms limit)`,
    );
  }
}

/** Runs every check the inputs allow, file checks first and probes last. */
export async function preflight(inputs: PreflightInputs): Promise<Check[]> {
  const checks: Check[] = [checkRecording(inputs.recording, inputs.exchanges)];
  const tags = tagCounts(inputs.exchanges);
  if (inputs.thresholds !== undefined) checks.push(...checkThresholds(inputs.thresholds, tags));
  if (inputs.rules !== undefined) checks.push(...checkRules(inputs.rules, inputs.exchanges));
  if (inputs.barrierTags !== undefined) checks.push(...checkBarrierTags(inputs.barrierTags, tags));
  const timeout = inputs.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  if (inputs.target !== undefined) checks.push(await probeHealth('target', inputs.target, timeout));
  if (inputs.reference !== undefined) {
    checks.push(await probeHealth('reference', inputs.reference, timeout));
  }
  if (inputs.reset !== undefined) checks.push(await probeReset(inputs.reset, timeout));
  return checks;
}

export function formatCheck(check: Check): string {
  return `${check.level.padEnd(5)} ${check.name}: ${check.detail}`;
}

export function hasError(checks: readonly Check[]): boolean {
  return checks.some((c) => c.level === 'error');
}
