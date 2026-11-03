import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  EXIT_CODES,
  LOG_FORMATS,
  LOG_LEVELS,
  RecordingParseError,
} from '@replay-parity/core';
import { TagRuleError } from '@replay-parity/capture';
import { CommanderError, Command, InvalidArgumentError, Option } from 'commander';
import { agentCommand } from './commands/agent.js';
import { captureCommand } from './commands/capture.js';
import { compareCommand } from './commands/compare.js';
import { doctorCommand } from './commands/doctor.js';
import { invariantsCommand } from './commands/invariants.js';
import { recordingCommand } from './commands/recording.js';
import { replayCommand } from './commands/replay.js';
import { rulesCommand } from './commands/rules.js';
import { reportCommand } from './commands/report.js';
import { shrinkCommand } from './commands/shrink.js';
import { validateCommand } from './commands/validate.js';
import { installConfig, type CliContext } from './config/index.js';
import {
  LOG_FORMAT_ENV,
  LOG_LEVEL_ENV,
  cliLogger,
  logger,
  scanLogFlags,
  type CliStreams,
} from './io.js';

/** The version in this package's package.json. From src/ the file is one directory up, from dist/src/ two up. */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../package.json'), resolve(here, '../../package.json')]) {
    if (!existsSync(candidate)) continue;
    const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg.name === '@replay-parity/cli' && typeof pkg.version === 'string') return pkg.version;
  }
  return '0.0.0';
}

export const CLI_VERSION = readPackageVersion();

export interface RunCliOptions extends Partial<CliStreams> {
  /** Aborted to stop the running command. Every command stops cleanly and writes what it has. */
  signal?: AbortSignal | undefined;
  /** The environment the configuration reads. Default: the process environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Where `./rp.yaml` and relative `--config` paths are looked for. Default: the working directory. */
  cwd?: string | undefined;
}

export function buildProgram(
  streams: CliStreams,
  signal: AbortSignal,
  exit: (code: number) => void,
  context: CliContext = { env: process.env, cwd: process.cwd() },
): Command {
  const program = new Command('rp')
    .description(
      'Capture traffic against a reference system, replay it against a candidate, diff the responses, gate on latency and correctness, and report.',
    )
    .version(CLI_VERSION, '--version', 'print the version')
    .helpOption('-h, --help', 'print help')
    .addOption(
      new Option(
        '--log-level <level>',
        `least level written to stderr; default ${LOG_LEVEL_ENV}, then info`,
      ).choices([...LOG_LEVELS]),
    )
    .addOption(
      new Option(
        '--log-format <format>',
        `text, or json with one object per line; default ${LOG_FORMAT_ENV}, then text`,
      ).choices([...LOG_FORMATS]),
    )
    .configureOutput({
      writeOut: (text) => {
        streams.stdout.write(text);
      },
      writeErr: (text) => {
        logger(streams).error(text);
      },
    })
    .exitOverride();
  program.addCommand(captureCommand(streams, signal, exit, CLI_VERSION, context.env));
  program.addCommand(replayCommand(streams, signal, exit, context));
  program.addCommand(reportCommand(streams, exit));
  program.addCommand(compareCommand(streams, exit));
  program.addCommand(invariantsCommand(streams, exit));
  program.addCommand(shrinkCommand(streams, signal, exit, context));
  program.addCommand(agentCommand(streams, signal, exit));
  program.addCommand(recordingCommand(streams, exit, CLI_VERSION, context.env));
  program.addCommand(validateCommand(streams, exit, context));
  program.addCommand(rulesCommand(streams, exit));
  program.addCommand(doctorCommand(streams, exit, { ...context, version: CLI_VERSION }));
  // Registered before the configuration hook, so a configuration error carries the command too.
  program.hook('preSubcommand', (_program, sub) => {
    streams.log = logger(streams).child({ command: sub.name() });
  });
  installConfig(program, context);
  for (const sub of program.commands) {
    sub.configureOutput({
      writeOut: (text) => {
        streams.stdout.write(text);
      },
      writeErr: (text) => {
        logger(streams).error(text);
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
  const context: CliContext = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  };
  try {
    streams.log = cliLogger(streams, scanLogFlags(argv, context.env));
  } catch (e) {
    logger(streams).error(`rp: ${(e as Error).message}`);
    return EXIT_CODES.error;
  }
  let code: number | null = null;
  const program = buildProgram(
    streams,
    signal,
    (c) => {
      code = c;
    },
    context,
  );
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      // Help and version are not errors. Everything else is a usage error.
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
      return EXIT_CODES.error;
    }
    if (isToolError(e)) {
      logger(streams).error(`rp: ${e.message}`);
      return EXIT_CODES.error;
    }
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    logger(streams).error(`rp: unexpected error: ${message}`);
    return EXIT_CODES.error;
  }
  return code ?? 0;
}
