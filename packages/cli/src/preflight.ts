import { performance } from 'node:perf_hooks';
import {
  captureSource,
  captureValue,
  exchangeContext,
  headerEntries,
  ignoreEntries,
  iterateRecording,
  parsePath,
  select,
  whenMatches,
  type DiffRules,
  type Exchange,
  type Thresholds,
  type When,
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
  /** The exchanges, when the caller already holds them. Without them the recording is streamed from its path. */
  exchanges?: readonly Exchange[] | undefined;
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

/** One path rule or compared header of the rules, with the scope it applies in. */
export interface PathProbe {
  label: string;
  path: string;
  when: When | undefined;
  matching: number;
}

export interface HeaderProbe {
  name: string;
  when: When | undefined;
  present: number;
}

export interface SubstitutionProbe {
  rule: DiffRules['substitutions'][number];
  /** Exchanges that carry the capture tag. */
  producers: number;
  /** Producers that have a value at the capture. */
  producing: number;
}

/**
 * What the checks need to know about a recording, gathered one exchange at a
 * time. It holds counts and nothing of the exchanges themselves, so its size
 * depends on the rules and the tags and not on the length of the recording.
 */
export class RecordingScan {
  count = 0;
  readonly tags = new Map<string, number>();
  readonly substitutions: SubstitutionProbe[];
  readonly paths: PathProbe[];
  readonly headers: HeaderProbe[];

  constructor(private readonly rules?: DiffRules) {
    this.substitutions = (rules?.substitutions ?? []).map((rule) => ({
      rule,
      producers: 0,
      producing: 0,
    }));
    const pathEntries: [string, string, When | undefined][] =
      rules === undefined
        ? []
        : [
            ...ignoreEntries(rules).map((r): [string, string, When | undefined] => [
              'ignore',
              r.path,
              r.when,
            ]),
            ...rules.tolerances.map((r): [string, string, When | undefined] => [
              'tolerance',
              r.path,
              r.when,
            ]),
            ...rules.unordered.map((r): [string, string, When | undefined] => [
              'unordered',
              r.path,
              r.when,
            ]),
            ...rules.decimal.map((r): [string, string, When | undefined] => [
              'decimal',
              r.path,
              r.when,
            ]),
            ...rules.time.map((r): [string, string, When | undefined] => ['time', r.path, r.when]),
            ...rules.mask.map((r): [string, string, When | undefined] => ['mask', r.path, r.when]),
          ];
    this.paths = pathEntries.map(([label, path, when]) => ({ label, path, when, matching: 0 }));
    this.headers =
      rules === undefined
        ? []
        : headerEntries(rules.headers.compare).map((h) => ({
            name: h.name,
            when: h.when,
            present: 0,
          }));
  }

  add(e: Exchange): void {
    this.count += 1;
    for (const tag of e.tags) this.tags.set(tag, (this.tags.get(tag) ?? 0) + 1);
    if (this.rules === undefined) return;
    for (const s of this.substitutions) {
      if (!e.tags.includes(s.rule.capture.tag)) continue;
      s.producers += 1;
      if (captureValue(s.rule.capture, e.response, e.request) !== undefined) s.producing += 1;
    }
    let context: ReturnType<typeof exchangeContext> | undefined;
    const inScope = (when: When | undefined): boolean => {
      if (when === undefined) return true;
      context ??= exchangeContext(e);
      return whenMatches(when, context);
    };
    for (const p of this.paths) {
      if (inScope(p.when) && select(e.response.body, parsePath(p.path)).length > 0) p.matching += 1;
    }
    for (const h of this.headers) {
      if (inScope(h.when) && e.response.headers[h.name] !== undefined) h.present += 1;
    }
  }
}

/** Scans exchanges already in memory. */
export function scanExchanges(exchanges: readonly Exchange[], rules?: DiffRules): RecordingScan {
  const scan = new RecordingScan(rules);
  for (const e of exchanges) scan.add(e);
  return scan;
}

/** Streams the recording at `path` through a scan, one exchange in memory at a time. */
export async function scanRecording(path: string, rules?: DiffRules): Promise<RecordingScan> {
  const scan = new RecordingScan(rules);
  for await (const e of iterateRecording(path)) scan.add(e);
  return scan;
}

/** A scan, or exchanges to scan. Checks that need rule facts scan the exchanges with the rules. */
export type ScanInput = RecordingScan | readonly Exchange[];

function scanFor(input: ScanInput, rules?: DiffRules): RecordingScan {
  return input instanceof RecordingScan ? input : scanExchanges(input, rules);
}

export function checkRecording(recording: string, input: ScanInput): Check {
  const scan = scanFor(input);
  const detail = `${recording}: ${plural(scan.count, 'exchange')}, ${plural(scan.tags.size, 'tag')}`;
  return scan.count === 0 ? warn('recording', detail) : ok('recording', detail);
}

/** Every tag named in any `by_tag` section of the thresholds must exist in the recording. */
export function checkThresholds(
  thresholds: Thresholds,
  tags: ReadonlyMap<string, number>,
): Check[] {
  const out: Check[] = [];
  const sections: [string, Record<string, unknown>][] = [
    ['latency.by_tag', thresholds.latency.by_tag],
    ['correctness.by_tag', thresholds.correctness.by_tag],
    ['errors.by_tag', thresholds.errors.by_tag ?? {}],
    ['latency.relative_to_reference.by_tag', thresholds.latency.relative_to_reference.by_tag ?? {}],
    ['status.by_tag', thresholds.status?.by_tag ?? {}],
    ['baseline.latency.by_tag', thresholds.baseline?.latency?.by_tag ?? {}],
    ['baseline.correctness.by_tag', thresholds.baseline?.correctness?.by_tag ?? {}],
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

/**
 * Every substitution must have a producer exchange with a value at its
 * capture, every control tag should name an exchange, every path rule should
 * match something in a response body within its scope, and every compared
 * header should appear in some response. A scan passed in must have been made
 * with these rules.
 */
export function checkRules(rules: DiffRules, input: ScanInput): Check[] {
  const out: Check[] = [];
  const scan = scanFor(input, rules);
  const tags = scan.tags;
  for (const s of scan.substitutions) {
    const { tag } = s.rule.capture;
    const source = captureSource(s.rule.capture);
    if (s.producers === 0) {
      out.push(
        error(
          'rules',
          `substitution ${s.rule.name} captures from tag ${tag}, which no exchange carries`,
        ),
      );
      continue;
    }
    out.push(
      s.producing === 0
        ? error(
            'rules',
            `substitution ${s.rule.name} captures ${source} from tag ${tag}, but none of its ${plural(s.producers, 'exchange')} has a value there`,
          )
        : ok(
            'rules',
            `substitution ${s.rule.name} captures ${source} from ${s.producing} of ${plural(s.producers, `${tag} exchange`)}`,
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
  for (const p of scan.paths) {
    out.push(
      p.matching === 0
        ? warn('rules', `${p.label} ${p.path} matches no response body`)
        : ok(
            'rules',
            `${p.label} ${p.path} matches ${plural(p.matching, 'response body').replace('bodys', 'bodies')}`,
          ),
    );
  }
  for (const h of scan.headers) {
    out.push(
      h.present === 0
        ? warn('rules', `headers.compare ${h.name} appears in no response`)
        : ok('rules', `headers.compare ${h.name} appears in ${plural(h.present, 'response')}`),
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
  const scan =
    inputs.exchanges === undefined
      ? await scanRecording(inputs.recording, inputs.rules)
      : scanExchanges(inputs.exchanges, inputs.rules);
  const checks: Check[] = [checkRecording(inputs.recording, scan)];
  const tags = scan.tags;
  if (inputs.thresholds !== undefined) checks.push(...checkThresholds(inputs.thresholds, tags));
  if (inputs.rules !== undefined) checks.push(...checkRules(inputs.rules, scan));
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
