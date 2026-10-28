import { ConfigError, EXIT_CODES } from '@replay-parity/core';
import { Command } from 'commander';
import {
  CONFIG_ENV,
  DEFAULT_CONFIG_FILE,
  PROFILE_ENV,
  deferredConfigError,
  displayText,
  loadConfig,
  type CliContext,
  type EffectiveValue,
  type LoadedConfig,
} from '../config/index.js';
import { out, type CliStreams } from '../io.js';
import { formatCheck, probeHealth, probeReset } from '../preflight.js';

export interface DoctorCommandOptions {
  target?: string;
  reference?: string;
  reset?: string;
  config?: string;
  profile?: string;
}

export interface DoctorContext extends CliContext {
  version: string;
  commands: readonly Command[];
  command?: Command | undefined;
}

/** A configured value as it appears in the file, never resolved. */
export function formatConfigValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(', ')}]`;
  return String(value);
}

function describeSource(entry: EffectiveValue, profile: string | null): string {
  if (entry.source === 'file') return 'file';
  if (entry.source === 'profile') return `profile ${profile ?? ''}`;
  return entry.origin;
}

function configLines(loaded: LoadedConfig, cwd: string): string[] {
  const lines: string[] = [];
  if (loaded.path === null) {
    lines.push(
      `config: none (no --config, ${CONFIG_ENV} not set, no ${DEFAULT_CONFIG_FILE} in ${cwd})`,
    );
  } else {
    const from = { flag: '--config', env: CONFIG_ENV, cwd: `./${DEFAULT_CONFIG_FILE}` }[
      loaded.pathFrom ?? 'cwd'
    ];
    lines.push(`config: ${loaded.path} (from ${from})`);
  }
  if (loaded.profile === null) {
    lines.push('profile: none');
  } else {
    lines.push(
      `profile: ${loaded.profile} (from ${loaded.profileFrom === 'flag' ? '--profile' : PROFILE_ENV})`,
    );
  }
  let any = false;
  for (const [command, values] of loaded.effective) {
    if (values.size === 0) continue;
    any = true;
    lines.push(`${command}:`);
    for (const [key, entry] of values) {
      lines.push(
        `  ${key}: ${formatConfigValue(entry.value)}  (${describeSource(entry, loaded.profile)})`,
      );
    }
  }
  if (!any) lines.push('effective values: none');
  lines.push(
    loaded.envApplied.length === 0
      ? 'environment: no RP_ variable applied'
      : `environment: ${loaded.envApplied.join(', ')}`,
  );
  if (loaded.envUnrecognized.length > 0) {
    lines.push(`environment not matching any flag: ${loaded.envUnrecognized.join(', ')}`);
  }
  return lines;
}

/**
 * Prints the versions, the platform, the config file and profile in effect
 * with the effective values per command, the environment variables that
 * applied, and the probe results for the URLs given. Secrets stay as `${NAME}`.
 * Exits 0, or 1 when the config file could not be read.
 */
export async function runDoctor(
  options: DoctorCommandOptions,
  streams: CliStreams,
  context: DoctorContext,
): Promise<number> {
  const lines: string[] = [
    `rp ${context.version}`,
    `node ${process.version}`,
    `platform ${process.platform} ${process.arch}`,
  ];
  let code: number = EXIT_CODES.pass;
  try {
    const loaded = await loadConfig(
      context.commands,
      { configFlag: options.config, profileFlag: options.profile },
      context.env,
      context.cwd,
    );
    lines.push(...configLines(loaded, context.cwd));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    lines.push(`error config: ${e.message}`);
    code = EXIT_CODES.error;
  }
  // A variable the doctor section itself needs may be missing. That is reported, not fatal.
  const held = context.command === undefined ? undefined : deferredConfigError(context.command);
  if (held !== undefined && code === EXIT_CODES.pass) lines.push(`error config: ${held.message}`);
  const label = (attribute: string, value: string): string =>
    context.command === undefined ? value : displayText(context.command, attribute, value);
  if (options.target !== undefined) {
    lines.push(
      formatCheck(
        await probeHealth('target', {
          url: options.target,
          label: label('target', options.target),
        }),
      ),
    );
  }
  if (options.reference !== undefined) {
    lines.push(
      formatCheck(
        await probeHealth('reference', {
          url: options.reference,
          label: label('reference', options.reference),
        }),
      ),
    );
  }
  if (options.reset !== undefined) {
    lines.push(
      formatCheck(await probeReset({ url: options.reset, label: label('reset', options.reset) })),
    );
  }
  out(streams, `${lines.join('\n')}\n`);
  return code;
}

export function doctorCommand(
  streams: CliStreams,
  exit: (code: number) => void,
  context: CliContext & { version: string },
): Command {
  return new Command('doctor')
    .description(
      'Print the versions, the platform, the config file and profile in effect with the values per command, the environment variables that applied, and the result of probing the URLs given. Exits 0.',
    )
    .option('--target <url>', 'candidate URL to probe with a GET')
    .option('--reference <url>', 'reference URL to probe with a GET')
    .option('--reset <url>', 'reset URL to probe with a POST')
    .action(async (opts: DoctorCommandOptions, command: Command) => {
      exit(
        await runDoctor(opts, streams, {
          ...context,
          commands: command.parent?.commands ?? [],
          command,
        }),
      );
    });
}
