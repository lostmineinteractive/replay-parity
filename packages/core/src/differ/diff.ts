import {
  canonicalJson,
  isJsonObject,
  isLosslessNumber,
  jsonType,
  stripUndefined,
  type JsonValue,
} from '../json.js';
import {
  get,
  isPlainPath,
  keyValueText,
  matches,
  matchesWith,
  parsePath,
  renderPath,
  rowKeyText,
  type ElementAt,
  type Segment,
} from '../jsonpath/index.js';
import { bodyKind } from '../recording/body.js';
import type { RecordedResponse } from '../recording/types.js';
import { decimalsEqual } from '../rules/decimal.js';
import { parseNumericText } from '../rules/numeric.js';
import { compileAnchored } from '../rules/pattern.js';
import {
  equivalenceEntries,
  headerEntries,
  ignoreEntries,
  type DiffRules,
} from '../rules/schema.js';
import { whenMatches, type DiffContext, type When } from '../rules/scope.js';
import { parseTimestamp, type TimeFormat } from '../rules/time.js';
import {
  exactDecimalOf,
  exactDecimalsEqual,
  withinExactTolerance,
  type ExactDecimal,
} from './exact-number.js';
import type { Diff, Finding, FindingKind, Verdict } from './schema.js';

/**
 * Structural response differ driven by the rules file.
 *
 * Value equivalences come from substitutions: `name -> canonical reference value -> canonical
 * candidate value`. A pair that maps under some name is reported as tolerated by
 * `substitution:<name>`.
 *
 * The optional context names the exchange being compared: its tags, method, and
 * path. A rule with a `when` scope applies only when the context matches it.
 * Rules without a scope apply always. Without a context the exchange is unknown
 * and every rule applies, scoped or not, so a caller that does not pass one yet
 * keeps every rule of the file in force.
 */
export type ValueEquivalences = ReadonlyMap<string, ReadonlyMap<string, string>>;
export type { DiffContext } from '../rules/scope.js';

export interface Differ {
  readonly rules: DiffRules;
  diff(
    reference: RecordedResponse,
    candidate: RecordedResponse,
    equivalences?: ValueEquivalences,
    context?: DiffContext,
  ): Diff;
  diffBodies(
    reference: JsonValue | undefined,
    candidate: JsonValue | undefined,
    equivalences?: ValueEquivalences,
    context?: DiffContext,
  ): Finding[];
  /** Compares the status only. Used for harness control exchanges. */
  diffStatus(reference: RecordedResponse, candidate: RecordedResponse, context?: DiffContext): Diff;
}

interface Scoped {
  when: When | undefined;
  name: string;
}

interface PathRule extends Scoped {
  segs: Segment[];
  /** Without a filter or a descent the rule is matched without the document. */
  plain: boolean;
}

interface CompiledTolerance extends PathRule {
  abs: number | undefined;
  rel: number | undefined;
}

interface CompiledUnordered extends PathRule {
  key: Segment[] | undefined;
  keyLabel: string;
}

interface CompiledDecimal extends PathRule {
  scale: number;
}

interface CompiledTime extends PathRule {
  absMs: number;
  format: TimeFormat;
}

interface CompiledMask extends PathRule {
  regex: RegExp;
  pattern: string;
}

interface CompiledStatusClass extends Scoped {
  codes: number[];
}

interface CompiledHeader extends Scoped {
  header: string;
}

interface CompiledHeaderMask extends CompiledHeader {
  regex: RegExp;
  pattern: string;
}

interface CompiledExtraFields extends Scoped {
  allow: boolean;
}

interface CompiledEquivalence extends Scoped {
  nullAbsent: boolean;
  emptyAbsent: boolean;
  numericStrings: boolean;
}

interface Compiled {
  ignore: PathRule[];
  tolerances: CompiledTolerance[];
  unordered: CompiledUnordered[];
  decimal: CompiledDecimal[];
  time: CompiledTime[];
  mask: CompiledMask[];
  statusClasses: CompiledStatusClass[];
  headersCompare: CompiledHeader[];
  headersIgnore: CompiledHeader[];
  headerMasks: CompiledHeaderMask[];
  extraFields: boolean;
  extraFieldsRules: CompiledExtraFields[];
  equivalences: CompiledEquivalence[];
  /** True when any rule carries a scope, so activation depends on the context. */
  scoped: boolean;
}

/** The rule names that tolerate each equivalence, or undefined when the flag is off in this scope. */
interface ActiveEquivalences {
  nullAbsent: string | undefined;
  emptyAbsent: string | undefined;
  numericStrings: string | undefined;
}

/** The rules in effect for one context. */
interface Active {
  ignore: PathRule[];
  tolerances: CompiledTolerance[];
  unordered: CompiledUnordered[];
  decimal: CompiledDecimal[];
  time: CompiledTime[];
  mask: CompiledMask[];
  statusClasses: CompiledStatusClass[];
  /** Compared header names, lower cased, in the order given, minus the ignored ones. */
  headers: string[];
  headerMasks: CompiledHeaderMask[];
  extraFields: { allow: boolean; name: string };
  eq: ActiveEquivalences;
}

function pathRule(path: string, when: When | undefined, name: string): PathRule {
  const segs = parsePath(path);
  return { segs, plain: isPlainPath(segs), when, name };
}

function compile(rules: DiffRules): Compiled {
  const equivalences = equivalenceEntries(rules);
  const listed = Array.isArray(rules.equivalences);
  const compiled: Compiled = {
    ignore: ignoreEntries(rules).map((r, i) => pathRule(r.path, r.when, `ignore[${i}]`)),
    tolerances: rules.tolerances.map((t, i) => ({
      ...pathRule(t.path, t.when, `tolerances[${i}]`),
      abs: t.abs,
      rel: t.rel,
    })),
    unordered: rules.unordered.map((u, i) => {
      const key = u.key === undefined ? undefined : parsePath(u.key);
      return {
        ...pathRule(u.path, u.when, `unordered[${i}]`),
        key,
        keyLabel: key === undefined ? '' : keyLabelOf(key),
      };
    }),
    decimal: rules.decimal.map((d, i) => ({
      ...pathRule(d.path, d.when, `decimal[${i}]`),
      scale: d.scale,
    })),
    time: rules.time.map((t, i) => ({
      ...pathRule(t.path, t.when, `time[${i}]`),
      absMs: t.abs_ms,
      format: t.format,
    })),
    mask: rules.mask.map((m, i) => ({
      ...pathRule(m.path, m.when, `mask[${i}]`),
      regex: compileAnchored(m.pattern),
      pattern: m.pattern,
    })),
    statusClasses: rules.status.equivalent.flatMap((entry, i) =>
      Array.isArray(entry)
        ? [{ codes: entry, when: undefined, name: `status.equivalent[${i}]` }]
        : entry.classes.map((codes, j) => ({
            codes,
            when: entry.when,
            name: `status.equivalent[${i}].classes[${j}]`,
          })),
    ),
    headersCompare: headerEntries(rules.headers.compare).map((h, i) => ({
      header: h.name,
      when: h.when,
      name: `headers.compare[${i}]`,
    })),
    headersIgnore: headerEntries(rules.headers.ignore).map((h, i) => ({
      header: h.name,
      when: h.when,
      name: `headers.ignore[${i}]`,
    })),
    headerMasks: rules.headers.masks.map((m, i) => ({
      header: m.name.toLowerCase(),
      regex: compileAnchored(m.pattern),
      pattern: m.pattern,
      when: m.when,
      name: `headers.masks[${i}]`,
    })),
    extraFields: rules.extra_fields === 'allow',
    extraFieldsRules: rules.extra_fields_rules.map((r, i) => ({
      allow: r.allow,
      when: r.when,
      name: `extra_fields_rules[${i}]`,
    })),
    equivalences: equivalences.map((e, i) => ({
      nullAbsent: e.null_absent,
      emptyAbsent: e.empty_absent,
      numericStrings: e.numeric_strings,
      when: e.when,
      name: listed ? `equivalences[${i}]` : 'equivalences',
    })),
    scoped: false,
  };
  const all: Scoped[] = [
    ...compiled.ignore,
    ...compiled.tolerances,
    ...compiled.unordered,
    ...compiled.decimal,
    ...compiled.time,
    ...compiled.mask,
    ...compiled.statusClasses,
    ...compiled.headersCompare,
    ...compiled.headersIgnore,
    ...compiled.headerMasks,
    ...compiled.extraFieldsRules,
    ...compiled.equivalences,
  ];
  compiled.scoped = all.some((r) => r.when !== undefined);
  return compiled;
}

/** The rules whose scope matches the context. */
function activate(compiled: Compiled, context: DiffContext | undefined): Active {
  const on = <T extends Scoped>(rules: T[]): T[] =>
    rules.filter((r) => whenMatches(r.when, context));
  const ignored = new Set(on(compiled.headersIgnore).map((h) => h.header));
  const headers: string[] = [];
  for (const h of on(compiled.headersCompare)) {
    if (!ignored.has(h.header) && !headers.includes(h.header)) headers.push(h.header);
  }
  const scopedExtra = on(compiled.extraFieldsRules)[0];
  const eqs = on(compiled.equivalences);
  const flag = (pick: (e: CompiledEquivalence) => boolean, key: string): string | undefined => {
    const hit = eqs.find(pick);
    return hit === undefined ? undefined : `${hit.name}.${key}`;
  };
  return {
    ignore: on(compiled.ignore),
    tolerances: on(compiled.tolerances),
    unordered: on(compiled.unordered),
    decimal: on(compiled.decimal),
    time: on(compiled.time),
    mask: on(compiled.mask),
    statusClasses: on(compiled.statusClasses),
    headers,
    headerMasks: on(compiled.headerMasks),
    extraFields:
      scopedExtra === undefined
        ? { allow: compiled.extraFields, name: 'extra_fields' }
        : { allow: scopedExtra.allow, name: scopedExtra.name },
    eq: {
      nullAbsent: flag((e) => e.nullAbsent, 'null_absent'),
      emptyAbsent: flag((e) => e.emptyAbsent, 'empty_absent'),
      numericStrings: flag((e) => e.numericStrings, 'numeric_strings'),
    },
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

/** `""`, `[]`, and `{}`. */
function isEmpty(value: JsonValue): boolean {
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isJsonObject(value) && Object.keys(value).length === 0;
}

/** A path that names a member of an object, which is what `extra_fields` is about. */
function isField(path: readonly Segment[]): boolean {
  return path[path.length - 1]?.type === 'key';
}

/** The type of a value for comparison: a lossless number is a number. */
function typeName(value: JsonValue): ReturnType<typeof jsonType> {
  return isLosslessNumber(value) ? 'number' : jsonType(value);
}

/** The text of a number: a lossless number's source text, or the value itself. */
function numberText(value: JsonValue): JsonValue {
  return isLosslessNumber(value) ? value.$num : value;
}

/** Whether one value is a string that spells the other, a number. */
function numericStringEqual(a: JsonValue, b: JsonValue): boolean {
  const [text, num] = typeof a === 'string' ? [a, b] : [b, a];
  if (typeof text !== 'string' || typeof num !== 'number') return false;
  return parseNumericText(text) === num;
}

class BodyWalker {
  private readonly out: Finding[] = [];
  /** The values along the current path on each side, for filter rules. */
  private readonly refStack: (JsonValue | undefined)[] = [];
  private readonly candStack: (JsonValue | undefined)[] = [];
  private readonly refAt: ElementAt = (n) => this.refStack[n];
  private readonly candAt: ElementAt = (n) => this.candStack[n];

  constructor(
    private readonly active: Active,
    private readonly equivalences: ValueEquivalences | undefined,
  ) {}

  run(reference: JsonValue | undefined, candidate: JsonValue | undefined): Finding[] {
    this.compare(reference, candidate, []);
    return this.out;
  }

  /** The first rule whose path matches. A filter or descent rule is matched against either side. */
  private findRule<T extends PathRule>(rules: T[], path: readonly Segment[]): T | undefined {
    return rules.find((r) =>
      r.plain
        ? matches(r.segs, path)
        : matchesWith(r.segs, path, this.refAt) || matchesWith(r.segs, path, this.candAt),
    );
  }

  private compare(ref: JsonValue | undefined, cand: JsonValue | undefined, path: Segment[]): void {
    this.refStack[path.length] = ref;
    this.candStack[path.length] = cand;
    if (this.findRule(this.active.ignore, path)) return;
    const rendered = renderPath(path);
    if (ref === undefined && cand === undefined) return;
    if (ref === undefined) {
      this.unexpected(cand as JsonValue, path, rendered);
      return;
    }
    if (cand === undefined) {
      this.missing(ref, rendered);
      return;
    }
    if (isLosslessNumber(ref) || isLosslessNumber(cand)) {
      const a = exactDecimalOf(ref);
      const b = exactDecimalOf(cand);
      if (a !== undefined && b !== undefined) {
        const texts = [numberText(ref), numberText(cand)] as const;
        if (this.compareDecimal(ref, cand, path, rendered, texts)) return;
        this.compareExact(ref, cand, a, b, path, rendered);
        return;
      }
    }
    if (ref !== cand) {
      if (this.compareDecimal(ref, cand, path, rendered)) return;
      if (this.compareTime(ref, cand, path, rendered)) return;
    }
    const tr = typeName(ref);
    const tc = typeName(cand);
    if (tr === 'array' && tc === 'array') {
      const unordered = this.findRule(this.active.unordered, path);
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
      const detail = `reference is ${tr}, candidate is ${tc}`;
      const numeric = this.active.eq.numericStrings;
      if (numeric !== undefined && numericStringEqual(ref, cand)) {
        this.out.push(
          finding(rendered, 'type', {
            reference: ref,
            candidate: cand,
            tolerated: true,
            rule: numeric,
            detail,
          }),
        );
        return;
      }
      this.out.push(finding(rendered, 'type', { reference: ref, candidate: cand, detail }));
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
    if (tr === 'string') {
      const mask = this.findRule(this.active.mask, path);
      if (mask && mask.regex.test(ref as string) && mask.regex.test(cand as string)) {
        this.out.push(
          finding(rendered, 'value', {
            reference: ref,
            candidate: cand,
            tolerated: true,
            rule: mask.name,
            detail: `both match ${mask.pattern}`,
          }),
        );
        return;
      }
    }
    this.out.push(finding(rendered, 'value', { reference: ref, candidate: cand }));
  }

  private unexpected(cand: JsonValue, path: Segment[], rendered: string): void {
    const { eq, extraFields } = this.active;
    let rule: string | undefined;
    let detail: string | undefined;
    if (cand === null && eq.nullAbsent !== undefined) {
      rule = eq.nullAbsent;
      detail = 'null and absent are equivalent';
    } else if (eq.emptyAbsent !== undefined && isEmpty(cand)) {
      rule = eq.emptyAbsent;
      detail = 'empty and absent are equivalent';
    } else if (extraFields.allow && isField(path)) {
      rule = extraFields.name;
      detail = 'extra fields are allowed';
    }
    this.out.push(
      finding(rendered, 'unexpected', {
        candidate: cand,
        tolerated: rule !== undefined,
        rule,
        detail,
      }),
    );
  }

  private missing(ref: JsonValue, rendered: string): void {
    const { eq } = this.active;
    let rule: string | undefined;
    let detail: string | undefined;
    if (ref === null && eq.nullAbsent !== undefined) {
      rule = eq.nullAbsent;
      detail = 'null and absent are equivalent';
    } else if (eq.emptyAbsent !== undefined && isEmpty(ref)) {
      rule = eq.emptyAbsent;
      detail = 'empty and absent are equivalent';
    }
    this.out.push(
      finding(rendered, 'missing', { reference: ref, tolerated: rule !== undefined, rule, detail }),
    );
  }

  /**
   * Compares two decimals under a matching rule. False when no rule applies or a side is not a
   * decimal. `texts` stands in for the values when they are lossless numbers.
   */
  private compareDecimal(
    ref: JsonValue,
    cand: JsonValue,
    path: Segment[],
    rendered: string,
    texts: readonly [JsonValue, JsonValue] = [ref, cand],
  ): boolean {
    const rule = this.findRule(this.active.decimal, path);
    if (rule === undefined) return false;
    const equal = decimalsEqual(texts[0], texts[1], rule.scale);
    if (equal === undefined) return false;
    const places = `${rule.scale} place${rule.scale === 1 ? '' : 's'}`;
    this.out.push(
      finding(rendered, 'value', {
        reference: ref,
        candidate: cand,
        tolerated: equal,
        rule: equal ? rule.name : undefined,
        detail: equal
          ? `equal after rounding to ${places}`
          : `differ after rounding to ${places} under ${rule.name}`,
      }),
    );
    return true;
  }

  /** Compares two timestamps under a matching rule. False when no rule applies or a side does not parse. */
  private compareTime(ref: JsonValue, cand: JsonValue, path: Segment[], rendered: string): boolean {
    const rule = this.findRule(this.active.time, path);
    if (rule === undefined) return false;
    const a = parseTimestamp(ref, rule.format);
    const b = parseTimestamp(cand, rule.format);
    if (a === undefined || b === undefined) return false;
    const apart = Math.abs(a - b);
    const within = apart <= rule.absMs;
    this.out.push(
      finding(rendered, 'value', {
        reference: ref,
        candidate: cand,
        tolerated: within,
        rule: within ? rule.name : undefined,
        detail: within
          ? `${apart} ms apart, within ${rule.absMs} ms`
          : `${apart} ms apart, outside ${rule.absMs} ms of ${rule.name}`,
      }),
    );
    return true;
  }

  /**
   * Compares a lossless number with a lossless number or a plain number by
   * exact decimal value, with the tolerance rules worked exactly as well.
   */
  private compareExact(
    ref: JsonValue,
    cand: JsonValue,
    a: ExactDecimal,
    b: ExactDecimal,
    path: Segment[],
    rendered: string,
  ): void {
    if (exactDecimalsEqual(a, b)) return;
    const tol = this.findRule(this.active.tolerances, path);
    if (tol && withinExactTolerance(a, b, tol.abs, tol.rel)) {
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

  private compareNumbers(ref: number, cand: number, path: Segment[]): void {
    if (ref === cand) return;
    const rendered = renderPath(path);
    const tol = this.findRule(this.active.tolerances, path);
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
  active: Active,
  reference: RecordedResponse,
  candidate: RecordedResponse,
): Finding | null {
  if (reference.status === candidate.status) return null;
  const cls = active.statusClasses.find(
    (c) => c.codes.includes(reference.status) && c.codes.includes(candidate.status),
  );
  return finding('status', 'status', {
    reference: reference.status,
    candidate: candidate.status,
    tolerated: cls !== undefined,
    rule: cls?.name,
  });
}

function compareHeaders(
  active: Active,
  reference: RecordedResponse,
  candidate: RecordedResponse,
): Finding[] {
  const out: Finding[] = [];
  for (const name of active.headers) {
    const r = reference.headers[name];
    const c = candidate.headers[name];
    if (r === c) continue;
    const mask =
      r === undefined || c === undefined
        ? undefined
        : active.headerMasks.find((m) => m.header === name && m.regex.test(r) && m.regex.test(c));
    out.push(
      finding(`header:${name}`, 'header', {
        reference: r,
        candidate: c,
        tolerated: mask !== undefined,
        rule: mask?.name,
        detail: mask === undefined ? undefined : `both match ${mask.pattern}`,
      }),
    );
  }
  return out;
}

function compareBodies(
  active: Active,
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
  return new BodyWalker(active, equivalences).run(reference.body, candidate.body);
}

export function createDiffer(rules: DiffRules): Differ {
  const compiled = compile(rules);
  // Without a context, or without scoped rules, every rule is active, so that set is built once.
  const all = activate(compiled, undefined);
  const activeFor = (context: DiffContext | undefined): Active =>
    context === undefined || !compiled.scoped ? all : activate(compiled, context);
  return {
    rules,
    diff(reference, candidate, equivalences, context) {
      const active = activeFor(context);
      const findings: Finding[] = [];
      const status = compareStatus(active, reference, candidate);
      if (status) findings.push(status);
      findings.push(...compareHeaders(active, reference, candidate));
      findings.push(...compareBodies(active, equivalences, reference, candidate));
      return { verdict: verdictOf(findings), findings };
    },
    diffBodies(reference, candidate, equivalences, context) {
      return new BodyWalker(activeFor(context), equivalences).run(reference, candidate);
    },
    diffStatus(reference, candidate, context) {
      const status = compareStatus(activeFor(context), reference, candidate);
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
