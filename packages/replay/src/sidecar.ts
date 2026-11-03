import { open, type FileHandle } from 'node:fs/promises';
import type { ExchangeResult } from '@replay-parity/core';

/**
 * The exchanges sidecar. A large run streams every exchange result to a JSON
 * Lines file next to the run, in recording order, and the run file keeps the
 * summary and a sample of the mismatched exchanges. `rp report` reads the
 * sidecar when it is present.
 */

/** Above this many results the sidecar is used unless the caller turned it off. */
export const SIDECAR_THRESHOLD = 50_000;

/** Mismatched exchanges the run file keeps per generalized path when the sidecar is used. */
export const KEEP_PER_PATH = 20;

/** The group key of a mismatched exchange with no untolerated finding. */
export const NO_PATH = '(no untolerated finding)';

/** The sidecar next to a run file: `run.json` gives `run.exchanges.jsonl`. */
export function sidecarPathFor(out: string): string {
  return `${out.endsWith('.json') ? out.slice(0, -'.json'.length) : out}.exchanges.jsonl`;
}

/** Folds array positions into `[*]`, the way the reports group findings. */
export function generalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[*]');
}

/**
 * Keeps the first `perPath` mismatched exchanges of every generalized path, in
 * run order. The path of an exchange is the generalized path of its first
 * untolerated finding, which is how the HTML report groups its drill down.
 * Controls are left out, as the reports leave them out of the mismatches.
 */
export class MismatchSample {
  private readonly kept: ExchangeResult[] = [];
  private readonly perKey = new Map<string, number>();

  constructor(private readonly perPath = KEEP_PER_PATH) {}

  add(result: ExchangeResult): void {
    if (result.control || result.diff?.verdict !== 'mismatch') return;
    const first = result.diff.findings.find((f) => !f.tolerated);
    const key = first === undefined ? NO_PATH : generalizePath(first.path);
    const n = this.perKey.get(key) ?? 0;
    if (n >= this.perPath) return;
    this.perKey.set(key, n + 1);
    this.kept.push(result);
  }

  list(): ExchangeResult[] {
    return [...this.kept];
  }
}

/**
 * Appends results to the sidecar as JSON Lines. Writes are buffered and issued
 * in order, `bytes` counts every byte handed to `write`, and `flush` resolves
 * once all of them reached the file.
 */
export class SidecarWriter {
  private buffer: string[] = [];
  private buffered = 0;
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  /** Bytes written or queued so far, the file's length once `flush` resolves. */
  bytes: number;
  /** Lines written or queued so far. */
  lines: number;

  private constructor(
    private readonly handle: FileHandle,
    readonly path: string,
    bytes: number,
    lines: number,
  ) {
    this.bytes = bytes;
    this.lines = lines;
  }

  /**
   * Opens the sidecar. A new run truncates the file. A resumed run keeps its
   * first `keep.bytes` bytes, which hold `keep.lines` results, and appends after them.
   */
  static async open(
    path: string,
    keep: { bytes: number; lines: number } | null = null,
  ): Promise<SidecarWriter> {
    if (keep === null) return new SidecarWriter(await open(path, 'w'), path, 0, 0);
    const handle = await open(path, 'r+');
    await handle.truncate(keep.bytes);
    return new SidecarWriter(handle, path, keep.bytes, keep.lines);
  }

  write(result: ExchangeResult): void {
    const line = `${JSON.stringify(result)}\n`;
    this.buffer.push(line);
    this.buffered += line.length;
    this.bytes += Buffer.byteLength(line);
    this.lines += 1;
    if (this.buffered >= 1 << 16) this.drain();
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.buffered = 0;
    const position = this.bytes - Buffer.byteLength(chunk);
    this.queue = this.queue.then(async () => {
      if (this.failure !== null) return;
      try {
        await this.handle.write(chunk, position, 'utf8');
      } catch (err) {
        this.failure = err as Error;
      }
    });
  }

  /** Resolves once every result written so far reached the file. */
  async flush(): Promise<void> {
    this.drain();
    await this.queue;
    if (this.failure !== null) throw this.failure;
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.handle.close();
    }
  }
}
