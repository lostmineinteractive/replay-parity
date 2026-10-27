import { writeFile } from 'node:fs/promises';
import { ConfigError, exitCodeFor, explainDiff, readRun, type Run } from '@replay-parity/core';
import {
  renderHtml,
  renderJson,
  renderJunit,
  renderMarkdown,
  renderTerminal,
} from '@replay-parity/report';
import { Command, Option } from 'commander';
import { out, err, type CliStreams } from '../io.js';

export type ReportFormat = 'html' | 'json' | 'terminal' | 'junit' | 'markdown';

export interface ReportCommandOptions {
  run: string;
  out?: string;
  format?: ReportFormat;
  explain?: string | boolean;
  /** Exit with the run's own code after a successful render instead of 0. */
  failOnVerdict?: boolean;
}

const RENDERERS: Record<ReportFormat, (run: Run) => string> = {
  html: renderHtml,
  json: renderJson,
  terminal: renderTerminal,
  junit: renderJunit,
  markdown: renderMarkdown,
};

/** Plain language explanation of one exchange, or of every mismatched exchange. */
export function explainRun(run: Run, id: string | undefined): string {
  const targets =
    id === undefined
      ? run.exchanges.filter((e) => !e.control && e.diff?.verdict === 'mismatch')
      : run.exchanges.filter((e) => e.id === id);
  if (id !== undefined && targets.length === 0) {
    throw new ConfigError(`exchange ${id} is not in the run`);
  }
  if (targets.length === 0) return 'No mismatched exchanges.\n';
  const blocks = targets.map((e) => {
    const head = `${e.id} ${e.method} ${e.path} [${e.tags.join(', ')}]${e.control ? ' (harness control)' : ''}`;
    if (e.error !== null) return `${head}\n  The candidate did not answer: ${e.error}.`;
    if (e.diff === null) return `${head}\n  Not compared.`;
    return [head, ...explainDiff(e.diff).map((l) => `  ${l}`)].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

export async function runReport(
  options: ReportCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const run = await readRun(options.run);
  const code = options.failOnVerdict === true ? exitCodeFor(run.verdict) : 0;
  if (options.explain !== undefined) {
    out(
      streams,
      explainRun(run, typeof options.explain === 'string' ? options.explain : undefined),
    );
    return code;
  }
  const format = options.format ?? (options.out === undefined ? 'terminal' : 'html');
  const text = RENDERERS[format](run);
  if (options.out === undefined) {
    streams.stdout.write(text);
  } else {
    await writeFile(options.out, text, 'utf8');
    err(streams, `wrote ${options.out} (${format}): ${run.verdict.toUpperCase()}`);
  }
  return code;
}

export function reportCommand(streams: CliStreams, exit: (code: number) => void): Command {
  return new Command('report')
    .description(
      'Render a run as HTML, JSON, JUnit XML, Markdown, or a terminal summary, or explain why exchanges mismatched. Exits 0 after a successful render regardless of the verdict unless --fail-on-verdict is given.',
    )
    .requiredOption('--run <path>', 'run file written by rp replay')
    .option('--out <path>', 'file to write; without it the report goes to stdout')
    .addOption(
      new Option(
        '--format <name>',
        'output format; html when --out is given, terminal otherwise',
      ).choices(['html', 'json', 'terminal', 'junit', 'markdown']),
    )
    .option(
      '--explain [exchange-id]',
      'explain one exchange in plain language, or every mismatched exchange',
    )
    .option(
      '--fail-on-verdict',
      'exit with the run verdict code after writing the output: 0 pass, 2 fail, 3 inconclusive',
    )
    .action(async (opts: ReportCommandOptions) => {
      exit(await runReport(opts, streams));
    });
}
