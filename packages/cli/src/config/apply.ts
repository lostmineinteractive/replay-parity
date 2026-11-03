import { ConfigError } from '@replay-parity/core';
import type { Command, Option } from 'commander';
import { hasInterpolation, interpolate } from './interpolate.js';
import type { EffectiveValue } from './load.js';
import { configurableOptions } from './schema.js';

/**
 * Applies the merged file and environment values to a command before it
 * parses the command line, through commander's own option values, so a flag
 * given on the command line wins and every parser and choice list applies to
 * configured values too.
 */

/** Flags whose command line values are interpolated as well, because they carry secrets. */
export const INTERPOLATED_FLAGS: ReadonlySet<string> = new Set([
  'header',
  'headers-file',
  'target',
  'targets',
  'reference',
  'reset',
  'reset-url',
  'reset-health',
  'bus-url',
  'query',
]);

/** The parser an option had before `wrapListParsers` replaced it. */
const originalParsers = new WeakMap<Option, (value: string, previous: unknown) => unknown>();

/** The text of an option before interpolation, for messages that must not print the resolved value. */
const unresolved = new WeakMap<Command, Map<string, string | string[]>>();

function remember(command: Command, attribute: string, raw: string | string[]): void {
  let map = unresolved.get(command);
  if (map === undefined) {
    map = new Map();
    unresolved.set(command, map);
  }
  map.set(attribute, raw);
}

/** The unresolved text of `attribute` when it held a `${NAME}` reference, else undefined. */
export function unresolvedText(command: Command, attribute: string): string | string[] | undefined {
  return unresolved.get(command)?.get(attribute);
}

/** The text to show for `attribute`: the unresolved form when there was one, else the value itself. */
export function displayText(command: Command, attribute: string, value: string): string {
  const raw = unresolvedText(command, attribute);
  return typeof raw === 'string' ? raw : value;
}

function parseWith(option: Option, text: string, previous: unknown, where: string): unknown {
  const parser = originalParsers.get(option) ?? option.parseArg;
  if (parser === undefined) return text;
  try {
    return parser(text, previous);
  } catch (e) {
    throw new ConfigError(`${where}: ${(e as Error).message}`);
  }
}

/**
 * Makes a repeated flag on the command line replace a list from the file or
 * the environment instead of extending it. The first occurrence starts from
 * the option's own default, later ones accumulate as before.
 */
export function wrapListParsers(command: Command): void {
  for (const spec of configurableOptions(command)) {
    const { option, attribute } = spec;
    if (spec.kind !== 'list' || option.parseArg === undefined) continue;
    const original = option.parseArg as (value: string, previous: unknown) => unknown;
    originalParsers.set(option, original);
    option.argParser((value: string, previous: unknown) =>
      original(
        value,
        command.getOptionValueSource(attribute) === 'cli' ? previous : option.defaultValue,
      ),
    );
  }
}

/**
 * Runs the option parsers over the effective values of `command` without
 * setting or interpolating anything, so a file can be checked for a command
 * that is not the one running. A value holding `${NAME}` is skipped.
 */
export function checkEffective(
  command: Command,
  effective: ReadonlyMap<string, EffectiveValue>,
): void {
  for (const spec of configurableOptions(command)) {
    const entry = effective.get(spec.key);
    if (entry === undefined || spec.kind === 'boolean') continue;
    if (typeof entry.value === 'boolean') continue;
    const texts = (Array.isArray(entry.value) ? entry.value : [entry.value]).map(String);
    let value: unknown = spec.option.defaultValue;
    for (const text of texts) {
      if (hasInterpolation(text)) continue;
      value = parseWith(spec.option, text, value, entry.origin);
    }
  }
}

/** Sets every effective value on `command` as the command line would have, interpolated and parsed. */
export function applyEffective(
  command: Command,
  effective: ReadonlyMap<string, EffectiveValue>,
  env: NodeJS.ProcessEnv,
): void {
  for (const spec of configurableOptions(command)) {
    const entry = effective.get(spec.key);
    if (entry === undefined) continue;
    const { option, attribute } = spec;
    const source = entry.source === 'env' ? 'env' : 'config';
    const where = entry.origin;
    if (spec.kind === 'boolean') {
      // True means the flag is given. False means it is not, so the default stays.
      if (entry.value === true) command.setOptionValueWithSource(attribute, !option.negate, source);
      continue;
    }
    if (spec.kind === 'list') {
      const texts = (entry.value as (string | number)[]).map(String);
      const resolved = texts.map((text) => interpolate(text, env, where));
      if (resolved.some((text, i) => text !== texts[i])) remember(command, attribute, texts);
      let value: unknown = option.defaultValue;
      for (const text of resolved) value = parseWith(option, text, value, where);
      command.setOptionValueWithSource(attribute, value, source);
      continue;
    }
    if (spec.kind === 'optional-value' && typeof entry.value === 'boolean') {
      if (entry.value)
        command.setOptionValueWithSource(attribute, option.presetArg ?? true, source);
      continue;
    }
    const text = String(entry.value);
    const resolved = interpolate(text, env, where);
    if (resolved !== text) remember(command, attribute, text);
    command.setOptionValueWithSource(
      attribute,
      parseWith(option, resolved, option.defaultValue, where),
      source,
    );
  }
}

/**
 * Resolves `${NAME}` in the secret bearing flags given on the command line.
 * Values from the file and the environment were resolved when they were applied.
 */
export function interpolateCommandLine(command: Command, env: NodeJS.ProcessEnv): void {
  for (const spec of configurableOptions(command)) {
    if (!INTERPOLATED_FLAGS.has(spec.key)) continue;
    if (command.getOptionValueSource(spec.attribute) !== 'cli') continue;
    const value: unknown = command.getOptionValue(spec.attribute);
    const where = `--${spec.key}`;
    if (typeof value === 'string') {
      const resolved = interpolate(value, env, where);
      if (resolved === value) continue;
      remember(command, spec.attribute, value);
      command.setOptionValueWithSource(spec.attribute, resolved, 'cli');
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const texts: string[] = value;
      const resolved = texts.map((text) => interpolate(text, env, where));
      if (resolved.every((text, i) => text === texts[i])) continue;
      remember(command, spec.attribute, texts);
      command.setOptionValueWithSource(spec.attribute, resolved, 'cli');
    }
  }
}
