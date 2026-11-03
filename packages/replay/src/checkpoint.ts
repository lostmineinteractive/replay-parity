import { createReadStream } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  ConfigError,
  ExchangeResultSchema,
  InconclusiveConditionSchema,
  canonicalJson,
  type ExchangeResult,
  type InconclusiveCondition,
  type JsonValue,
} from '@replay-parity/core';
import { z } from 'zod';
import type { TableSnapshot } from './substitutions.js';

/**
 * Checkpoints. A run that streams its results to the sidecar writes a
 * checkpoint every `CHECKPOINT_EVERY` acknowledgements and when it stops. It
 * names the end of the acknowledged prefix, how many bytes of the sidecar hold
 * that prefix, the substitution tables as that prefix left them, and the
 * conditions and barrier waits it produced. `--resume` truncates the sidecar
 * to the prefix, rebuilds the statistics from it, and sends the exchanges
 * after it. The statistics in the checkpoint are a cross check: the resumed
 * run refuses a sidecar whose prefix does not add up to them.
 */

export const CHECKPOINT_VERSION = 1;

/** Acknowledgements between two checkpoints. */
export const CHECKPOINT_EVERY = 1000;

/** The checkpoint next to a run file: `run.json` gives `run.checkpoint.json`. */
export function checkpointPathFor(out: string): string {
  return `${out.endsWith('.json') ? out.slice(0, -'.json'.length) : out}.checkpoint.json`;
}

const count = z.number().int().nonnegative();

const TableSnapshotSchema = z.record(
  z.string(),
  z.array(z.tuple([z.string(), z.union([z.string(), z.number()]), z.number().int().nullable()])),
);

export const CheckpointSchema = z
  .object({
    checkpoint_version: z.literal(CHECKPOINT_VERSION),
    run_id: z.string().min(1),
    /** What the resumed run must match: the recording and every option that changes the selection or the results. */
    fingerprint: z.record(z.string(), z.json()),
    /** The position of the first exchange the resumed run sends. */
    next_index: count,
    /** The last position of the acknowledged prefix, -1 when it is empty. */
    last_index: z.number().int().min(-1),
    sidecar: z.object({ path: z.string().min(1), bytes: count, lines: count }).strict(),
    /** Milliseconds since the run started when the prefix ended, so times keep increasing. */
    elapsed_ms: z.number().nonnegative(),
    /** The iteration of the last acknowledged exchange, whose tables the snapshots hold. */
    table_iteration: z.number().int().positive().nullable(),
    substitutions: TableSnapshotSchema,
    reference_substitutions: TableSnapshotSchema.nullable(),
    conditions: z.array(InconclusiveConditionSchema),
    barrier_waits: count,
    /** Counts over the prefix, checked against the sidecar on resume. */
    stats: z
      .object({
        results: count,
        counted: count,
        errors: count,
        matches: count,
        tolerated: count,
        mismatches: count,
      })
      .strict(),
  })
  .strict();

export type Checkpoint = z.output<typeof CheckpointSchema>;
export type CheckpointStats = Checkpoint['stats'];

/** Writes the checkpoint through a temporary file, so a reader never sees half of one. */
export async function writeCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(CheckpointSchema.parse(checkpoint), null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function readCheckpoint(path: string): Promise<Checkpoint> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`--resume: no checkpoint at ${path} (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  const parsed = CheckpointSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${path}: not a checkpoint this rp can resume`);
  return parsed.data;
}

export async function removeCheckpoint(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.tmp`, { force: true });
}

/**
 * Names the first fingerprint field that differs, or returns null when the
 * resumed run is the same run as the one that wrote the checkpoint.
 */
export function fingerprintDifference(
  expected: Record<string, JsonValue>,
  actual: Record<string, JsonValue>,
): string | null {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    if (canonicalJson(expected[key] ?? null) !== canonicalJson(actual[key] ?? null)) return key;
  }
  return null;
}

/** Reads the first `lines` results of a sidecar, which hold `bytes` bytes. */
export async function readSidecarPrefix(
  path: string,
  bytes: number,
  lines: number,
): Promise<ExchangeResult[]> {
  const out: ExchangeResult[] = [];
  if (lines === 0) return out;
  const input = createReadStream(path, { encoding: 'utf8', start: 0, end: bytes - 1 });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      out.push(ExchangeResultSchema.parse(JSON.parse(line)));
    }
  } catch (err) {
    throw new ConfigError(
      `--resume: ${path} does not hold the checkpoint's results (${(err as Error).message})`,
    );
  } finally {
    rl.close();
    input.destroy();
  }
  if (out.length !== lines) {
    throw new ConfigError(
      `--resume: ${path} holds ${out.length} results before byte ${bytes}, the checkpoint expects ${lines}`,
    );
  }
  return out;
}

export type { InconclusiveCondition, TableSnapshot };
