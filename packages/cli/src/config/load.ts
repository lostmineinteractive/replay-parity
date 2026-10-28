import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadYamlFile } from '@replay-parity/core';
import type { Command } from 'commander';
import {
  configFileSchema,
  configurableOptions,
  toConfigFile,
  type ConfigFile,
  type OptionKind,
} from './schema.js';

/**
 * Locating `rp.yaml` and merging its layers. Precedence, lowest to highest:
 * the file's top level, the selected profile, `RP_<COMMAND>_<FLAG>`
 * environment variables, and then the flags on the command line, which
 * commander applies after this module has set the rest as defaults.
 */

export const CONFIG_ENV = 'RP_CONFIG';
export const PROFILE_ENV = 'RP_PROFILE';
export const DEFAULT_CONFIG_FILE = 'rp.yaml';

export type LayerSource = 'file' | 'profile' | 'env';

export interface EffectiveValue {
  /** The raw value: a YAML scalar or list, or the variable's text. Never interpolated. */
  value: unknown;
  source: LayerSource;
  /** Where it came from, for messages: `rp.yaml: replay.target` or `RP_REPLAY_TARGET`. */
  origin: string;
}

/** Command name to flag key to the value that wins before the command line. */
export type EffectiveConfig = Map<string, Map<string, EffectiveValue>>;

export interface ConfigSelection {
  /** The `--config` flag when given. */
  configFlag?: string | undefined;
  /** The `--profile` flag when given. */
  profileFlag?: string | undefined;
}

export interface ConfigLocation {
  path: string;
  from: 'flag' | 'env' | 'cwd';
}

export interface LoadedConfig {
  /** The file read, or null when none was selected and none exists in the working directory. */
  path: string | null;
  pathFrom: ConfigLocation['from'] | null;
  file: ConfigFile | null;
  profile: string | null;
  profileFrom: 'flag' | 'env' | null;
  effective: EffectiveConfig;
  /** The `RP_` variables that set a flag, in the order they were applied. */
  envApplied: string[];
  /** The `RP_` variables that match no flag of any command and are not RP_CONFIG or RP_PROFILE. */
  envUnrecognized: string[];
}

/** `RP_REPLAY_MAX_GAP_MS` for the `replay` command's `max-gap-ms` flag. */
export function envVariableName(command: string, key: string): string {
  return `RP_${command}_${key}`.toUpperCase().replace(/-/g, '_');
}

/**
 * Finds `--config` and `--profile` in raw arguments before commander parses
 * them, so the file can be applied as defaults first. Both `--flag value` and
 * `--flag=value` are read. The last occurrence wins, as on the command line.
 */
export function scanConfigFlags(args: readonly string[]): ConfigSelection {
  const out: ConfigSelection = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    for (const name of ['config', 'profile'] as const) {
      const flag = `--${name}`;
      let value: string | undefined;
      if (arg === flag) value = args[i + 1];
      else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      if (value !== undefined && !(arg === flag && value.startsWith('-'))) {
        if (name === 'config') out.configFlag = value;
        else out.profileFlag = value;
      }
    }
  }
  return out;
}

/** The file to read: `--config`, else `RP_CONFIG`, else `./rp.yaml` when it exists, else null. */
export function locateConfigFile(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ConfigLocation | null {
  if (flag !== undefined) return { path: resolve(cwd, flag), from: 'flag' };
  const fromEnv = env[CONFIG_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0)
    return { path: resolve(cwd, fromEnv), from: 'env' };
  const local = resolve(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(local)) return { path: local, from: 'cwd' };
  return null;
}

/** Converts an environment variable's text to the shape the file would hold for the flag's kind. */
export function envValue(text: string, kind: OptionKind, name: string): unknown {
  switch (kind) {
    case 'boolean':
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw new ConfigError(`${name}: expected true or false, got ${JSON.stringify(text)}`);
    case 'list':
      return text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    case 'optional-value':
      return text === 'true' ? true : text;
    case 'value':
      return text;
  }
}

/** Reads and validates the file. Unknown commands, unknown keys, and wrong types name the key. */
export async function readConfigFile(
  path: string,
  commands: readonly Command[],
): Promise<ConfigFile> {
  const raw = await loadYamlFile(path, configFileSchema(commands));
  return toConfigFile(raw);
}

/** Locates the file, selects the profile, reads the environment, and merges the three layers. */
export async function loadConfig(
  commands: readonly Command[],
  selection: ConfigSelection,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<LoadedConfig> {
  const location = locateConfigFile(selection.configFlag, env, cwd);
  let file: ConfigFile | null = null;
  if (location !== null) {
    if (!existsSync(location.path)) {
      const from = location.from === 'flag' ? '--config' : CONFIG_ENV;
      throw new ConfigError(`${location.path}: config file not found (from ${from})`);
    }
    file = await readConfigFile(location.path, commands);
  }

  let profile: string | null = null;
  let profileFrom: LoadedConfig['profileFrom'] = null;
  const profileEnv = env[PROFILE_ENV];
  if (selection.profileFlag !== undefined) {
    profile = selection.profileFlag;
    profileFrom = 'flag';
  } else if (profileEnv !== undefined && profileEnv.length > 0) {
    profile = profileEnv;
    profileFrom = 'env';
  }
  let profileSections: Record<string, Record<string, unknown>> = {};
  if (profile !== null) {
    if (file === null || location === null) {
      throw new ConfigError(
        `profile ${JSON.stringify(profile)} was selected but no config file was found (looked for --config, ${CONFIG_ENV}, and ./${DEFAULT_CONFIG_FILE})`,
      );
    }
    const found = file.profiles[profile];
    if (found === undefined) {
      const defined = Object.keys(file.profiles);
      throw new ConfigError(
        `${location.path}: profile ${JSON.stringify(profile)} is not defined${defined.length === 0 ? ' (the file has no profiles)' : ` (defined: ${defined.join(', ')})`}`,
      );
    }
    profileSections = found;
  }

  const effective: EffectiveConfig = new Map();
  const envApplied: string[] = [];
  const recognized = new Set<string>([CONFIG_ENV, PROFILE_ENV]);
  for (const command of commands) {
    const name = command.name();
    const values = new Map<string, EffectiveValue>();
    const path = location?.path ?? '';
    for (const [key, value] of Object.entries(file?.commands[name] ?? {})) {
      values.set(key, { value, source: 'file', origin: `${path}: ${name}.${key}` });
    }
    for (const [key, value] of Object.entries(profileSections[name] ?? {})) {
      values.set(key, {
        value,
        source: 'profile',
        origin: `${path}: profiles.${profile as string}.${name}.${key}`,
      });
    }
    for (const spec of configurableOptions(command)) {
      const variable = envVariableName(name, spec.key);
      recognized.add(variable);
      const text = env[variable];
      if (text === undefined) continue;
      values.set(spec.key, {
        value: envValue(text, spec.kind, variable),
        source: 'env',
        origin: variable,
      });
      envApplied.push(variable);
    }
    effective.set(name, values);
  }
  const envUnrecognized = Object.keys(env)
    .filter((key) => key.startsWith('RP_') && !recognized.has(key))
    .sort();

  return {
    path: location?.path ?? null,
    pathFrom: location?.from ?? null,
    file,
    profile,
    profileFrom,
    effective,
    envApplied,
    envUnrecognized,
  };
}
