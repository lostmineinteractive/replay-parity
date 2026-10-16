import { open, type FileHandle } from 'node:fs/promises';
import { ExchangeSchema, type Exchange } from './types.js';

/**
 * Append only JSON Lines writer. Writes are serialized in call order and
 * `close` resolves after every pending write has reached the file.
 */
export class RecordingWriter {
  private handle: FileHandle | null;
  private queue: Promise<void> = Promise.resolve();
  private lastOffset = -Infinity;
  private written = 0;
  private readonly filePath: string;

  private constructor(handle: FileHandle, filePath: string) {
    this.handle = handle;
    this.filePath = filePath;
  }

  static async open(path: string, options: { append?: boolean } = {}): Promise<RecordingWriter> {
    const handle = await open(path, options.append === false ? 'w' : 'a');
    return new RecordingWriter(handle, path);
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
      await handle.write(line, null, 'utf8');
      this.written += 1;
    });
    return this.queue;
  }

  /** Resolves when every write issued so far has been handed to the file and synced. */
  async flush(): Promise<void> {
    await this.queue;
    if (this.handle) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.handle === null) return;
    await this.flush();
    const handle = this.handle;
    this.handle = null;
    await handle.close();
  }
}
