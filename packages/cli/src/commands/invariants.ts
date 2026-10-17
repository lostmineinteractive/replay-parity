import { writeFile } from 'node:fs/promises';
import { EXIT_CODES, readRecording, type InvariantReport } from '@replay-parity/core';
import { evaluateInvariants } from '@replay-parity/invariants';
import { invariantSummary } from '@replay-parity/report';
import { Command } from 'commander';
import { err, out, type CliStreams } from '../io.js';

export interface InvariantsCommandOptions {
  recording: string;
  out?: string;
  system: string;
}

export function renderInvariantReport(report: InvariantReport): string {
  const lines = [
    `invariants for ${report.system} (${report.recording}): ${invariantSummary(report)}`,
  ];
  lines.push(
    `  ${report.exchanges} exchanges, ${report.commands} commands, ${report.snapshots.ledger_reads} ledger reads, ${report.snapshots.stock_reads} stock reads, ${report.snapshots.order_reads} order reads`,
  );
  for (const r of report.results) {
    lines.push(
      `  ${String(r.id).padStart(2)}. ${r.status.padEnd(14)} ${r.name} (${r.checks} checks)${r.detail === undefined ? '' : `: ${r.detail}`}`,
    );
    for (const e of r.evidence.slice(0, 5)) {
      lines.push(
        `      ${e.subject}: expected ${JSON.stringify(e.expected)}, observed ${JSON.stringify(e.observed)}. ${e.detail}${e.exchange_id === null ? '' : ` (exchange ${e.exchange_id})`}`,
      );
    }
  }
  for (const c of report.inconclusive) lines.push(`  ${c.kind}: ${c.detail}`);
  return `${lines.join('\n')}\n`;
}

export function invariantsExitCode(report: InvariantReport): number {
  if (report.inconclusive.length > 0) return EXIT_CODES.inconclusive;
  if (report.violations > 0) return EXIT_CODES.fail;
  if (report.results.some((r) => r.status === 'inconclusive')) return EXIT_CODES.inconclusive;
  return EXIT_CODES.pass;
}

export async function runInvariants(
  options: InvariantsCommandOptions,
  streams: CliStreams,
): Promise<number> {
  const exchanges = await readRecording(options.recording);
  const report = evaluateInvariants(exchanges, {
    system: options.system,
    recording: options.recording,
  });
  out(streams, renderInvariantReport(report));
  if (options.out !== undefined) {
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    err(streams, `wrote ${options.out}`);
  }
  return invariantsExitCode(report);
}

export function invariantsCommand(streams: CliStreams, exit: (code: number) => void): Command {
  return new Command('invariants')
    .description(
      'Evaluate the ten independent invariants against one recording. Exits 0 when every invariant holds, 2 on a violation, 3 when a rule could not decide.',
    )
    .requiredOption('--recording <path>', 'the recording of one system')
    .option('--out <path>', 'write the report as JSON here')
    .option('--system <label>', 'label for the report', 'system')
    .action(async (opts: InvariantsCommandOptions) => {
      exit(await runInvariants(opts, streams));
    });
}
