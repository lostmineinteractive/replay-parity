import { randomInt } from 'node:crypto';
import {
  ConfigError,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REDACTED_HEADERS,
  DEFAULT_REDACTED_QUERY,
  EXIT_CODES,
  compileFilter,
  filterExchanges,
  filterRecording,
  REDACTION_KEY_ENV,
  Redactor,
  anonymizeRecording,
  buildManifest,
  importHarFile,
  loadCaptureRules,
  loadDiffRules,
  mergeRecordings,
  migrateRecording,
  readRecording,
  recordingStats,
  sampleRecording,
  scanRecording,
  splitRecording,
  validateRecording,
  writeRebased,
  type RecordingManifest,
  type RecordingStats,
  type ScanReport,
  type ValidationResult,
} from '@replay-parity/core';
import { formatTagRule, parseTagRule, tagsFor } from '@replay-parity/capture';
import { DependencyIndex } from '@replay-parity/replay';
import { Command, Option } from 'commander';
import { err, out, type CliStreams } from '../io.js';
import { collect, fraction, nonNegativeInt, positiveInt, positiveNumber } from '../options.js';

/**
 * `rp recording`: tools over a recording file. Every subcommand reads its
 * input one line at a time and never alters it. `filter --include-dependencies`
 * is the one that holds the whole file in memory, because the producers of a
 * substituted value can sit anywhere before the exchange that uses it.
 */

type Align = 'l' | 'r';

/** Renders rows as aligned columns, two spaces apart, with no trailing spaces. */
export function renderTable(rows: readonly (readonly string[])[], align: readonly Align[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const width = widths[i] ?? 0;
          return align[i] === 'r' ? cell.padStart(width) : cell.padEnd(width);
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function countRows(table: Record<string, number>): string[][] {
  return Object.entries(table)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => [key, String(count)]);
}

/** One line naming what a manifest says: version, tool, creation time, and target. */
export function describeManifest(manifest: RecordingManifest): string {
  const target = manifest.target === null ? '' : `, target ${manifest.target}`;
  const part = manifest.part === undefined ? '' : `, part ${manifest.part}`;
  return `manifest ${manifest.manifest}: rp ${manifest.tool_version}, created ${manifest.created_at}${target}${part}`;
}

export function renderValidation(path: string, result: ValidationResult): string {
  const lines: string[] = [];
  if (result.ok) {
    const offsets =
      result.first_offset_ms === null
        ? 'no exchanges'
        : `offsets ${result.first_offset_ms} to ${result.last_offset_ms} ms`;
    lines.push(`${path}: valid, ${result.exchanges} exchanges, ${offsets}`);
    if (result.manifest !== null) lines.push(`  ${describeManifest(result.manifest)}`);
  } else {
    const problem = result.problem as NonNullable<ValidationResult['problem']>;
    lines.push(
      `${path}: invalid at line ${problem.line}: ${problem.message.replace(/^recording line \d+: /, '')}`,
    );
    lines.push(`  ${result.exchanges} exchanges parsed before the problem`);
  }
  const tags = countRows(result.by_tag);
  if (tags.length > 0) {
    lines.push('  tags');
    lines.push(renderTable(tags, ['l', 'r']).replace(/^/gm, '    '));
  }
  return `${lines.join('\n')}\n`;
}

export async function runValidate(path: string, streams: CliStreams): Promise<number> {
  const result = await validateRecording(path);
  out(streams, renderValidation(path, result));
  return result.ok ? EXIT_CODES.pass : EXIT_CODES.error;
}

export function renderStats(path: string, stats: RecordingStats): string {
  const lines: string[] = [];
  const span =
    stats.first_offset_ms === null
      ? 'no exchanges'
      : `offsets ${stats.first_offset_ms} to ${stats.last_offset_ms} ms (span ${stats.span_ms} ms)`;
  const when = stats.first_ts === null ? '' : `, ${stats.first_ts} to ${stats.last_ts}`;
  lines.push(`${path}: ${stats.exchanges} exchanges${when}, ${span}`);
  if (stats.largest_gap !== null) {
    const g = stats.largest_gap;
    lines.push(
      `  largest gap ${g.ms} ms after ${g.after_id} (${g.from_offset_ms} to ${g.to_offset_ms} ms)`,
    );
  }
  const section = (title: string, rows: string[][], align: Align[]): void => {
    if (rows.length === 0) return;
    lines.push(title);
    lines.push(renderTable(rows, align).replace(/^/gm, '  '));
  };
  const tagRows = countRows(stats.by_tag);
  if (stats.untagged > 0) tagRows.push(['(untagged)', String(stats.untagged)]);
  section('by tag', tagRows, ['l', 'r']);
  section('by method', countRows(stats.by_method), ['l', 'r']);
  section('by status class', countRows(stats.by_status_class), ['l', 'r']);
  section(
    'body bytes as stored',
    [
      ['side', 'count', 'p50', 'p90', 'p99', 'max'],
      ...(['request', 'response'] as const).map((side) => {
        const s = stats.body_bytes[side];
        return [side, String(s.count), String(s.p50), String(s.p90), String(s.p99), String(s.max)];
      }),
    ],
    ['l', 'r', 'r', 'r', 'r', 'r'],
  );
  section(
    'substitution producers',
    stats.producers.length === 0
      ? []
      : [
          ['rule', 'tag', 'path', 'producers', 'distinct values'],
          ...stats.producers.map((p) => [
            p.name,
            p.tag,
            p.path,
            String(p.producers),
            String(p.distinct_values),
          ]),
        ],
    ['l', 'l', 'l', 'r', 'r'],
  );
  return `${lines.join('\n')}\n`;
}

export interface StatsCommandOptions {
  json: boolean;
  rules?: string;
}

export async function runStats(
  path: string,
  options: StatsCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const rules = options.rules === undefined ? undefined : await loadDiffRules(options.rules);
  const stats = await recordingStats(path, { rules: rules?.substitutions });
  out(
    streams,
    options.json ? JSON.stringify({ path, ...stats }, null, 2) : renderStats(path, stats),
  );
  return EXIT_CODES.pass;
}

export interface FilterCommandOptions {
  out: string;
  tag: string[];
  method: string[];
  path: string[];
  status: string[];
  from?: number;
  to?: number;
  includeDependencies: boolean;
  rules?: string;
}

export async function runFilter(
  inPath: string,
  options: FilterCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const criteria = {
    tags: options.tag,
    methods: options.method,
    paths: options.path,
    statuses: options.status,
    fromMs: options.from ?? null,
    toMs: options.to ?? null,
  };
  if (!options.includeDependencies) {
    const { read, kept } = await filterRecording(inPath, options.out, criteria);
    out(streams, `kept ${kept} of ${read} exchanges to ${options.out}`);
    return EXIT_CODES.pass;
  }
  if (options.rules === undefined) {
    throw new ConfigError('--include-dependencies needs --rules with the substitution rules');
  }
  const rules = await loadDiffRules(options.rules);
  // The producers of a value can sit anywhere before its use, so this path reads the whole file.
  const all = await readRecording(inPath);
  const index = new DependencyIndex(all, rules.substitutions);
  const { kept, dependencies } = filterExchanges(all, compileFilter(criteria), (i) =>
    index.dependenciesOf(i, (all[i] as (typeof all)[number]).request),
  );
  const written = await writeRebased(options.out, kept);
  out(
    streams,
    `kept ${written} of ${all.length} exchanges to ${options.out}, ${dependencies} of them pulled in as producers`,
  );
  return EXIT_CODES.pass;
}

export interface SampleCommandOptions {
  out: string;
  fraction: number;
  bySession?: string;
  seed?: number;
}

export async function runSample(
  inPath: string,
  options: SampleCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const seed = options.seed ?? randomInt(2 ** 31);
  const result = await sampleRecording(inPath, options.out, {
    fraction: options.fraction,
    seed,
    bySession: options.bySession,
  });
  const session =
    options.bySession === undefined
      ? ''
      : `, ${result.sessions} sessions by ${options.bySession}, ${result.keyless} without a key kept`;
  out(
    streams,
    `kept ${result.kept} of ${result.read} exchanges to ${options.out} (fraction ${options.fraction}, seed ${seed}${session})`,
  );
  return EXIT_CODES.pass;
}

export interface SplitCommandOptions {
  outDir: string;
  every?: number;
  everyMs?: number;
}

export async function runSplit(
  inPath: string,
  options: SplitCommandOptions,
  streams: CliStreams,
): Promise<number> {
  if ((options.every === undefined) === (options.everyMs === undefined)) {
    throw new ConfigError('split needs exactly one of --every and --every-ms');
  }
  const result = await splitRecording(inPath, options.outDir, {
    every: options.every,
    everyMs: options.everyMs,
  });
  for (const part of result.parts) {
    err(
      streams,
      `wrote ${part.path}: ${part.exchanges} exchanges, recorded offsets ${part.first_offset_ms} to ${part.last_offset_ms} ms`,
    );
  }
  out(
    streams,
    `split ${result.read} exchanges into ${result.parts.length} part${result.parts.length === 1 ? '' : 's'} in ${options.outDir}`,
  );
  return EXIT_CODES.pass;
}

export interface MergeCommandOptions {
  out: string;
}

export async function runMerge(
  inputs: string[],
  options: MergeCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const result = await mergeRecordings(inputs, options.out);
  const when = result.first_ts === null ? '' : `, ${result.first_ts} to ${result.last_ts}`;
  out(
    streams,
    `merged ${result.exchanges} exchanges from ${result.inputs} input${result.inputs === 1 ? '' : 's'} to ${options.out}${when}`,
  );
  return EXIT_CODES.pass;
}

export function renderScan(path: string, report: ScanReport): string {
  const lines = [`${path}: scanned ${report.exchanges} exchanges`];
  for (const r of report.redacted) lines.push(`  redacted: ${r.location} (${r.count})`);
  if (report.findings.length === 0) {
    lines.push('  no field looks like personal data');
  } else {
    lines.push(
      renderTable(
        [
          ['location', 'kind', 'count', 'example'],
          ...report.findings.map((f) => [f.location, f.kind, String(f.count), f.example]),
        ],
        ['l', 'l', 'r', 'l'],
      ).replace(/^/gm, '  '),
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface ScanCommandOptions {
  json: boolean;
}

export async function runScan(
  path: string,
  options: ScanCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const report = await scanRecording(path);
  out(
    streams,
    options.json ? JSON.stringify({ path, ...report }, null, 2) : renderScan(path, report),
  );
  return EXIT_CODES.pass;
}

export interface MigrateCommandOptions {
  out: string;
  target?: string;
  tagRule: string[];
  redactHeader: string[];
  redactQuery: string[];
  sample: number;
  sampleSeed?: number;
  sessionKey?: string;
  createdAt?: string;
}

export async function runMigrate(
  inPath: string,
  options: MigrateCommandOptions,
  streams: CliStreams,
  version: string,
): Promise<number> {
  for (const rule of options.tagRule) parseTagRule(rule);
  const manifest = buildManifest({
    tool_version: version,
    created_at: createdAtOf(options.createdAt),
    target: options.target ?? null,
    tag_rules: options.tagRule,
    headers: options.redactHeader.length === 0 ? DEFAULT_REDACTED_HEADERS : options.redactHeader,
    query: options.redactQuery.length === 0 ? DEFAULT_REDACTED_QUERY : options.redactQuery,
    fraction: options.sample,
    seed: options.sampleSeed ?? null,
    session_key: options.sessionKey ?? null,
  });
  const result = await migrateRecording(inPath, options.out, manifest);
  out(
    streams,
    `wrote ${options.out}: a manifest line and ${result.exchanges} exchanges copied byte for byte (${result.copied_bytes} bytes)`,
  );
  return EXIT_CODES.pass;
}

export interface AnonymizeCommandOptions {
  out: string;
  captureRules: string;
  redactHeader: string[];
  redactQuery: string[];
}

export async function runAnonymize(
  inPath: string,
  options: AnonymizeCommandOptions,
  streams: CliStreams,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const rules = await loadCaptureRules(options.captureRules);
  const redactor = new Redactor({
    headers: options.redactHeader,
    query: options.redactQuery,
    rules,
    key: env[REDACTION_KEY_ENV],
  });
  const result = await anonymizeRecording(inPath, options.out, redactor);
  out(
    streams,
    `anonymized ${result.exchanges} exchanges to ${options.out}${result.manifest ? ', manifest kept with the rules added' : ''}`,
  );
  return EXIT_CODES.pass;
}

/** Reads `--created-at`, an ISO 8601 date and time, as the manifest wants it. */
function createdAtOf(text: string | undefined): string {
  if (text === undefined) return new Date().toISOString();
  if (Number.isNaN(Date.parse(text)) || !text.includes('T')) {
    throw new ConfigError(`--created-at must be an ISO 8601 date and time, got ${text}`);
  }
  return new Date(text).toISOString();
}

export interface ImportHarCommandOptions {
  out: string;
  tagRule: string[];
  redactHeader: string[];
  redactQuery: string[];
  captureRules?: string;
  maxBodyBytes: number;
  createdAt?: string;
}

export async function runImportHar(
  harPath: string,
  options: ImportHarCommandOptions,
  streams: CliStreams,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const tagRules = options.tagRule.map(parseTagRule);
  const headers =
    options.redactHeader.length === 0 ? DEFAULT_REDACTED_HEADERS : options.redactHeader;
  const query = options.redactQuery.length === 0 ? DEFAULT_REDACTED_QUERY : options.redactQuery;
  const rules =
    options.captureRules === undefined ? undefined : await loadCaptureRules(options.captureRules);
  const redactor = new Redactor({ headers, query, rules, key: env[REDACTION_KEY_ENV] });
  const result = await importHarFile(harPath, options.out, {
    toolVersion: version,
    createdAt: createdAtOf(options.createdAt),
    tags: (method, path) => tagsFor(tagRules, method, path),
    tagRuleTexts: tagRules.map(formatTagRule),
    redactor,
    redactedHeaders: headers,
    redactedQuery: query,
    maxBodyBytes: options.maxBodyBytes,
  });
  for (const skip of result.skipped) {
    err(streams, `skipped entry ${skip.index}: ${skip.reason}`);
  }
  out(
    streams,
    `imported ${result.exchanges} exchanges from ${harPath} to ${options.out}${result.skipped.length > 0 ? `, ${result.skipped.length} entries skipped` : ''}`,
  );
  return EXIT_CODES.pass;
}

export function importCommand(
  streams: CliStreams,
  exit: (code: number) => void,
  version = '0.0.0',
  env: NodeJS.ProcessEnv = process.env,
): Command {
  const command = new Command('import').description(
    'Produce a recording from traffic exported by another tool.',
  );
  command.addCommand(
    configure(
      new Command('har')
        .description(
          'Read a HAR 1.2 file and write a recording with a manifest: one exchange per entry in order of startedDateTime, latency from time, bodies by the capture rules, and redaction applied. Entries without a response are skipped.',
        )
        .argument('<file>', 'the HAR file')
        .requiredOption('--out <path>', 'the recording to write; .gz writes gzip')
        .option(
          '--tag-rule <rule>',
          'tag rule "[METHOD ]<glob>=<tag>", first match wins, repeatable',
          collect,
          [],
        )
        .option(
          '--redact-header <name>',
          'header to redact, repeatable, replaces the default list',
          collect,
          [],
        )
        .option(
          '--redact-query <name>',
          'query parameter to redact, repeatable, replaces the default list',
          collect,
          [],
        )
        .option(
          '--capture-rules <path>',
          `YAML capture rules with the redact section; hash rules need ${REDACTION_KEY_ENV}`,
        )
        .addOption(
          new Option('--max-body-bytes <n>', 'bodies above this size are stored as a hash')
            .default(DEFAULT_MAX_BODY_BYTES)
            .argParser(nonNegativeInt),
        )
        .option('--created-at <iso>', 'the creation time for the manifest; default: now')
        .action(async (file: string, opts: ImportHarCommandOptions) => {
          exit(await runImportHar(file, opts, streams, version, env));
        }),
      streams,
    ),
  );
  return command;
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

export function recordingCommand(
  streams: CliStreams,
  exit: (code: number) => void,
  version = '0.0.0',
  env: NodeJS.ProcessEnv = process.env,
): Command {
  const recording = new Command('recording').description(
    'Validate, summarize, filter, sample, split, merge, scan, migrate, and anonymize a recording file. Every subcommand streams its input and never alters it.',
  );
  recording.addCommand(
    configure(
      new Command('validate')
        .description(
          'Parse every line, check that offsets never decrease and that no id repeats, and print the counts. Exits 1 with the line number of the first problem.',
        )
        .argument('<path>', 'the recording')
        .action(async (path: string) => {
          exit(await runValidate(path, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('stats')
        .description(
          'Exchanges by tag, method, and status class, body size percentiles, the span of offsets, the largest gap, and with --rules the substitution producers.',
        )
        .argument('<path>', 'the recording')
        .option('--json', 'print JSON instead of a table', false)
        .option('--rules <path>', 'diff rules whose substitution producers are counted')
        .action(async (path: string, opts: StatsCommandOptions) => {
          exit(await runStats(path, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('filter')
        .description(
          'Keep the matching exchanges in order, with offsets rebased so the first kept one is at 0 and the gaps are kept. Each flag may repeat and matches any of its values; different flags combine with and.',
        )
        .argument('<in>', 'the recording to read')
        .requiredOption('--out <path>', 'the recording to write')
        .option('--tag <tag>', 'keep exchanges carrying this tag, repeatable', collect, [])
        .option('--method <method>', 'keep exchanges with this method, repeatable', collect, [])
        .option(
          '--path <glob>',
          'keep exchanges whose path matches this glob, repeatable',
          collect,
          [],
        )
        .option(
          '--status <status>',
          'keep exchanges with this status, as a class such as 2xx or a code such as 404, repeatable',
          collect,
          [],
        )
        .addOption(
          new Option(
            '--from <offset_ms>',
            'keep exchanges at or after this recorded offset',
          ).argParser(nonNegativeInt),
        )
        .addOption(
          new Option(
            '--to <offset_ms>',
            'keep exchanges at or before this recorded offset',
          ).argParser(nonNegativeInt),
        )
        .option(
          '--include-dependencies',
          'also keep the exchanges that produce the substituted values the kept ones use, transitively; needs --rules and reads the whole file into memory',
          false,
        )
        .option('--rules <path>', 'diff rules with the substitution rules')
        .action(async (inPath: string, opts: FilterCommandOptions) => {
          exit(await runFilter(inPath, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('sample')
        .description(
          'Keep a random fraction of the exchanges, or whole sessions with --by-session. The same seed gives the same output. Offsets are rebased like filter.',
        )
        .argument('<in>', 'the recording to read')
        .requiredOption('--out <path>', 'the recording to write')
        .addOption(
          new Option('--fraction <f>', 'fraction to keep, above 0 and at most 1')
            .makeOptionMandatory()
            .argParser(fraction),
        )
        .option(
          '--by-session <selector>',
          'a request header name, or a request body JSONPath starting with $; exchanges sharing the value are kept or dropped together, and exchanges without one are kept',
        )
        .addOption(
          new Option(
            '--seed <n>',
            'seed for a repeatable sample; default: random, printed',
          ).argParser(nonNegativeInt),
        )
        .action(async (inPath: string, opts: SampleCommandOptions) => {
          exit(await runSample(inPath, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('split')
        .description(
          'Write consecutive parts of the recording into a directory, each rebased to start at 0, by a count of exchanges or by a window of recorded time.',
        )
        .argument('<in>', 'the recording to read')
        .requiredOption('--out-dir <dir>', 'directory for the parts, created when missing')
        .addOption(new Option('--every <n>', 'exchanges per part').argParser(positiveInt))
        .addOption(
          new Option('--every-ms <n>', 'milliseconds of recorded time per part').argParser(
            positiveNumber,
          ),
        )
        .action(async (inPath: string, opts: SplitCommandOptions) => {
          exit(await runSplit(inPath, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('merge')
        .description(
          'Merge recordings by ts into one file with offset_ms recomputed from the first exchange. Refuses inputs whose ids collide.',
        )
        .argument('<in...>', 'the recordings to merge')
        .requiredOption('--out <path>', 'the recording to write')
        .action(async (inputs: string[], opts: MergeCommandOptions) => {
          exit(await runMerge(inputs, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('scan')
        .description(
          'Report fields that look like personal data by pattern and header or query values that look like tokens by entropy, with counts and one masked example each. Always exits 0.',
        )
        .argument('<path>', 'the recording')
        .option('--json', 'print JSON instead of a table', false)
        .action(async (path: string, opts: ScanCommandOptions) => {
          exit(await runScan(path, opts, streams));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('migrate')
        .description(
          'Write a copy of a recording that starts with a manifest line built from the flags, followed by every byte of the input unchanged. Refuses an input that already has a manifest.',
        )
        .argument('<in>', 'the recording to read')
        .requiredOption('--out <path>', 'the recording to write')
        .option('--target <url>', 'the reference system the recording was captured against')
        .option('--tag-rule <rule>', 'a tag rule the capture used, repeatable', collect, [])
        .option(
          '--redact-header <name>',
          'a header the capture redacted, repeatable; default: the capture default list',
          collect,
          [],
        )
        .option(
          '--redact-query <name>',
          'a query parameter the capture redacted, repeatable; default: the capture default list',
          collect,
          [],
        )
        .addOption(
          new Option('--sample <fraction>', 'the fraction the capture recorded')
            .default(1)
            .argParser(fraction),
        )
        .addOption(
          new Option('--sample-seed <n>', 'the seed of a session sample').argParser(nonNegativeInt),
        )
        .option('--session-key <selector>', 'the --sample-by selector the capture used')
        .option('--created-at <iso>', 'the creation time to record; default: now')
        .action(async (inPath: string, opts: MigrateCommandOptions) => {
          exit(await runMigrate(inPath, opts, streams, version));
        }),
      streams,
    ),
  );
  recording.addCommand(
    configure(
      new Command('anonymize')
        .description(
          `Apply the redaction of a capture rules file to every exchange and write the result, keeping ids, order, and offsets. Hash rules need ${REDACTION_KEY_ENV}.`,
        )
        .argument('<in>', 'the recording to read')
        .requiredOption('--out <path>', 'the recording to write')
        .requiredOption('--capture-rules <path>', 'YAML capture rules with the redact section')
        .option(
          '--redact-header <name>',
          'also drop this header, repeatable; default: only the rules file',
          collect,
          [],
        )
        .option(
          '--redact-query <name>',
          'also drop this query parameter, repeatable; default: only the rules file',
          collect,
          [],
        )
        .action(async (inPath: string, opts: AnonymizeCommandOptions) => {
          exit(await runAnonymize(inPath, opts, streams, env));
        }),
      streams,
    ),
  );
  return recording;
}
