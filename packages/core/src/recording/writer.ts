import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { open, type FileHandle } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGzip, type Gzip } from 'node:zlib';
import { manifestLine, type RecordingManifest } from './manifest.js';
import { ExchangeSchema, type Exchange } from './types.js';

export interface RecordingWriterOptions {
  /** Append to an existing file (default) or truncate it. */
  append?: boolean | undefined;
  /**
   * Written as the first line when the file starts empty: a new file, a
   * truncated one, or an empty one opened for append. A file that already
   * has content is appended to without one.
   */
  manifest?: RecordingManifest | undefined;
  /** Write gzip. Default: true when the path ends in `.gz`. */
  gzip?: boolean | undefined;
}

/** True for a path the reader and writer treat as gzip: one ending in `.gz`. */
export function isGzipPath(path: string): boolean {
  return /\.gz$/i.test(path);
}

/**
 * Compresses lines on their way to the file. Compressed chunks are written
 * in the order the compressor emits them. Appending to a file that already
 * holds gzip data starts a new gzip member, which readers of gzip, this
 * one included, decompress as one stream.
 */
class GzipOutput {
  private readonly gzip: Gzip = createGzip();
  private pending: Promise<void> = Promise.resolve();

  constructor(handle: FileHandle) {
    this.gzip.on('data', (chunk: Buffer) => {
      this.pending = this.pending.then(async () => {
        await handle.write(chunk);
      });
    });
  }

  write(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.gzip.write(text, 'utf8', (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Pushes everything written so far through the compressor and onto the file. */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => this.gzip.flush(() => resolve()));
    await nextTurn();
    await this.pending;
  }

  async end(): Promise<void> {
    const ended = once(this.gzip, 'end');
    this.gzip.end();
    await ended;
    await this.pending;
  }
}

/**
 * Append only JSON Lines writer. Writes are serialized in call order and
 * `close` resolves after every pending write has reached the file.
 */
export class RecordingWriter {
  private handle: FileHandle | null;
  private queue: Promise<void> = Promise.resolve();
  private lastOffset = -Infinity;
  private written = 0;
  private bytesWritten = 0;
  private manifestWritten = false;
  private readonly filePath: string;
  private readonly gz: GzipOutput | null;

  private constructor(handle: FileHandle, filePath: string, gzip: boolean) {
    this.handle = handle;
    this.filePath = filePath;
    this.gz = gzip ? new GzipOutput(handle) : null;
  }

  static async open(path: string, options: RecordingWriterOptions = {}): Promise<RecordingWriter> {
    const handle = await open(path, options.append === false ? 'w' : 'a');
    const writer = new RecordingWriter(handle, path, options.gzip ?? isGzipPath(path));
    if (options.manifest !== undefined) {
      try {
        if ((await handle.stat()).size === 0) {
          const line = manifestLine(options.manifest);
          await writer.put(handle, line);
          writer.manifestWritten = true;
        }
      } catch (err) {
        await handle.close();
        throw err;
      }
    }
    return writer;
  }

  private async put(handle: FileHandle, line: string): Promise<void> {
    if (this.gz === null) {
      await handle.write(line, null, 'utf8');
    } else {
      await this.gz.write(line);
    }
    this.bytesWritten += Buffer.byteLength(line);
  }

  /** True when the file is written as gzip. */
  get gzip(): boolean {
    return this.gz !== null;
  }

  /** True when this writer started the file with a manifest line. */
  get wroteManifest(): boolean {
    return this.manifestWritten;
  }

  /** Bytes of JSON Lines this writer has written, the manifest line included, before any compression. */
  get bytes(): number {
    return this.bytesWritten;
  }

  get path(): string {
    return this.filePath;
  }

  get count(): number {
    return this.written;
  }

  write(exchange: Exchange): Promise<void> {
    if (this.handle === null) {
      return Promise.reject(new Error('recording writer is closed'));
    }
    if (exchange.offset_ms < this.lastOffset) {
      return Promise.reject(
        new Error(
          `offset_ms ${exchange.offset_ms} is lower than the previous offset ${this.lastOffset}`,
        ),
      );
    }
    this.lastOffset = exchange.offset_ms;
    // Validate on the way out so a corrupt line can never be appended.
    const line = `${JSON.stringify(ExchangeSchema.parse(exchange))}\n`;
    const handle = this.handle;
    this.queue = this.queue.then(async () => {
      await this.put(handle, line);
      this.written += 1;
    });
    return this.queue;
  }

  /** Resolves when every write issued so far has been handed to the file and synced. */
  async flush(): Promise<void> {
    await this.queue;
    await this.gz?.flush();
    if (this.handle) await this.handle.sync();
  }

  /** Finishes the gzip stream when there is one, flushes, and closes the file. */
  async close(): Promise<void> {
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    try {
      await this.queue;
      await this.gz?.end();
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
