import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exchange, Run } from '@replay-parity/core';
import { onTestFailed } from 'vitest';

/** Helpers shared by the engine's integration tests. */

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-replay-'));
}

export async function writeRecording(
  exchanges: readonly Exchange[],
  dir?: string,
): Promise<string> {
  const path = join(dir ?? (await tempDir()), 'recording.jsonl');
  await writeFile(path, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

/**
 * Logs why an attempt of a retried timing test failed, with the pacing fields of its runs, so a
 * retry is never silent in the output. The hook runs after each failed attempt.
 */
export function logFailedAttempt(...runs: Run[]): void {
  onTestFailed(({ task }) => {
    const errors = task.result?.errors ?? [];
    const lines = runs.map((run) => {
      const timeline = run.exchanges
        .map((e) => `${e.scheduled_at_ms}/${e.sent_at_ms}/${e.acked_at_ms ?? '-'}`)
        .join(' ');
      return (
        `pacing ${JSON.stringify(run.pacing)} duration_ms ${run.duration_ms}\n` +
        `scheduled/sent/acked ${timeline}`
      );
    });
    console.error(
      `attempt failed: ${errors[errors.length - 1]?.message ?? 'no error recorded'}\n${lines.join('\n')}`,
    );
  });
}
