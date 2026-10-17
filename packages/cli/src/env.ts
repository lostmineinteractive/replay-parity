import { readFileSync } from 'node:fs';

/**
 * A small `.env` reader. Lines are `NAME=value`, with an optional `export `
 * prefix, `#` comments, and single or double quotes around the value. Only
 * variables that are not already set are assigned, so the shell wins.
 * Values are never logged.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1] as string] = value;
  }
  return out;
}

/** Loads `path` into `env` for the names that are not already set. Returns the names it set. */
export function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseDotEnv(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}
