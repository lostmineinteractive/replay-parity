import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { resolve } from 'node:path';
import { ConfigError } from '../yaml.js';
import { manifestLine, type RecordingManifest } from './manifest.js';
import { validateRecording } from './ops.js';
import { isGzipPath } from './writer.js';

export interface MigrateResult {
  exchanges: number;
  /** Bytes of the input copied after the manifest line. */
  copied_bytes: number;
}

/**
 * Writes `manifest` as the first line of `outPath` and then every byte of
 * `inPath`, so each exchange line, its line ending, and a missing final
 * newline are kept. A `.gz` input is copied decompressed and a `.gz` output
 * is written compressed; the bytes compared are the decompressed ones. The input is validated first and must not
 * already have a manifest. Nothing is written when a check fails.
 */
export async function migrateRecording(
  inPath: string,
  outPath: string,
  manifest: RecordingManifest,
): Promise<MigrateResult> {
  if (resolve(inPath) === resolve(outPath)) {
    throw new ConfigError('migrate writes a new file; --out must differ from the input');
  }
  const check = await validateRecording(inPath);
  if (!check.ok) {
    const problem = check.problem as NonNullable<typeof check.problem>;
    throw new ConfigError(`${inPath}: ${problem.message}`);
  }
  if (check.manifest !== null) {
    throw new ConfigError(`${inPath} already has a manifest`);
  }
  let copied = 0;
  const source = async function* (): AsyncGenerator<Buffer> {
    yield Buffer.from(manifestLine(manifest), 'utf8');
    const file = createReadStream(inPath);
    const input = isGzipPath(inPath) ? file.pipe(createGunzip()) : file;
    for await (const chunk of input) {
      copied += (chunk as Buffer).byteLength;
      yield chunk as Buffer;
    }
  };
  try {
    if (isGzipPath(outPath)) {
      await pipeline(source, createGzip(), createWriteStream(outPath));
    } else {
      await pipeline(source, createWriteStream(outPath));
    }
  } catch (err) {
    throw new ConfigError(`${outPath}: ${(err as Error).message}`);
  }
  return { exchanges: check.exchanges, copied_bytes: copied };
}
