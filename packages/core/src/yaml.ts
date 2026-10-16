import { readFile } from 'node:fs/promises';
import { parse as parseYamlText } from 'yaml';
import type { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') {
      out += `[${part}]`;
    } else {
      out += out.length === 0 ? String(part) : `.${String(part)}`;
    }
  }
  return out;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = formatPath(issue.path);
      if (issue.code === 'unrecognized_keys') {
        return `unknown key${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map((k) => JSON.stringify(k)).join(', ')} at ${at}`;
      }
      return `${issue.message} at ${at}`;
    })
    .join('; ');
}

/** Parses YAML text and validates it against `schema`. Errors name the file and the path. */
export function parseYaml<T>(text: string, schema: z.ZodType<T>, source: string): T {
  let raw: unknown;
  try {
    raw = parseYamlText(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML (${(err as Error).message})`);
  }
  raw ??= {};
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${source}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export async function loadYamlFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  return parseYaml(text, schema, path);
}
