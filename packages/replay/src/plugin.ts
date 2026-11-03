import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, type RecordedRequest, type RecordedResponse } from '@replay-parity/core';
import type { Adapter, ReplayContext } from './adapter.js';

/** What a plugin module's `createAdapter` receives. */
export interface AdapterModuleOptions {
  /** The `--target` text, unparsed. */
  target: string;
  timeoutMs: number;
  /** The number of requests the engine keeps in flight, which is the most connections the adapter needs. */
  connections: number;
  /** The `--adapter-setting key=value` pairs. */
  settings: Readonly<Record<string, string>>;
}

/** The adapter name a run records for a plugin. */
export function pluginAdapterName(name: string): string {
  return `plugin:${name}`;
}

/** Records the plugin's own name under a `plugin:` prefix and passes everything else through. */
class PluginAdapter implements Adapter {
  readonly name: string;

  constructor(private readonly inner: Adapter) {
    this.name = pluginAdapterName(inner.name);
  }

  send(req: RecordedRequest, ctx: ReplayContext): Promise<RecordedResponse> {
    return this.inner.send(req, ctx);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

function isAdapter(value: unknown): value is Adapter {
  const v = value as { name?: unknown; send?: unknown; close?: unknown } | null;
  return (
    typeof value === 'object' &&
    v !== null &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.send === 'function' &&
    (v.close === undefined || typeof v.close === 'function')
  );
}

/**
 * Loads an ES module that exports `createAdapter(options)`, which returns an
 * `Adapter` or a promise of one. The path is resolved against the working
 * directory. Throws a `ConfigError` for a file that is missing, a module that
 * cannot be imported, a missing `createAdapter` export, a `createAdapter` that
 * throws, and a result without a string `name` and a `send` function.
 */
export async function loadAdapterModule(
  path: string,
  options: AdapterModuleOptions,
): Promise<Adapter> {
  const file = resolve(path);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    throw new ConfigError(`adapter module ${path} does not exist`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`adapter module ${path} failed to load: ${(e as Error).message}`);
  }
  const create = mod.createAdapter;
  if (typeof create !== 'function') {
    throw new ConfigError(`adapter module ${path} does not export a createAdapter function`);
  }
  let adapter: unknown;
  try {
    adapter = await (create as (o: AdapterModuleOptions) => unknown)(options);
  } catch (e) {
    throw new ConfigError(`createAdapter in ${path} failed: ${(e as Error).message}`);
  }
  if (!isAdapter(adapter)) {
    throw new ConfigError(
      `createAdapter in ${path} must return an object with a name and a send function`,
    );
  }
  return new PluginAdapter(adapter);
}
