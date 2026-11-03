import { writeFile } from 'node:fs/promises';
import {
  ConfigError,
  EXIT_CODES,
  captureValue,
  createDiffer,
  describeCapture,
  describeWhen,
  emptyRules,
  equivalenceEntries,
  exchangeContext,
  headerEntries,
  ignoreEntries,
  loadDiffRules,
  parsePath,
  parseTimestamp,
  readRecording,
  renderPath,
  select,
  whenMatches,
  type DiffRules,
  type Exchange,
  type JsonValue,
  type Segment,
  type TimeFormat,
  type When,
} from '@replay-parity/core';
import { Command } from 'commander';
import { out, type CliStreams } from '../io.js';
import { collect } from '../options.js';
import { renderTable } from './recording.js';

/**
 * `rp rules`: tools over a diff rules file. `lint` shows every rule with its
 * scope and how much of a recording it reaches. `suggest` compares two
 * recordings of the same traffic and writes candidate rules for review; it
 * never changes a rules file.
 */

/** One rule of a rules file, under the name the differ gives its findings. */
export interface RuleEntry {
  name: string;
  kind: string;
  /** What the rule acts on, in words. */
  target: string;
  when: When | undefined;
  /** The body path a path rule matches. */
  path?: string;
  /** The response header a header rule names, lower cased. */
  header?: string;
  /** The index into `substitutions` for a substitution rule. */
  substitution?: number;
}

/** Every rule in the file, in the order the differ numbers them. */
export function ruleCatalog(rules: DiffRules): RuleEntry[] {
  const out: RuleEntry[] = [];
  const pathRule = (name: string, kind: string, path: string, when: When | undefined, extra = '') =>
    out.push({ name, kind, target: `${path}${extra}`, when, path });
  ignoreEntries(rules).forEach((r, i) => pathRule(`ignore[${i}]`, 'ignore', r.path, r.when));
  rules.tolerances.forEach((r, i) => {
    const parts: string[] = [];
    if (r.abs !== undefined) parts.push(`abs ${r.abs}`);
    if (r.rel !== undefined) parts.push(`rel ${r.rel}`);
    pathRule(`tolerances[${i}]`, 'tolerance', r.path, r.when, ` (${parts.join(' or ')})`);
  });
  rules.unordered.forEach((r, i) =>
    pathRule(
      `unordered[${i}]`,
      'unordered',
      r.path,
      r.when,
      r.key === undefined ? '' : ` (key ${r.key})`,
    ),
  );
  rules.decimal.forEach((r, i) =>
    pathRule(`decimal[${i}]`, 'decimal', r.path, r.when, ` (scale ${r.scale})`),
  );
  rules.time.forEach((r, i) =>
    pathRule(`time[${i}]`, 'time', r.path, r.when, ` (${r.format}, ${r.abs_ms} ms)`),
  );
  rules.mask.forEach((r, i) => pathRule(`mask[${i}]`, 'mask', r.path, r.when, ` (${r.pattern})`));
  rules.status.equivalent.forEach((entry, i) => {
    if (Array.isArray(entry)) {
      out.push({
        name: `status.equivalent[${i}]`,
        kind: 'status',
        target: entry.join(', '),
        when: undefined,
      });
    } else {
      entry.classes.forEach((codes, j) =>
        out.push({
          name: `status.equivalent[${i}].classes[${j}]`,
          kind: 'status',
          target: codes.join(', '),
          when: entry.when,
        }),
      );
    }
  });
  headerEntries(rules.headers.compare).forEach((h, i) =>
    out.push({
      name: `headers.compare[${i}]`,
      kind: 'header',
      target: h.name,
      when: h.when,
      header: h.name,
    }),
  );
  headerEntries(rules.headers.ignore).forEach((h, i) =>
    out.push({
      name: `headers.ignore[${i}]`,
      kind: 'header ignore',
      target: h.name,
      when: h.when,
      header: h.name,
    }),
  );
  rules.headers.masks.forEach((m, i) => {
    const header = m.name.toLowerCase();
    out.push({
      name: `headers.masks[${i}]`,
      kind: 'header mask',
      target: `${header} (${m.pattern})`,
      when: m.when,
      header,
    });
  });
  out.push({
    name: 'extra_fields',
    kind: 'extra fields',
    target: rules.extra_fields,
    when: undefined,
  });
  rules.extra_fields_rules.forEach((r, i) =>
    out.push({
      name: `extra_fields_rules[${i}]`,
      kind: 'extra fields',
      target: r.allow ? 'allow' : 'deny',
      when: r.when,
    }),
  );
  const listed = Array.isArray(rules.equivalences);
  equivalenceEntries(rules).forEach((e, i) => {
    const flags = (['null_absent', 'empty_absent', 'numeric_strings'] as const).filter((f) => e[f]);
    if (flags.length === 0 && !listed) return;
    out.push({
      name: listed ? `equivalences[${i}]` : 'equivalences',
      kind: 'equivalences',
      target: flags.length === 0 ? 'none' : flags.join(', '),
      when: e.when,
    });
  });
  rules.substitutions.forEach((s, i) =>
    out.push({
      name: `substitution:${s.name}`,
      kind: 'substitution',
      target: `${describeCapture(s.capture)} (tag ${s.capture.tag})`,
      when: undefined,
      substitution: i,
    }),
  );
  return out;
}

export interface LintRow {
  name: string;
  kind: string;
  target: string;
  scope: string;
  /** Exchanges in the rule's scope. */
  in_scope: number;
  /** Exchanges the rule reaches, or null for a rule that does not name a path, a header, or a capture. */
  matched: number | null;
  level: 'ok' | 'warn';
}

export interface LintReport {
  rules: string;
  recording: string;
  exchanges: number;
  rows: LintRow[];
  /** For every tag in the recording, the rules that apply to at least one exchange carrying it. */
  by_tag: { tag: string; exchanges: number; rules: string[] }[];
  warnings: number;
}

function applies(when: When | undefined, e: Exchange): boolean {
  return whenMatches(when, exchangeContext(e));
}

export function lintRules(
  rules: DiffRules,
  exchanges: readonly Exchange[],
  names: { rules: string; recording: string },
): LintReport {
  const catalog = ruleCatalog(rules);
  const rows = catalog.map((entry): LintRow => {
    const capture =
      entry.substitution === undefined
        ? undefined
        : (rules.substitutions[entry.substitution] as DiffRules['substitutions'][number]).capture;
    // A substitution reaches the exchanges carrying its capture tag; any other rule those in its scope.
    const scoped = exchanges.filter((e) =>
      capture === undefined ? applies(entry.when, e) : e.tags.includes(capture.tag),
    );
    let matched: number | null = null;
    if (entry.path !== undefined) {
      const segments = parsePath(entry.path);
      matched = scoped.filter((e) => select(e.response.body, segments).length > 0).length;
    } else if (entry.header !== undefined) {
      const header = entry.header;
      matched = scoped.filter((e) => e.response.headers[header] !== undefined).length;
    } else if (capture !== undefined) {
      matched = scoped.filter(
        (e) => captureValue(capture, e.response, e.request) !== undefined,
      ).length;
    }
    return {
      name: entry.name,
      kind: entry.kind,
      target: entry.target,
      scope: describeWhen(entry.when),
      in_scope: scoped.length,
      matched,
      level: matched === 0 ? 'warn' : 'ok',
    };
  });
  const tags = [...new Set(exchanges.flatMap((e) => e.tags))].sort();
  const by_tag = tags.map((tag) => {
    const carrying = exchanges.filter((e) => e.tags.includes(tag));
    return {
      tag,
      exchanges: carrying.length,
      rules: catalog
        .filter((entry) => carrying.some((e) => applies(entry.when, e)))
        .map((entry) => entry.name),
    };
  });
  return {
    rules: names.rules,
    recording: names.recording,
    exchanges: exchanges.length,
    rows,
    by_tag,
    warnings: rows.filter((r) => r.level === 'warn').length,
  };
}

export function renderLint(report: LintReport): string {
  const lines = [
    `${report.rules}: ${report.rows.length} rule${report.rows.length === 1 ? '' : 's'} against ${report.exchanges} exchanges in ${report.recording}`,
  ];
  if (report.rows.length > 0) {
    lines.push(
      renderTable(
        [
          ['level', 'rule', 'kind', 'target', 'scope', 'matched'],
          ...report.rows.map((r) => [
            r.level,
            r.name,
            r.kind,
            r.target,
            r.scope,
            r.matched === null ? '-' : `${r.matched} of ${r.in_scope}`,
          ]),
        ],
        ['l', 'l', 'l', 'l', 'l', 'r'],
      ).replace(/^/gm, '  '),
    );
  }
  for (const r of report.rows) {
    if (r.level === 'warn') {
      lines.push(`warn: ${r.name} ${r.target} matches nothing in its scope (${r.scope})`);
    }
  }
  if (report.by_tag.length > 0) {
    lines.push('effective rules by tag');
    for (const t of report.by_tag) {
      lines.push(
        `  ${t.tag} (${t.exchanges} exchange${t.exchanges === 1 ? '' : 's'}): ${t.rules.length === 0 ? 'none' : t.rules.join(', ')}`,
      );
    }
  }
  lines.push(`${report.warnings} warning${report.warnings === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}

export interface LintCommandOptions {
  rules: string;
  recording: string;
  json: boolean;
}

export async function runLint(options: LintCommandOptions, streams: CliStreams): Promise<number> {
  const rules = await loadDiffRules(options.rules);
  const exchanges = await readRecording(options.recording);
  const report = lintRules(rules, exchanges, {
    rules: options.rules,
    recording: options.recording,
  });
  out(streams, options.json ? JSON.stringify(report, null, 2) : renderLint(report));
  return EXIT_CODES.pass;
}

/** A concrete finding path with every index and keyed segment widened to `[*]`. */
export function generalizePath(path: string): string {
  return renderPath(
    parsePath(path).map((s): Segment =>
      s.type === 'index' || s.type === 'keyed' ? { type: 'wildcard' } : s,
    ),
  );
}

interface PathEvidence {
  path: string;
  /** Response pairs in which the path holds a value on both sides. */
  present: number;
  /** Findings by kind. */
  kinds: Map<string, number>;
  /** The pairs of differing values. */
  values: [JsonValue | undefined, JsonValue | undefined][];
}

export interface Suggestion {
  kind: 'ignore' | 'time' | 'mask';
  path: string;
  /** The YAML of the rule entry, without the leading dash. */
  entry: string;
  evidence: string;
}

export interface SuggestReport {
  recordings: [string, string];
  pairs: number;
  /** Exchanges left unpaired: past the end of the shorter recording or with a different method. */
  unpaired: number;
  differing_pairs: number;
  suggestions: Suggestion[];
  unexplained: { path: string; evidence: string }[];
}

const TIME_WINDOWS = [1000, 5000, 60_000, 300_000, 3_600_000, 86_400_000];

/** The smallest of a few round windows that covers `ms`, or `ms` rounded up to a second. */
function window(ms: number): number {
  return TIME_WINDOWS.find((w) => w >= ms) ?? Math.ceil(ms / 1000) * 1000;
}

/** The format every value reads under, trying ISO 8601 for strings and epoch scales for numbers. */
function timeFormat(values: readonly JsonValue[]): TimeFormat | undefined {
  const fits = (format: TimeFormat, ok: (n: number) => boolean) =>
    values.every((v) => {
      const ms = parseTimestamp(v, format);
      return ms !== undefined && ok(typeof v === 'number' ? v : Number.NaN);
    });
  if (values.every((v) => typeof v === 'string') && fits('iso8601', () => true)) return 'iso8601';
  if (values.every((v) => typeof v === 'number')) {
    // Plausible epochs only: 2001 to 2286 in milliseconds, or the same span in seconds.
    if (fits('epoch_ms', (n) => n >= 1e12 && n < 1e13)) return 'epoch_ms';
    if (fits('epoch_s', (n) => n >= 1e9 && n < 1e10)) return 'epoch_s';
  }
  return undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLASSES: [string, RegExp][] = [
  ['[0-9]', /^[0-9]+$/],
  ['[0-9a-f]', /^[0-9a-f]+$/],
  ['[0-9A-F]', /^[0-9A-F]+$/],
  ['[A-Za-z0-9]', /^[A-Za-z0-9]+$/],
  ['[A-Za-z0-9_-]', /^[A-Za-z0-9_-]+$/],
];

/**
 * A pattern every value matches, when the values share a shape: a UUID, or a
 * literal prefix that ends in punctuation followed by one character class,
 * or one class at one fixed length. `undefined` when no such shape exists,
 * so a value without structure is left to `ignore`.
 */
export function shapePattern(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((v) => UUID.test(v))) {
    return '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  }
  let prefix = values[0] as string;
  for (const v of values) {
    let n = 0;
    while (n < prefix.length && n < v.length && prefix[n] === v[n]) n += 1;
    prefix = prefix.slice(0, n);
  }
  const cut = Math.max(...[...prefix].map((ch, i) => (/[A-Za-z0-9]/.test(ch) ? -1 : i)));
  prefix = cut < 0 ? '' : prefix.slice(0, cut + 1);
  const rests = values.map((v) => v.slice(prefix.length));
  if (rests.some((r) => r.length === 0)) return undefined;
  const found = CLASSES.find(([, re]) => rests.every((r) => re.test(r)));
  if (found === undefined) return undefined;
  const length = (rests[0] as string).length;
  const fixed = rests.every((r) => r.length === length);
  if (prefix.length === 0 && !fixed) return undefined;
  return `${escapeRegex(prefix)}${found[0]}${fixed ? `{${length}}` : '+'}`;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeKinds(kinds: Map<string, number>): string {
  return [...kinds.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ');
}

/** Pairs the exchanges of two recordings in order, by position and method. */
function pairExchanges(a: readonly Exchange[], b: readonly Exchange[]): [Exchange, Exchange][] {
  const pairs: [Exchange, Exchange][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as Exchange;
    const y = b[i] as Exchange;
    if (x.request.method === y.request.method) pairs.push([x, y]);
  }
  return pairs;
}

export function suggestRules(
  a: readonly Exchange[],
  b: readonly Exchange[],
  names: [string, string],
): SuggestReport {
  const pairs = pairExchanges(a, b);
  const differ = createDiffer(emptyRules());
  const evidence = new Map<string, PathEvidence>();
  const other = new Map<string, Map<string, number>>();
  let differing = 0;
  for (const [x, y] of pairs) {
    const diff = differ.diff(x.response, y.response);
    if (diff.findings.length > 0) differing += 1;
    for (const f of diff.findings) {
      if (f.path === 'status' || f.path.startsWith('header:') || f.path === '$') {
        const kinds = other.get(f.path) ?? new Map<string, number>();
        kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
        other.set(f.path, kinds);
        continue;
      }
      const path = generalizePath(f.path);
      let ev = evidence.get(path);
      if (ev === undefined) {
        ev = { path, present: 0, kinds: new Map(), values: [] };
        evidence.set(path, ev);
      }
      ev.kinds.set(f.kind, (ev.kinds.get(f.kind) ?? 0) + 1);
      if (f.kind === 'value' || f.kind === 'type') ev.values.push([f.reference, f.candidate]);
    }
  }
  // How many pairs hold a value at each differing path on both sides, for the evidence counts.
  for (const ev of evidence.values()) {
    const segments = parsePath(ev.path);
    ev.present = pairs.filter(
      ([x, y]) =>
        select(x.response.body, segments).length > 0 &&
        select(y.response.body, segments).length > 0,
    ).length;
  }
  const suggestions: Suggestion[] = [];
  const unexplained: { path: string; evidence: string }[] = [];
  for (const ev of [...evidence.values()].sort((p, q) => p.path.localeCompare(q.path))) {
    const valueCount = ev.kinds.get('value') ?? 0;
    const onlyValues = ev.kinds.size === 1 && valueCount > 0;
    const differs = `differs ${plural(valueCount, 'time')} across ${plural(ev.present, 'pair')} holding it`;
    const sides = ev.values
      .flatMap(([r, c]) => [r, c])
      .filter((v): v is JsonValue => v !== undefined);
    if (onlyValues) {
      const format = timeFormat(sides);
      if (format !== undefined) {
        const apart = Math.max(
          ...ev.values.map(([r, c]) =>
            Math.abs((parseTimestamp(r, format) as number) - (parseTimestamp(c, format) as number)),
          ),
        );
        const abs = window(apart);
        suggestions.push({
          kind: 'time',
          path: ev.path,
          entry: `{ path: ${quote(ev.path)}, abs_ms: ${abs}, format: ${format} }`,
          evidence: `${differs}, every value reads as ${format}, at most ${apart} ms apart`,
        });
        continue;
      }
      const strings = sides.filter((v): v is string => typeof v === 'string');
      const pattern = strings.length === sides.length ? shapePattern(strings) : undefined;
      if (pattern !== undefined) {
        suggestions.push({
          kind: 'mask',
          path: ev.path,
          entry: `{ path: ${quote(ev.path)}, pattern: ${quote(pattern)} }`,
          evidence: `${differs}, all ${plural(strings.length, 'value')} match the pattern`,
        });
        continue;
      }
      // A value that differs every time it is present, in at least two pairs, is volatile.
      if (ev.present >= 2 && valueCount >= ev.present) {
        suggestions.push({
          kind: 'ignore',
          path: ev.path,
          entry: quote(ev.path),
          evidence: `${differs}, with no shape in common`,
        });
        continue;
      }
    }
    unexplained.push({
      path: ev.path,
      evidence: `${describeKinds(ev.kinds)} across ${plural(ev.present, 'pair')} holding it`,
    });
  }
  for (const [path, kinds] of [...other.entries()].sort((p, q) => p[0].localeCompare(q[0]))) {
    unexplained.push({ path, evidence: describeKinds(kinds) });
  }
  return {
    recordings: names,
    pairs: pairs.length,
    unpaired: Math.max(a.length, b.length) - pairs.length,
    differing_pairs: differing,
    suggestions,
    unexplained,
  };
}

/** The suggested rules as a rules file, every entry preceded by its evidence. */
export function renderSuggestions(report: SuggestReport): string {
  const lines = [
    `# Suggested by rp rules suggest from ${report.recordings[0]} and ${report.recordings[1]}.`,
    `# ${plural(report.pairs, 'response pair')} compared under empty rules, ${report.differing_pairs} with differences, ${plural(report.unpaired, 'exchange')} unpaired.`,
    '# Review every entry before copying it into a rules file. Nothing here is applied automatically.',
  ];
  for (const kind of ['ignore', 'time', 'mask'] as const) {
    const entries = report.suggestions.filter((s) => s.kind === kind);
    if (entries.length === 0) continue;
    lines.push(`${kind}:`);
    for (const s of entries) {
      lines.push(`  # ${s.evidence}`);
      lines.push(`  - ${s.entry}`);
    }
  }
  if (report.suggestions.length === 0) lines.push('# No rule to suggest.');
  if (report.unexplained.length > 0) {
    lines.push('# Unexplained differences, not covered by any suggestion:');
    for (const u of report.unexplained) lines.push(`#   ${u.path}: ${u.evidence}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface SuggestCommandOptions {
  recording: string[];
  out: string;
  json: boolean;
}

export async function runSuggest(
  options: SuggestCommandOptions,
  streams: CliStreams,
): Promise<number> {
  if (options.recording.length !== 2) {
    throw new ConfigError(
      `suggest needs --recording exactly twice, got ${options.recording.length}`,
    );
  }
  const [first, second] = options.recording as [string, string];
  const report = suggestRules(await readRecording(first), await readRecording(second), [
    first,
    second,
  ]);
  await writeFile(options.out, renderSuggestions(report), 'utf8');
  if (options.json) {
    out(streams, JSON.stringify({ out: options.out, ...report }, null, 2));
  } else {
    const counts = (['ignore', 'time', 'mask'] as const)
      .map((k) => `${report.suggestions.filter((s) => s.kind === k).length} ${k}`)
      .join(', ');
    out(
      streams,
      `compared ${plural(report.pairs, 'response pair')}, ${report.differing_pairs} with differences: suggested ${counts}, ${report.unexplained.length} unexplained, written to ${options.out}`,
    );
  }
  return EXIT_CODES.pass;
}

/** Applies the program's stream and exit settings to a nested command, which commander does not inherit. */
function configure(cmd: Command, streams: CliStreams): Command {
  return cmd
    .configureOutput({
      writeOut: (text) => {
        streams.stdout.write(text);
      },
      writeErr: (text) => {
        streams.stderr.write(text);
      },
    })
    .exitOverride()
    .showHelpAfterError('(run with --help for the list of flags)');
}

export function rulesCommand(streams: CliStreams, exit: (code: number) => void): Command {
  const rules = new Command('rules').description(
    'Check a diff rules file against a recording, and suggest rules from two recordings of the same traffic.',
  );
  rules.addCommand(
    configure(
      new Command('lint')
        .description(
          'List every rule with its scope and the number of recorded exchanges it reaches, warn on a rule that reaches none, and list the rules in effect for each tag.',
        )
        .requiredOption('--rules <path>', 'the diff rules file')
        .requiredOption('--recording <path>', 'the recording whose response bodies are checked')
        .option('--json', 'print JSON instead of a table', false)
        .action(async (opts: LintCommandOptions) => {
          exit(await runLint(opts, streams));
        }),
      streams,
    ),
  );
  rules.addCommand(
    configure(
      new Command('suggest')
        .description(
          'Diff each response pair of two recordings of the same traffic under empty rules and write suggested ignore, time, and mask rules with their evidence. The rest is listed as unexplained. Nothing is applied.',
        )
        .option(
          '--recording <path>',
          'a recording, given twice: the first and the second capture',
          collect,
          [],
        )
        .requiredOption('--out <path>', 'the file the suggested rules are written to')
        .option('--json', 'print the report as JSON', false)
        .action(async (opts: SuggestCommandOptions) => {
          exit(await runSuggest(opts, streams));
        }),
      streams,
    ),
  );
  return rules;
}
