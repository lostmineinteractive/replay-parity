import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '@replay-parity/core';
import type { LoadedInvariantModule } from './module.js';

const HOOKS = ['epochs', 'snapshots', 'inconclusive'] as const;

/**
 * Checks that `value` has the shape of an invariant module and returns it
 * typed. `source` names the module in errors. Throws a `ConfigError` naming
 * the first problem: a missing or empty `name`, a `version` that is not a
 * string, a missing `parse`, an empty `rules`, a rule without a positive
 * integer `id`, a `name`, a `statement`, and a `check` function, two rules
 * with the same id or name, or an optional hook of the wrong type.
 */
export function validateInvariantModule(value: unknown, source: string): LoadedInvariantModule {
  if (typeof value !== 'object' || value === null) {
    throw new ConfigError(`invariant module ${source} does not export a module object`);
  }
  const m = value as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new ConfigError(`invariant module ${source} does not export a name`);
  }
  if (typeof m.version !== 'string') {
    throw new ConfigError(`invariant module ${source} does not export a version string`);
  }
  if (typeof m.parse !== 'function') {
    throw new ConfigError(`invariant module ${source} does not export a parse function`);
  }
  if (!Array.isArray(m.rules) || m.rules.length === 0) {
    throw new ConfigError(`invariant module ${source} does not export a non empty rules array`);
  }
  const ids = new Set<number>();
  const names = new Set<string>();
  m.rules.forEach((raw: unknown, i) => {
    const at = `invariant module ${source}: rules[${i}]`;
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1) {
      throw new ConfigError(`${at} needs an id that is a positive integer`);
    }
    if (typeof r.name !== 'string' || r.name.length === 0) {
      throw new ConfigError(`${at} needs a name`);
    }
    if (typeof r.statement !== 'string' || r.statement.length === 0) {
      throw new ConfigError(`${at} needs a statement`);
    }
    if (typeof r.check !== 'function') {
      throw new ConfigError(`${at} needs a check function`);
    }
    if (ids.has(r.id)) throw new ConfigError(`${at} repeats the id ${r.id}`);
    if (names.has(r.name)) throw new ConfigError(`${at} repeats the name ${r.name}`);
    ids.add(r.id);
    names.add(r.name);
  });
  for (const hook of HOOKS) {
    if (m[hook] !== undefined && typeof m[hook] !== 'function') {
      throw new ConfigError(`invariant module ${source}: ${hook} must be a function`);
    }
  }
  if (
    m.stateChanging !== undefined &&
    !(Array.isArray(m.stateChanging) && m.stateChanging.every((k) => typeof k === 'string'))
  ) {
    throw new ConfigError(`invariant module ${source}: stateChanging must be a list of kinds`);
  }
  return m as unknown as LoadedInvariantModule;
}

/**
 * Loads an ES module that exports an invariant module, either as named
 * exports `name`, `version`, `parse`, and `rules` or as a default export
 * object with those keys. The path is resolved against the working
 * directory and the result carries the SHA-256 of the file. Throws a
 * `ConfigError` for a file that is missing, a module that cannot be
 * imported, and anything `validateInvariantModule` rejects.
 */
export async function loadInvariantModule(path: string): Promise<LoadedInvariantModule> {
  const file = resolve(path);
  let bytes: Buffer;
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    bytes = await readFile(file);
  } catch {
    throw new ConfigError(`invariant module ${path} does not exist`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`invariant module ${path} failed to load: ${(e as Error).message}`);
  }
  const fromDefault =
    typeof mod.default === 'object' && mod.default !== null && !('parse' in mod)
      ? (mod.default as Record<string, unknown>)
      : mod;
  const module = validateInvariantModule(fromDefault, path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // A namespace object is frozen, so the loaded module is a copy with the hash added.
  return { ...module, sha256 };
}
