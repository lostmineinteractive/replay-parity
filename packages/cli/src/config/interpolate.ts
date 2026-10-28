import { ConfigError } from '@replay-parity/core';

/**
 * Secrets through interpolation. `${NAME}` in a configured value is replaced
 * with the environment variable NAME when the command runs, and `$$` is a
 * literal dollar sign. The resolved text is used and never stored or printed.
 */

const PATTERN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** True when `text` holds a `${NAME}` reference or an escaped dollar sign. */
export function hasInterpolation(text: string): boolean {
  PATTERN.lastIndex = 0;
  return PATTERN.test(text);
}

/** The variable names `text` refers to, in order of first appearance. */
export function interpolationNames(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const name = match[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Resolves every `${NAME}` in `text` from `env`. A missing variable is a
 * ConfigError naming the variable and `where`, the key or flag the text came from.
 */
export function interpolate(text: string, env: NodeJS.ProcessEnv, where: string): string {
  return text.replace(PATTERN, (match, name: string | undefined) => {
    if (match === '$$') return '$';
    const value = env[name as string];
    if (value === undefined) {
      throw new ConfigError(`environment variable ${name} is not set (used in ${where})`);
    }
    return value;
  });
}
