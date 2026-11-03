import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Exchange } from '@replay-parity/core';

/**
 * Attempt memoization. An attempt is judged once: the verdict is stored under
 * a hash of the exact subset, with its lowered values, and a later attempt
 * with the same key is answered from the store without a replay. The file
 * form is JSON lines, one `{ "key": "<sha256>", "reproduced": true }` per
 * verdict, appended as attempts finish.
 */
export interface AttemptCache {
  get(key: string): boolean | undefined;
  set(key: string, reproduced: boolean): Promise<void>;
}

/** A cache that lives as long as the process. */
export class MemoryAttemptCache implements AttemptCache {
  protected readonly verdicts = new Map<string, boolean>();

  get(key: string): boolean | undefined {
    return this.verdicts.get(key);
  }

  set(key: string, reproduced: boolean): Promise<void> {
    this.verdicts.set(key, reproduced);
    return Promise.resolve();
  }

  get size(): number {
    return this.verdicts.size;
  }
}

class FileAttemptCache extends MemoryAttemptCache {
  constructor(private readonly path: string) {
    super();
  }

  /** Reads the lines already in the file. A line that is not a verdict is skipped. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as { key?: unknown; reproduced?: unknown };
        if (typeof entry.key === 'string' && typeof entry.reproduced === 'boolean') {
          this.verdicts.set(entry.key, entry.reproduced);
        }
      } catch {
        // A line cut short by a crash is not a verdict.
      }
    }
  }

  override async set(key: string, reproduced: boolean): Promise<void> {
    if (this.verdicts.get(key) === reproduced) return;
    await super.set(key, reproduced);
    await appendFile(this.path, `${JSON.stringify({ key, reproduced })}\n`, 'utf8');
  }
}

/** Opens the cache stored at `path`, creating the file's directory when needed. */
export async function openAttemptCache(path: string): Promise<MemoryAttemptCache> {
  await mkdir(dirname(path), { recursive: true });
  const cache = new FileAttemptCache(path);
  await cache.load();
  return cache;
}

/** Hash of the inputs that decide a verdict besides the subset: the rule, the replay settings, the repeat. */
export function cacheSalt(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Hash of the exact subset: each exchange's identity and its request as it will be sent. */
export function attemptKey(salt: string, subset: readonly Exchange[]): string {
  const hash = createHash('sha256');
  hash.update(salt);
  for (const exchange of subset) {
    hash.update('\n');
    hash.update(JSON.stringify([exchange.id, exchange.request]));
  }
  return hash.digest('hex');
}
