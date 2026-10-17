import { writeFile } from 'node:fs/promises';
import { ConfigError, explainDiff, readRun, type Run } from '@replay-parity/core';
import { renderHtml, renderJson, renderTerminal } from '@replay-parity/report';
import { Command, Option } from 'commander';
import { out, err, type CliStreams } from '../io.js';

export interface ReportCommandOptions {
  run: string;
  out?: string;
  format?: 'html' | 'json' | 'terminal';
  explain?: string | boolean;
}

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
  if (options.explain !== undefined) {
    out(
      streams,
      explainRun(run, typeof options.explain === 'string' ? options.explain : undefined),
    );
    return 0;
  }
  const format = options.format ?? (options.out === undefined ? 'terminal' : 'html');
  const text =
    format === 'html' ? renderHtml(run) : format === 'json' ? renderJson(run) : renderTerminal(run);
  if (options.out === undefined) {
    streams.stdout.write(text);
  } else {
    await writeFile(options.out, text, 'utf8');
    err(streams, `wrote ${options.out} (${format}): ${run.verdict.toUpperCase()}`);
  }
  return 0;
}

export function reportCommand(streams: CliStreams, exit: (code: number) => void): Command {
  return new Command('report')
    .description(
      'Render a run as HTML, JSON, or a terminal summary, or explain why exchanges mismatched. Exits 0 after a successful render regardless of the verdict.',
    )
    .requiredOption('--run <path>', 'run file written by rp replay')
    .option('--out <path>', 'file to write; without it the report goes to stdout')
    .addOption(
      new Option(
        '--format <name>',
        'output format; html when --out is given, terminal otherwise',
      ).choices(['html', 'json', 'terminal']),
    )
    .option(
      '--explain [exchange-id]',
      'explain one exchange in plain language, or every mismatched exchange',
    )
    .action(async (opts: ReportCommandOptions) => {
      exit(await runReport(opts, streams));
    });
}
