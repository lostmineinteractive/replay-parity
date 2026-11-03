import { ConfigError } from '@replay-parity/core';
import { loadAdapterModule, type Adapter } from '@replay-parity/replay';
import type { Command } from 'commander';
import { collect } from './options.js';

/** The flags that replace the transport with a plugin module. */
export interface AdapterModuleFlags {
  adapterModule?: string;
  adapterSetting?: string[];
}

/** Registers `--adapter-module` and `--adapter-setting` on a command. */
export function addAdapterModuleOptions(command: Command): Command {
  return command
    .option(
      '--adapter-module <path>',
      'ES module that exports createAdapter, used in place of the HTTP adapter',
    )
    .option(
      '--adapter-setting <key=value>',
      'setting passed to the adapter module, repeatable',
      collect,
      [],
    );
}

/** Splits `key=value` pairs at the first `=`. Later pairs win. */
export function parseAdapterSettings(pairs: readonly string[]): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new ConfigError(`--adapter-setting ${pair} is not key=value`);
    settings[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return settings;
}

/** Loads the module the flags name, or returns undefined when there is none. */
export async function loadAdapterFromFlags(
  flags: AdapterModuleFlags,
  run: { target: string; timeoutMs: number; connections: number },
): Promise<Adapter | undefined> {
  const settings = parseAdapterSettings(flags.adapterSetting ?? []);
  if (flags.adapterModule === undefined) {
    if (Object.keys(settings).length > 0) {
      throw new ConfigError('--adapter-setting needs --adapter-module');
    }
    return undefined;
  }
  return loadAdapterModule(flags.adapterModule, { ...run, settings });
}
