import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ConfigError } from '../yaml.js';

/**
 * The hash of a recording file. It is the SHA-256 of the file's bytes as they
 * are on disk, newlines included, so it ties a run to one exact file and
 * changes when a line is edited, added, removed, or reordered.
 */
export interface RecordingHash {
  /** Lower case hex SHA-256 of every byte of the file. */
  sha256: string;
  /** Size of the file in bytes. */
  bytes: number;
  /** Lines in the file. A final line without a trailing newline counts. An empty file has none. */
  lines: number;
}

export const RECORDING_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const NEWLINE = 0x0a;

/**
 * Hashes a recording file in one streaming pass. The file is read in chunks
 * and never held in memory, so a multi gigabyte recording hashes in constant
 * space. A file that cannot be read is a `ConfigError` naming the path.
 */
export async function hashRecordingFile(path: string): Promise<RecordingHash> {
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  let lastByte = NEWLINE;
  try {
    for await (const chunk of createReadStream(path)) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      bytes += buffer.byteLength;
      for (let at = buffer.indexOf(NEWLINE); at >= 0; at = buffer.indexOf(NEWLINE, at + 1)) {
        lines += 1;
      }
      if (buffer.byteLength > 0) lastByte = buffer[buffer.byteLength - 1] as number;
    }
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  if (lastByte !== NEWLINE) lines += 1;
  return { sha256: hash.digest('hex'), bytes, lines };
}
