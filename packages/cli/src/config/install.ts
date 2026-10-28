import { ConfigError } from '@replay-parity/core';
import type { Command } from 'commander';
import { applyEffective, interpolateCommandLine, wrapListParsers } from './apply.js';
import { CONFIG_ENV, PROFILE_ENV, loadConfig, scanConfigFlags } from './load.js';

/** What the configuration reads besides the command line. Tests pass their own. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** A config error held back for a command that reports it as a check line instead of failing at once. */
const deferred = new WeakMap<Command, ConfigError>();

export function deferredConfigError(command: Command): ConfigError | undefined {
  return deferred.get(command);
}

/**
 * Gives every subcommand `--config` and `--profile`, applies the file, the
 * profile, and the environment as defaults before the subcommand parses its
 * flags, and resolves `${NAME}` in the secret bearing flags after it has.
 * Commands named in `deferFor` get a config error handed to them instead of
 * a failed start, so they can report it among their checks.
 */
export function installConfig(
  program: Command,
  context: CliContext,
  deferFor: ReadonlySet<string> = new Set(['validate', 'doctor']),
): void {
  for (const sub of program.commands) {
    sub.option(
      '--config <path>',
      `rp.yaml with a section per command and profiles; default ${CONFIG_ENV}, then ./rp.yaml when it exists`,
    );
    sub.option(
      '--profile <name>',
      `profile of the config file applied over its top level; default ${PROFILE_ENV}`,
    );
    wrapListParsers(sub);
  }
  program.hook('preSubcommand', async (_program, sub) => {
    const args = program.args;
    if (args.includes('--help') || args.includes('-h')) return;
    try {
      const loaded = await loadConfig(
        program.commands,
        scanConfigFlags(args),
        context.env,
        context.cwd,
      );
      applyEffective(sub, loaded.effective.get(sub.name()) ?? new Map(), context.env);
    } catch (e) {
      if (e instanceof ConfigError && deferFor.has(sub.name())) {
        deferred.set(sub, e);
        return;
      }
      throw e;
    }
  });
  program.hook('preAction', (_program, sub) => {
    interpolateCommandLine(sub, context.env);
  });
}
