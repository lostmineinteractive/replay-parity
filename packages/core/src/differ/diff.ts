import { canonicalJson, isJsonObject, jsonType, stripUndefined, type JsonValue } from '../json.js';
import {
  get,
  keyValueText,
  matches,
  parsePath,
  renderPath,
  rowKeyText,
  type Segment,
} from '../jsonpath/index.js';
import { bodyKind } from '../recording/body.js';
import type { RecordedResponse } from '../recording/types.js';
import type { DiffRules } from '../rules/schema.js';
import type { Diff, Finding, FindingKind, Verdict } from './schema.js';

/**
 * Structural response differ driven by the rules file.
 *
 * Value equivalences come from substitutions: `name -> canonical reference value -> canonical
 * candidate value`. A pair that maps under some name is reported as tolerated by
 * `substitution:<name>`.
 */
export type ValueEquivalences = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface Differ {
  readonly rules: DiffRules;
  diff(
    reference: RecordedResponse,
    candidate: RecordedResponse,
    equivalences?: ValueEquivalences,
  ): Diff;
  diffBodies(
    reference: JsonValue | undefined,
    candidate: JsonValue | undefined,
    equivalences?: ValueEquivalences,
  ): Finding[];
  /** Compares the status only. Used for harness control exchanges. */
  diffStatus(reference: RecordedResponse, candidate: RecordedResponse): Diff;
}

interface CompiledIgnore {
  segs: Segment[];
  name: string;
}

interface CompiledTolerance {
  segs: Segment[];
  abs: number | undefined;
  rel: number | undefined;
  name: string;
}

interface CompiledUnordered {
  segs: Segment[];
  key: Segment[] | undefined;
  keyLabel: string;
  name: string;
}

interface Compiled {
  ignore: CompiledIgnore[];
  tolerances: CompiledTolerance[];
  unordered: CompiledUnordered[];
  statusClasses: number[][];
  headers: string[];
}

function compile(rules: DiffRules): Compiled {
  return {
    ignore: rules.ignore.map((path, i) => ({ segs: parsePath(path), name: `ignore[${i}]` })),
    tolerances: rules.tolerances.map((t, i) => ({
      segs: parsePath(t.path),
      abs: t.abs,
      rel: t.rel,
      name: `tolerances[${i}]`,
    })),
    unordered: rules.unordered.map((u, i) => {
      const key = u.key === undefined ? undefined : parsePath(u.key);
      return {
        segs: parsePath(u.path),
        key,
        keyLabel: key === undefined ? '' : keyLabelOf(key),
        name: `unordered[${i}]`,
      };
    }),
    statusClasses: rules.status.equivalent,
    headers: rules.headers.compare.map((h) => h.toLowerCase()),
  };
}

/**
 * The name shown in a keyed segment: the key's own name when the key path is
 * one key, as `sku` for `$.sku` and `a b` for `$['a b']`, else the key path
 * after `$`. The renderer quotes a name that is not an identifier.
 */
function keyLabelOf(key: Segment[]): string {
  const only = key.length === 1 ? key[0] : undefined;
  if (only?.type === 'key') return only.name;
  return renderPath(key).slice(1).replace(/^\./, '');
}

function findRule<T extends { segs: Segment[] }>(
  rules: T[],
  path: readonly Segment[],
): T | undefined {
  return rules.find((r) => matches(r.segs, path));
}

interface FindingOptions {
  reference?: JsonValue | undefined;
  candidate?: JsonValue | undefined;
  tolerated?: boolean;
  rule?: string | undefined;
  detail?: string | undefined;
}

function finding(path: string, kind: FindingKind, options: FindingOptions = {}): Finding {
  return stripUndefined({
    path,
    kind,
    tolerated: options.tolerated ?? false,
    reference: options.reference,
    candidate: options.candidate,
    rule: options.rule,
    detail: options.detail,
  });
}

function withinTolerance(a: number, b: number, rule: CompiledTolerance): boolean {
  const diff = Math.abs(a - b);
  const allowance = Math.max(rule.abs ?? 0, (rule.rel ?? 0) * Math.max(Math.abs(a), Math.abs(b)));
  return diff <= allowance;
}

function describeTolerance(rule: CompiledTolerance): string {
  const parts: string[] = [];
  if (rule.abs !== undefined) parts.push(`abs ${rule.abs}`);
  if (rule.rel !== undefined) parts.push(`rel ${rule.rel}`);
  return parts.join(' or ');
}

function verdictOf(findings: readonly Finding[]): Verdict {
  if (findings.length === 0) return 'match';
  return findings.every((f) => f.tolerated) ? 'tolerated' : 'mismatch';
}

class BodyWalker {
  private readonly out: Finding[] = [];

  constructor(
    private readonly compiled: Compiled,
    private readonly equivalences: ValueEquivalences | undefined,
  ) {}

  run(reference: JsonValue | undefined, candidate: JsonValue | undefined): Finding[] {
    this.compare(reference, candidate, []);
    return this.out;
  }

  private compare(ref: JsonValue | undefined, cand: JsonValue | undefined, path: Segment[]): void {
    if (findRule(this.compiled.ignore, path)) return;
    const rendered = renderPath(path);
    if (ref === undefined && cand === undefined) return;
    if (ref === undefined) {
      this.out.push(finding(rendered, 'unexpected', { candidate: cand }));
      return;
    }
    if (cand === undefined) {
      this.out.push(finding(rendered, 'missing', { reference: ref }));
      return;
    }
    const tr = jsonType(ref);
    const tc = jsonType(cand);
    if (tr === 'array' && tc === 'array') {
      const unordered = findRule(this.compiled.unordered, path);
      if (unordered) {
        this.compareUnordered(ref as JsonValue[], cand as JsonValue[], path, unordered);
      } else {
        this.compareArrays(ref as JsonValue[], cand as JsonValue[], path);
      }
      return;
    }
    if (tr === 'object' && tc === 'object') {
      this.compareObjects(
        ref as Record<string, JsonValue>,
        cand as Record<string, JsonValue>,
        path,
      );
      return;
    }
    if (tr !== tc) {
      this.out.push(
        finding(rendered, 'type', {
          reference: ref,
          candidate: cand,
          detail: `reference is ${tr}, candidate is ${tc}`,
        }),
      );
      return;
    }
    if (tr === 'number') {
      this.compareNumbers(ref as number, cand as number, path);
      return;
    }
    if (ref === cand) return;
    const eq = this.equivalence(ref, cand);
    if (eq !== undefined) {
      this.out.push(
        finding(rendered, 'value', {
          reference: ref,
          candidate: cand,
          tolerated: true,
          rule: `substitution:${eq}`,
        }),
      );
      return;
    }
    this.out.push(finding(rendered, 'value', { reference: ref, candidate: cand }));
  }

  private compareNumbers(ref: number, cand: number, path: Segment[]): void {
    if (ref === cand) return;
    const rendered = renderPath(path);
    const tol = findRule(this.compiled.tolerances, path);
    if (tol && withinTolerance(ref, cand, tol)) {
      this.out.push(
        finding(rendered, 'value', {
          reference: ref,
          candidate: cand,
          tolerated: true,
          rule: tol.name,
          detail: `within ${describeTolerance(tol)}`,
        }),
      );
      return;
    }
    this.out.push(
      finding(rendered, 'value', {
        reference: ref,
        candidate: cand,
        detail: tol
          ? `outside ${describeTolerance(tol)} of ${tol.name}`
          : 'no tolerance rule covers this path',
      }),
    );
  }

  private compareObjects(
    ref: Record<string, JsonValue>,
    cand: Record<string, JsonValue>,
    path: Segment[],
  ): void {
    const keys = [...new Set([...Object.keys(ref), ...Object.keys(cand)])].sort();
    for (const name of keys) {
      this.compare(
        Object.hasOwn(ref, name) ? ref[name] : undefined,
        Object.hasOwn(cand, name) ? cand[name] : undefined,
        [...path, { type: 'key', name }],
      );
    }
  }

  private compareArrays(ref: JsonValue[], cand: JsonValue[], path: Segment[]): void {
    const length = Math.max(ref.length, cand.length);
    for (let index = 0; index < length; index += 1) {
      this.compare(ref[index], cand[index], [...path, { type: 'index', index }]);
    }
  }

  private compareUnordered(
    ref: JsonValue[],
    cand: JsonValue[],
    path: Segment[],
    rule: CompiledUnordered,
  ): void {
    if (rule.key === undefined) {
      this.compareMultiset(ref, cand, path);
      return;
    }
    const refGroups = groupByKey(ref, rule.key);
    const candGroups = groupByKey(cand, rule.key);
    const keys = [...new Set([...refGroups.keys(), ...candGroups.keys()])].sort();
    for (const keyText of keys) {
      const refItems = refGroups.get(keyText) ?? [];
      const candItems = candGroups.get(keyText) ?? [];
      const length = Math.max(refItems.length, candItems.length);
      for (let dup = 0; dup < length; dup += 1) {
        this.compare(refItems[dup], candItems[dup], [
          ...path,
          { type: 'keyed', name: rule.keyLabel, value: keyText, dup },
        ]);
      }
    }
  }

  private compareMultiset(ref: JsonValue[], cand: JsonValue[], path: Segment[]): void {
    const refIdx = indexByCanonical(ref);
    const candIdx = indexByCanonical(cand);
    const keys = [...new Set([...refIdx.keys(), ...candIdx.keys()])].sort();
    for (const key of keys) {
      const r = refIdx.get(key) ?? [];
      const c = candIdx.get(key) ?? [];
      for (let k = c.length; k < r.length; k += 1) {
        const index = r[k] as number;
        this.compare(ref[index], undefined, [...path, { type: 'index', index }]);
      }
      for (let k = r.length; k < c.length; k += 1) {
        const index = c[k] as number;
        this.compare(undefined, cand[index], [...path, { type: 'index', index }]);
      }
    }
  }

  private equivalence(ref: JsonValue, cand: JsonValue): string | undefined {
    if (!this.equivalences) return undefined;
    const refKey = canonicalJson(ref);
    const candKey = canonicalJson(cand);
    for (const [name, map] of this.equivalences) {
      if (map.get(refKey) === candKey) return name;
    }
    return undefined;
  }
}

/**
 * Groups rows by their key text, which is the value in the keyed segment of
 * every finding on the row. A row without the key is grouped by its own
 * canonical JSON behind `#`, as in `#'{"qty":3}'`. Rows that share a text are
 * compared in order and told apart by the `#n` suffix.
 */
function groupByKey(items: JsonValue[], key: Segment[]): Map<string, JsonValue[]> {
  const groups = new Map<string, JsonValue[]>();
  for (const item of items) {
    const value = get(item, key);
    const keyText = value === undefined ? rowKeyText(item) : keyValueText(value);
    const group = groups.get(keyText);
    if (group) {
      group.push(item);
    } else {
      groups.set(keyText, [item]);
    }
  }
  return groups;
}

function indexByCanonical(items: JsonValue[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = canonicalJson(item);
    const list = out.get(key);
    if (list) {
      list.push(index);
    } else {
      out.set(key, [index]);
    }
  });
  return out;
}

function compareStatus(
  compiled: Compiled,
  reference: RecordedResponse,
  candidate: RecordedResponse,
): Finding | null {
  if (reference.status === candidate.status) return null;
  const classIndex = compiled.statusClasses.findIndex(
    (c) => c.includes(reference.status) && c.includes(candidate.status),
  );
  return finding('status', 'status', {
    reference: reference.status,
    candidate: candidate.status,
    tolerated: classIndex >= 0,
    rule: classIndex >= 0 ? `status.equivalent[${classIndex}]` : undefined,
  });
}

function compareHeaders(
  compiled: Compiled,
  reference: RecordedResponse,
  candidate: RecordedResponse,
): Finding[] {
  const out: Finding[] = [];
  for (const name of compiled.headers) {
    const r = reference.headers[name];
    const c = candidate.headers[name];
    if (r === c) continue;
    out.push(
      finding(`header:${name}`, 'header', {
        reference: r,
        candidate: c,
      }),
    );
  }
  return out;
}

function compareBodies(
  compiled: Compiled,
  equivalences: ValueEquivalences | undefined,
  reference: RecordedResponse,
  candidate: RecordedResponse,
): Finding[] {
  const rk = bodyKind(reference);
  const ck = bodyKind(candidate);
  if (rk === 'truncated' || ck === 'truncated') {
    const sides: string[] = [];
    if (rk === 'truncated') sides.push(`reference body (${reference.body_size ?? 0} bytes)`);
    if (ck === 'truncated') sides.push(`candidate body (${candidate.body_size ?? 0} bytes)`);
    return [
      finding('$', 'body_too_large', {
        detail: `${sides.join(' and ')} exceeded the capture size cap and only a hash was recorded`,
      }),
    ];
  }
  if (rk === 'absent' && ck === 'absent') return [];
  if (rk !== ck) {
    const kind: FindingKind =
      rk === 'absent' ? 'unexpected' : ck === 'absent' ? 'missing' : 'body_format';
    return [
      finding('$', kind, {
        reference: rk === 'json' ? reference.body : undefined,
        candidate: ck === 'json' ? candidate.body : undefined,
        detail: `reference body is ${rk}, candidate body is ${ck}`,
      }),
    ];
  }
  if (rk === 'base64') {
    if (reference.body === candidate.body) return [];
    const rs = Buffer.from(reference.body as string, 'base64').byteLength;
    const cs = Buffer.from(candidate.body as string, 'base64').byteLength;
    return [
      finding('$', 'value', {
        detail: `binary bodies differ (reference ${rs} bytes, candidate ${cs} bytes)`,
      }),
    ];
  }
  return new BodyWalker(compiled, equivalences).run(reference.body, candidate.body);
}

export function createDiffer(rules: DiffRules): Differ {
  const compiled = compile(rules);
  return {
    rules,
    diff(reference, candidate, equivalences) {
      const findings: Finding[] = [];
      const status = compareStatus(compiled, reference, candidate);
      if (status) findings.push(status);
      findings.push(...compareHeaders(compiled, reference, candidate));
      findings.push(...compareBodies(compiled, equivalences, reference, candidate));
      return { verdict: verdictOf(findings), findings };
    },
    diffBodies(reference, candidate, equivalences) {
      return new BodyWalker(compiled, equivalences).run(reference, candidate);
    },
    diffStatus(reference, candidate) {
      const status = compareStatus(compiled, reference, candidate);
      const findings = status ? [status] : [];
      return { verdict: verdictOf(findings), findings };
    },
  };
}

/** Returns the sorted, de-duplicated list of paths that were not tolerated. */
export function mismatchPaths(diff: Diff): string[] {
  return [...new Set(diff.findings.filter((f) => !f.tolerated).map((f) => f.path))].sort();
}

export function isJsonBody(value: unknown): value is JsonValue {
  return (
    value !== undefined &&
    (isJsonObject(value) || Array.isArray(value) || typeof value !== 'object' || value === null)
  );
}
