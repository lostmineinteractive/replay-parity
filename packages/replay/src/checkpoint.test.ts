import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, makeExchangeResult } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  checkpointPathFor,
  fingerprintDifference,
  readCheckpoint,
  readSidecarPrefix,
  removeCheckpoint,
  writeCheckpoint,
  type Checkpoint,
} from './checkpoint.js';

const checkpoint: Checkpoint = {
  checkpoint_version: 1,
  run_id: 'r1',
  fingerprint: { recording: 'r.jsonl', limit: null },
  next_index: 2,
  last_index: 1,
  sidecar: { path: 'run.exchanges.jsonl', bytes: 10, lines: 2 },
  elapsed_ms: 12.5,
  table_iteration: 1,
  substitutions: { order_id: [['"o-1"', 'c-1', 0]] },
  reference_substitutions: null,
  conditions: [{ kind: 'control_failed', detail: 'x' }],
  barrier_waits: 1,
  stats: { results: 2, counted: 2, errors: 0, matches: 2, tolerated: 0, mismatches: 0 },
};

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-checkpoint-'));
}

describe('checkpoints', () => {
  it('names the checkpoint next to the run file', () => {
    expect(checkpointPathFor('out/run.json')).toBe('out/run.checkpoint.json');
    expect(checkpointPathFor('run')).toBe('run.checkpoint.json');
  });

  it('writes, reads, and removes a checkpoint', async () => {
    const path = join(await dir(), 'run.checkpoint.json');
    await writeCheckpoint(path, checkpoint);
    expect(await readCheckpoint(path)).toEqual(checkpoint);
    await removeCheckpoint(path);
    await expect(access(path)).rejects.toThrow();
  });

  it('refuses a missing, malformed, or foreign checkpoint', async () => {
    const root = await dir();
    await expect(readCheckpoint(join(root, 'none.json'))).rejects.toThrow(/no checkpoint at/);
    await writeFile(join(root, 'bad.json'), '{oops');
    await expect(readCheckpoint(join(root, 'bad.json'))).rejects.toThrow(/invalid JSON/);
    await writeFile(
      join(root, 'other.json'),
      JSON.stringify({ ...checkpoint, checkpoint_version: 9 }),
    );
    await expect(readCheckpoint(join(root, 'other.json'))).rejects.toThrow(ConfigError);
  });

  it('names the first field where two fingerprints differ', () => {
    expect(fingerprintDifference({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBeNull();
    expect(fingerprintDifference({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe('b');
    expect(fingerprintDifference({ a: 1 }, { a: 1, c: 'x' })).toBe('c');
    expect(fingerprintDifference({ a: null }, {})).toBeNull();
  });

  it('reads the prefix of a sidecar and checks its length', async () => {
    const path = join(await dir(), 'run.exchanges.jsonl');
    const lines = ['a', 'b', 'c'].map((id) => `${JSON.stringify(makeExchangeResult({ id }))}\n`);
    await writeFile(path, lines.join(''));
    const bytes = Buffer.byteLength(lines[0]! + lines[1]!);
    expect((await readSidecarPrefix(path, bytes, 2)).map((r) => r.id)).toEqual(['a', 'b']);
    expect(await readSidecarPrefix(path, 0, 0)).toEqual([]);
    await expect(readSidecarPrefix(path, bytes, 3)).rejects.toThrow(/holds 2 results before byte/);
    await writeFile(path, '{oops\n');
    await expect(readSidecarPrefix(path, 6, 1)).rejects.toThrow(/does not hold the checkpoint/);
  });
});
