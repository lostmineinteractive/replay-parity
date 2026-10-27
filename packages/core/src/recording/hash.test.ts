import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeExchange } from '../testing.js';
import { ConfigError } from '../yaml.js';
import { RECORDING_SHA256_PATTERN, hashRecordingFile } from './hash.js';

const DEMO_RECORDING = resolve(import.meta.dirname, '../../../../demo/recording.jsonl');

/** The committed demo recording. Pinned so a change to the file is noticed. */
const DEMO_SHA256 = '7cda06869f89dfd093a305fe21162d2f499bd809cf2ac852dc0189124d438503';

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'rp-hash-')), name);
  await writeFile(path, content);
  return path;
}

describe('hashRecordingFile', () => {
  it('hashes an empty file', async () => {
    const path = await tempFile('empty.jsonl', '');
    expect(await hashRecordingFile(path)).toEqual({
      sha256: createHash('sha256').digest('hex'),
      bytes: 0,
      lines: 0,
    });
  });

  it('hashes a one line file, newline included', async () => {
    const line = `${JSON.stringify(makeExchange())}\n`;
    const path = await tempFile('one.jsonl', line);
    const result = await hashRecordingFile(path);
    expect(result).toEqual({
      sha256: createHash('sha256').update(line).digest('hex'),
      bytes: Buffer.byteLength(line),
      lines: 1,
    });
    expect(result.sha256).toMatch(RECORDING_SHA256_PATTERN);
  });

  it('counts a final line without a trailing newline and distinguishes it from one with', async () => {
    const line = JSON.stringify(makeExchange());
    const bare = await hashText(`${line}\n${line}`);
    const ended = await hashText(`${line}\n${line}\n`);
    expect(bare.lines).toBe(2);
    expect(ended.lines).toBe(2);
    expect(bare.sha256).not.toBe(ended.sha256);
    expect(ended.bytes).toBe(bare.bytes + 1);
  });

  it('pins the hash of the committed demo recording', async () => {
    expect(await hashRecordingFile(DEMO_RECORDING)).toEqual({
      sha256: DEMO_SHA256,
      bytes: 240_956,
      lines: 283,
    });
  });

  it('streams a file larger than one read chunk', async () => {
    const line = `${JSON.stringify(makeExchange())}\n`;
    const content = line.repeat(2000);
    const path = await tempFile('big.jsonl', content);
    expect(await hashRecordingFile(path)).toEqual({
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      lines: 2000,
    });
  });

  it('names the path when the file cannot be read', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'rp-hash-')), 'missing.jsonl');
    await expect(hashRecordingFile(missing)).rejects.toThrow(ConfigError);
    await expect(hashRecordingFile(missing)).rejects.toThrow(missing);
  });
});

async function hashText(
  content: string,
): Promise<{ sha256: string; bytes: number; lines: number }> {
  return hashRecordingFile(await tempFile('f.jsonl', content));
}
