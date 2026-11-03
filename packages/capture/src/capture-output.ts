import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { RecordingWriter, type Exchange, type RecordingManifest } from '@replay-parity/core';

/**
 * Where the capture writes: one file, or numbered parts when rotation or
 * compression is on. Parts are named `<stem>.0001.jsonl`, or
 * `<stem>.0001.jsonl.gz` with gzip, next to the `out` path, where the stem
 * is the `out` file name without `.jsonl` and `.gz`. Each part is a whole
 * recording that starts with its own manifest, which carries the part
 * number. `offset_ms` continues across parts and is not reset at a part
 * boundary, so the parts merged in order give the offsets of one long
 * capture, and `rp recording merge` gives the same offsets from `ts`. A new
 * capture starts after the highest part number already in the directory and
 * never writes over an earlier part.
 */

export interface RotationOptions {
  /** Start a new part once a part holds this many bytes of JSON Lines, before compression. */
  rotateBytes?: number | undefined;
  /** Start a new part once an exchange arrives this long after the first exchange of the part. */
  rotateIntervalMs?: number | undefined;
  /** Write gzip parts. */
  gzip?: boolean | undefined;
}

/** True when the options ask for numbered parts. */
export function usesParts(options: RotationOptions): boolean {
  return (
    options.rotateBytes !== undefined ||
    options.rotateIntervalMs !== undefined ||
    options.gzip === true
  );
}

function stemOf(out: string): string {
  return basename(out).replace(/(\.jsonl)?(\.gz)?$/i, '');
}

/** The path of part `index` for `out`: `rec.jsonl` and 2 give `rec.0002.jsonl` or `rec.0002.jsonl.gz`. */
export function partPath(out: string, index: number, gzip: boolean): string {
  const name = `${stemOf(out)}.${String(index).padStart(4, '0')}.jsonl${gzip ? '.gz' : ''}`;
  return join(dirname(out), name);
}

/** One more than the highest part number of `out` in its directory, compressed or not, or 1. */
export async function nextPartIndex(out: string): Promise<number> {
  const stem = stemOf(out);
  let names: string[];
  try {
    names = await readdir(dirname(out));
  } catch {
    return 1;
  }
  let highest = 0;
  for (const name of names) {
    if (!name.startsWith(`${stem}.`)) continue;
    const m = /^\.(\d{4,})\.jsonl(\.gz)?$/i.exec(name.slice(stem.length));
    if (m !== null) highest = Math.max(highest, Number(m[1]));
  }
  return highest + 1;
}

export interface CaptureOutputOptions extends RotationOptions {
  out: string;
  /** Append to a single file. Parts are always new files. */
  append: boolean;
  /** Written at the start of a new file and of every part, with the part number on parts. */
  manifest?: RecordingManifest | undefined;
  now: () => number;
}

export class CaptureOutput {
  private writer: RecordingWriter;
  private index: number;
  private partStartTs: number | null = null;
  private readonly written: string[] = [];

  private constructor(
    private readonly options: CaptureOutputOptions,
    writer: RecordingWriter,
    index: number,
  ) {
    this.writer = writer;
    this.index = index;
    this.written.push(writer.path);
  }

  static async open(options: CaptureOutputOptions): Promise<CaptureOutput> {
    if (options.rotateBytes !== undefined && !(options.rotateBytes > 0)) {
      throw new RangeError(`rotateBytes must be positive, got ${options.rotateBytes}`);
    }
    if (options.rotateIntervalMs !== undefined && !(options.rotateIntervalMs > 0)) {
      throw new RangeError(`rotateIntervalMs must be positive, got ${options.rotateIntervalMs}`);
    }
    if (!usesParts(options)) {
      const writer = await RecordingWriter.open(options.out, {
        append: options.append,
        manifest: options.manifest,
      });
      return new CaptureOutput(options, writer, 0);
    }
    const index = await nextPartIndex(options.out);
    const writer = await CaptureOutput.openPart(options, index);
    return new CaptureOutput(options, writer, index);
  }

  private static openPart(options: CaptureOutputOptions, index: number): Promise<RecordingWriter> {
    const gzip = options.gzip === true;
    const manifest =
      options.manifest === undefined
        ? undefined
        : {
            ...options.manifest,
            created_at: new Date(options.now()).toISOString(),
            part: index,
          };
    return RecordingWriter.open(partPath(options.out, index, gzip), {
      append: false,
      gzip,
      manifest,
    });
  }

  /** Every file written so far, in order. */
  get paths(): string[] {
    return [...this.written];
  }

  private due(tsMs: number): boolean {
    if (this.index === 0 || this.writer.count === 0) return false;
    const { rotateBytes, rotateIntervalMs } = this.options;
    if (rotateBytes !== undefined && this.writer.bytes >= rotateBytes) return true;
    return (
      rotateIntervalMs !== undefined &&
      this.partStartTs !== null &&
      tsMs - this.partStartTs >= rotateIntervalMs
    );
  }

  /**
   * Writes one exchange, first starting a new part when the current one is
   * due. `tsMs` is the arrival time the interval is measured with. Calls
   * are expected one at a time, as the capture's ordered sink makes them.
   */
  async write(exchange: Exchange, tsMs: number): Promise<void> {
    if (this.due(tsMs)) {
      await this.writer.close();
      this.index += 1;
      this.writer = await CaptureOutput.openPart(this.options, this.index);
      this.written.push(this.writer.path);
      this.partStartTs = null;
    }
    this.partStartTs ??= tsMs;
    await this.writer.write(exchange);
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}
