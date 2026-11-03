import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { ConfigError } from '../yaml.js';
import { validateRules, type DiffRules } from './schema.js';

/**
 * Loads a rules file with its packs. `include` at the top of a file lists
 * other rules files, resolved relative to the including file and merged
 * before validation: the lists of an included file come first and the
 * including file's entries follow, and a scalar in the including file wins.
 * A pack may include packs of its own. A missing file and an include cycle
 * are configuration errors that name the chain of files.
 */

type Raw = Record<string, unknown>;

function isMapping(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lists concatenate with `base` first, mappings merge key by key, and anything else takes `over`. */
export function mergeRules(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      out[key] = [...(current as unknown[]), ...(value as unknown[])];
    } else if (isMapping(current) && isMapping(value)) {
      out[key] = mergeRules(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function chainText(chain: readonly string[]): string {
  return chain.length === 0 ? '' : ` (included by ${chain.join(' -> ')})`;
}

async function loadRaw(file: string, chain: readonly string[]): Promise<Raw> {
  if (chain.includes(file)) {
    throw new ConfigError(`${file}: include cycle ${[...chain, file].join(' -> ')}`);
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`${file}: ${(err as Error).message}${chainText(chain)}`);
  }
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (err) {
    throw new ConfigError(`${file}: invalid YAML (${(err as Error).message})${chainText(chain)}`);
  }
  raw ??= {};
  if (!isMapping(raw)) {
    throw new ConfigError(`${file}: expected a mapping at the top level${chainText(chain)}`);
  }
  const { include, ...rest } = raw;
  if (include === undefined) return rest;
  if (!Array.isArray(include) || !include.every((item) => typeof item === 'string')) {
    throw new ConfigError(`${file}: include must be a list of file paths${chainText(chain)}`);
  }
  let merged: Raw = {};
  for (const item of include) {
    const target = resolve(dirname(file), item);
    merged = mergeRules(merged, await loadRaw(target, [...chain, file]));
  }
  return mergeRules(merged, rest);
}

/** The merged rules of a file and its packs, before validation. */
export async function loadRawRules(path: string): Promise<Record<string, unknown>> {
  return loadRaw(resolve(path), []);
}

export async function loadDiffRules(path: string): Promise<DiffRules> {
  return validateRules(await loadRawRules(path), path);
}
