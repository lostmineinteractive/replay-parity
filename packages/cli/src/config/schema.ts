import type { Command, Option } from 'commander';
import { z } from 'zod';

/**
 * The shape of `rp.yaml`, derived from the registered commands so the flag list
 * lives in one place. Every long flag of every command is a key under the
 * command's name, spelled as on the command line without the leading dashes.
 * `profiles.<name>` holds the same structure and overrides the top level.
 */

/** How a flag takes its value, which decides the YAML type its key accepts. */
export type OptionKind = 'boolean' | 'list' | 'value' | 'optional-value';

export interface OptionSpec {
  /** The key in the file and the flag without dashes, such as `max-gap-ms`. */
  key: string;
  /** The camel case name commander stores the value under. */
  attribute: string;
  kind: OptionKind;
  option: Option;
}

/** Flags that choose the configuration and therefore cannot come from it. */
export const META_FLAGS: ReadonlySet<string> = new Set(['config', 'profile']);

export function optionKind(option: Option): OptionKind {
  if (option.negate || option.isBoolean()) return 'boolean';
  if (Array.isArray(option.defaultValue)) return 'list';
  if (option.optional) return 'optional-value';
  return 'value';
}

/** The key for an option: its long flag without the leading dashes. */
export function optionKey(option: Option): string {
  return (option.long ?? option.flags).replace(/^-+/, '');
}

/** The options of `command` that the file and the environment may set, in registration order. */
export function configurableOptions(command: Command): OptionSpec[] {
  const out: OptionSpec[] = [];
  for (const option of command.options) {
    if (option.long === undefined || option.hidden) continue;
    const key = optionKey(option);
    if (META_FLAGS.has(key)) continue;
    out.push({ key, attribute: option.attributeName(), kind: optionKind(option), option });
  }
  return out;
}

const scalar = z.union([z.string(), z.number()], { error: 'expected a string or a number' });

function valueSchema(kind: OptionKind): z.ZodType {
  switch (kind) {
    case 'boolean':
      return z.boolean({ error: 'expected true or false' });
    case 'list':
      return z.array(scalar, { error: 'expected a list' });
    case 'optional-value':
      return z.union([scalar, z.boolean()], { error: 'expected a string, a number, or true' });
    case 'value':
      return scalar;
  }
}

/** The section for one command: every configurable flag, nothing else. */
export function commandSchema(command: Command): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const spec of configurableOptions(command))
    shape[spec.key] = valueSchema(spec.kind).optional();
  return z.object(shape).strict();
}

/** The whole file: one optional section per command and `profiles`, each profile the same sections. */
export function configFileSchema(commands: readonly Command[]): z.ZodType<Record<string, unknown>> {
  const sections: Record<string, z.ZodType> = {};
  for (const command of commands) sections[command.name()] = commandSchema(command).optional();
  const profile = z.object(sections).strict();
  return z.object({ ...sections, profiles: z.record(z.string(), profile).optional() }).strict();
}

export type CommandSection = Record<string, unknown>;

export interface ConfigFile {
  /** Command name to its top level section. */
  commands: Record<string, CommandSection>;
  /** Profile name to its sections. */
  profiles: Record<string, Record<string, CommandSection>>;
}

/** Splits a validated document into command sections and profiles. */
export function toConfigFile(raw: Record<string, unknown>): ConfigFile {
  const commands: Record<string, CommandSection> = {};
  const profiles: Record<string, Record<string, CommandSection>> = {};
  for (const [name, section] of Object.entries(raw)) {
    if (name === 'profiles') {
      for (const [profile, body] of Object.entries(section as Record<string, unknown>)) {
        const inner: Record<string, CommandSection> = {};
        for (const [command, keys] of Object.entries(body as Record<string, unknown>)) {
          if (keys !== undefined) inner[command] = keys as CommandSection;
        }
        profiles[profile] = inner;
      }
    } else if (section !== undefined) {
      commands[name] = section as CommandSection;
    }
  }
  return { commands, profiles };
}
