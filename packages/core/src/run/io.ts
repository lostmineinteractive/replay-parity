import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError, formatZodError } from '../yaml.js';
import { migrateRun } from './migrate.js';
import { RunSchema, type Run } from './schema.js';

export function serializeRun(run: Run): string {
  return `${JSON.stringify(RunSchema.parse(run), null, 2)}\n`;
}

export async function writeRun(path: string, run: Run): Promise<void> {
  await writeFile(path, serializeRun(run), 'utf8');
}

export function parseRun(text: string, source = 'run'): Run {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid JSON (${(err as Error).message})`);
  }
  // A file from an earlier rp is brought to the current version before validation.
  let migrated: unknown;
  try {
    migrated = migrateRun(raw);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`${source}: ${err.message}`);
    throw err;
  }
  const result = RunSchema.safeParse(migrated);
  if (!result.success) {
    throw new ConfigError(`${source}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export async function readRun(path: string): Promise<Run> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  return parseRun(text, path);
}

/** The JSON Schema (draft 2020-12) for the run file, derived from the zod schema. */
export function runJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RunSchema, { target: 'draft-2020-12', io: 'output' });
  return {
    $id: 'https://replay-parity.dev/schema/run.schema.json',
    title: 'replay-parity run',
    description: 'The canonical JSON report produced by rp replay and extended by rp agent.',
    ...schema,
  };
}
