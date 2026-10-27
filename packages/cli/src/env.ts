import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

const ROOT_MARKERS = ['.git', 'pnpm-workspace.yaml'];

/** The nearest directory at or above `from` that holds `.git` or `pnpm-workspace.yaml`, or null. */
export function findProjectRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where a `.env` path is looked for, in order. An absolute path is tried as
 * is. A relative path is tried in the working directory and then, when the
 * working directory is inside a project, at the project root.
 */
export function dotEnvCandidates(path: string, cwd: string): string[] {
  if (isAbsolute(path)) return [path];
  const candidates = [resolve(cwd, path)];
  const root = findProjectRoot(cwd);
  if (root !== null) {
    const atRoot = resolve(root, path);
    if (atRoot !== candidates[0]) candidates.push(atRoot);
  }
  return candidates;
}

export interface DotEnvLoad {
  /** The file that was read, or null when none of the candidates exists. */
  loaded: string | null;
  /** Every path that was looked at, in order, ending with the one loaded. */
  tried: string[];
  /** The names that were set. */
  set: string[];
}

/** Loads the first candidate of `path` into `env` for the names that are not already set. */
export function loadDotEnv(
  path = '.env',
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DotEnvLoad {
  const tried: string[] = [];
  for (const candidate of dotEnvCandidates(path, cwd)) {
    tried.push(candidate);
    let text: string;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const set: string[] = [];
    for (const [name, value] of Object.entries(parseDotEnv(text))) {
      if (env[name] !== undefined) continue;
      env[name] = value;
      set.push(name);
    }
    return { loaded: candidate, tried, set };
  }
  return { loaded: null, tried, set: [] };
}
