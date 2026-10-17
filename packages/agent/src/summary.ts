import {
  DEFAULT_REDACTED_HEADERS,
  REDACTED,
  isJsonObject,
  type Exchange,
  type JsonValue,
  type KeptCase,
  type Run,
} from '@replay-parity/core';

/**
 * What the model sees. Built only from the run, the recording, and the kept
 * cases. Header values are never shown except for a short allowlist, and a
 * redacted value stays the redaction marker.
 */
export const SHOWN_HEADERS: readonly string[] = ['content-type', 'idempotency-key'];
const SAMPLE_MISMATCHES = 8;
const TOP_PATHS = 12;
const VALUE_CHARS = 60;

function short(value: JsonValue | undefined): string {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value);
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS - 3)}...` : text;
}

export function summarizeRun(run: Run): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${run.verdict}.`);
  const failed = run.threshold_results.filter((r) => r.outcome !== 'pass');
  lines.push(
    failed.length === 0
      ? 'Every threshold row passed.'
      : `Threshold rows that did not pass: ${failed
          .map((r) => `${r.id} (${r.outcome}, limit ${r.limit}, measured ${r.measured ?? 'n/a'})`)
          .join('; ')}.`,
  );
  const byTag = Object.entries(run.stats.by_tag)
    .filter(([, s]) => s.mismatches > 0 || s.errors > 0)
    .map(([tag, s]) => `${tag}: ${s.mismatches} of ${s.compared} mismatch, ${s.errors} errors`);
  lines.push(
    byTag.length === 0 ? 'No tag had mismatches.' : `Mismatches by tag: ${byTag.join('; ')}.`,
  );

  const paths = new Map<string, number>();
  const mismatched = run.exchanges.filter((e) => !e.control && e.diff?.verdict === 'mismatch');
  for (const e of mismatched) {
    for (const f of e.diff?.findings ?? []) {
      if (f.tolerated) continue;
      const generalized = f.path.replace(/\[\d+\]/g, '[*]');
      paths.set(generalized, (paths.get(generalized) ?? 0) + 1);
    }
  }
  const top = [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_PATHS);
  if (top.length > 0) {
    lines.push(`Mismatching paths: ${top.map(([p, n]) => `${p} (${n})`).join(', ')}.`);
  }
  if (mismatched.length > 0) {
    lines.push('Sample of mismatched exchanges:');
    for (const e of mismatched.slice(0, SAMPLE_MISMATCHES)) {
      const findings = (e.diff?.findings ?? []).filter((f) => !f.tolerated).slice(0, 3);
      lines.push(
        `- ${e.method} ${e.path} [${e.tags.join(', ')}] status ${e.reference.status} vs ${e.candidate?.status ?? 'error'}: ${findings
          .map((f) => `${f.path} ${short(f.reference)} vs ${short(f.candidate)}`)
          .join('; ')}`,
      );
    }
  }
  const latency = run.threshold_results.filter(
    (r) => r.section === 'latency' && r.outcome === 'fail',
  );
  if (latency.length > 0) {
    lines.push(
      `Latency rows that failed: ${latency.map((r) => `${r.id} measured ${r.measured ?? 'n/a'} ms against ${r.limit} ms`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}

interface Shape {
  tag: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyExample: JsonValue | undefined;
  count: number;
  statuses: Map<number, number>;
  responseKeys: Set<string>;
}

function shownHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (SHOWN_HEADERS.includes(key)) out[key] = value;
    else if (DEFAULT_REDACTED_HEADERS.includes(key)) out[key] = REDACTED;
  }
  return out;
}

/** One request shape per tag: the first request seen, the statuses, and the response keys. */
export function describeShapes(exchanges: readonly Exchange[]): string {
  const shapes = new Map<string, Shape>();
  for (const e of exchanges) {
    const tag = e.tags[0] ?? '(untagged)';
    let shape = shapes.get(tag);
    if (!shape) {
      shape = {
        tag,
        method: e.request.method,
        path: e.request.path,
        headers: shownHeaders(e.request.headers),
        bodyExample: e.request.body,
        count: 0,
        statuses: new Map(),
        responseKeys: new Set(),
      };
      shapes.set(tag, shape);
    }
    shape.count += 1;
    shape.statuses.set(e.response.status, (shape.statuses.get(e.response.status) ?? 0) + 1);
    if (isJsonObject(e.response.body))
      for (const k of Object.keys(e.response.body)) shape.responseKeys.add(k);
  }
  const lines: string[] = [];
  for (const shape of [...shapes.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1))) {
    const statuses = [...shape.statuses.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s} x${n}`)
      .join(', ');
    lines.push(
      `- ${shape.tag}: ${shape.method} ${shape.path} (${shape.count} recorded; statuses ${statuses})`,
    );
    if (Object.keys(shape.headers).length > 0)
      lines.push(`  headers: ${JSON.stringify(shape.headers)}`);
    if (shape.bodyExample !== undefined) lines.push(`  body example: ${short(shape.bodyExample)}`);
    if (shape.responseKeys.size > 0)
      lines.push(`  response keys: ${[...shape.responseKeys].sort().join(', ')}`);
  }
  return lines.join('\n');
}

export function describeKept(cases: readonly KeptCase[]): string {
  if (cases.length === 0) return 'None yet.';
  return cases
    .map((c) => `- ${c.id} [${c.tags.join(', ')}] ${c.hypothesis} (key ${c.dedupe_key})`)
    .join('\n');
}

export function tagsOf(exchanges: readonly Exchange[]): string[] {
  const tags = new Set<string>();
  for (const e of exchanges) for (const t of e.tags) tags.add(t);
  return [...tags].sort();
}
