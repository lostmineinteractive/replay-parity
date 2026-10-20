import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@replay-parity/core';

/**
 * Prompt files are plain Markdown under `prompts/`. Each is logged by name
 * and content hash so a transcript can be matched to the exact text.
 */
function findPromptsDir(): string {
  // From src/ the files sit one directory up. From dist/src/ they sit two up.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../prompts'), resolve(here, '../../prompts')]) {
    if (existsSync(join(candidate, 'system.md'))) return candidate;
  }
  return resolve(here, '../prompts');
}

export const DEFAULT_PROMPTS_DIR = findPromptsDir();

export interface PromptFile {
  name: string;
  text: string;
  /** First twelve hex characters of the SHA-256 of the text. */
  version: string;
}

export interface Prompts {
  system: PromptFile;
  round: PromptFile;
  versions: Record<string, string>;
}

function load(dir: string, name: string): PromptFile {
  const text = readFileSync(join(dir, name), 'utf8');
  return { name, text, version: sha256Hex(text).slice(0, 12) };
}

export function loadPrompts(dir = DEFAULT_PROMPTS_DIR): Prompts {
  const system = load(dir, 'system.md');
  const round = load(dir, 'round.md');
  return {
    system,
    round,
    versions: { [system.name]: system.version, [round.name]: round.version },
  };
}

/**
 * The round template puts everything that changes from round to round under
 * this heading: the kept cases, the round number, and the case count. The
 * text above it is identical across the rounds of one loop and is marked
 * for prompt caching.
 */
export const ROUND_VARYING_HEADING = '## Cases already kept';

/** Length of the stable prefix of a rendered round prompt, or 0 when the heading is missing. */
export function cachePrefixLength(user: string): number {
  const index = user.indexOf(ROUND_VARYING_HEADING);
  return index <= 0 ? 0 : index;
}

/** Replaces `{{name}}` with the value. Missing names are left in place so they are visible. */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}
