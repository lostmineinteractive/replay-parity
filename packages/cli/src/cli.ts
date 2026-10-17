import { ConfigError, EXIT_CODES, RecordingParseError } from '@replay-parity/core';
import { TagRuleError } from '@replay-parity/capture';
import { CommanderError, Command, InvalidArgumentError } from 'commander';
import { captureCommand } from './commands/capture.js';
import { invariantsCommand } from './commands/invariants.js';
import { replayCommand } from './commands/replay.js';
import { reportCommand } from './commands/report.js';
import { shrinkCommand } from './commands/shrink.js';
import { err, type CliStreams } from './io.js';

export const CLI_VERSION = '0.1.0';

export interface RunCliOptions extends Partial<CliStreams> {
  /** Aborted to stop long running commands such as capture. */
  signal?: AbortSignal | undefined;
}

/** Commands other build steps register, such as the agent. */
export type CommandFactory = (streams: CliStreams, exit: (code: number) => void) => Command;

const extraCommands: CommandFactory[] = [];

export function registerCommand(factory: CommandFactory): void {
  extraCommands.push(factory);
}

export function buildProgram(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
): Command {
  const program = new Command('rp')
    .description(
      'Capture traffic against a reference system, replay it against a candidate, diff the responses, gate on latency and correctness, and report.',
    )
    .version(CLI_VERSION, '--version', 'print the version')
    .helpOption('-h, --help', 'print help')
    .configureOutput({
      writeOut: (text) => {
        streams.stdout.write(text);
      },
      writeErr: (text) => {
        streams.stderr.write(text);
      },
    })
    .exitOverride();
  program.addCommand(captureCommand(streams, signal, exit));
  program.addCommand(replayCommand(streams, exit));
  program.addCommand(reportCommand(streams, exit));
  program.addCommand(invariantsCommand(streams, exit));
  program.addCommand(shrinkCommand(streams, exit));
  for (const factory of extraCommands) program.addCommand(factory(streams, exit));
  for (const sub of program.commands) {
    sub.configureOutput({
      writeOut: (text) => {
        streams.stdout.write(text);
      },
      writeErr: (text) => {
        streams.stderr.write(text);
      },
    });
    sub.exitOverride();
    sub.showHelpAfterError('(run with --help for the list of flags)');
  }
  return program;
}

function isToolError(e: unknown): e is Error {
  return (
    e instanceof ConfigError ||
    e instanceof RecordingParseError ||
    e instanceof TagRuleError ||
    e instanceof InvalidArgumentError ||
    (e instanceof Error && e.name === 'HeaderParseError')
  );
}

/**
 * Runs `rp` with the given arguments and returns the exit code: 0 pass,
 * 2 fail, 3 inconclusive, 1 tool error. Usage errors and missing files are
 * tool errors and go to stderr with a message.
 */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const streams: CliStreams = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const signal = options.signal ?? new AbortController().signal;
  let code: number | null = null;
  const program = buildProgram(streams, signal, (c) => {
    code = c;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      // Help and version are not errors. Everything else is a usage error.
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
      return EXIT_CODES.error;
    }
    if (isToolError(e)) {
      err(streams, `rp: ${e.message}`);
      return EXIT_CODES.error;
    }
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    err(streams, `rp: unexpected error: ${message}`);
    return EXIT_CODES.error;
  }
  return code ?? 0;
}
