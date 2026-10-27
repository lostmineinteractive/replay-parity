import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, hashRecordingFile, makeExchange, makeRun } from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyRecordingHash } from './shrink.js';

let recording: string;
let other: string;
let sha256: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rp-shrink-hash-'));
  recording = join(dir, 'recording.jsonl');
  other = join(dir, 'other.jsonl');
  await writeFile(recording, `${JSON.stringify(makeExchange({ index: 0 }))}\n`);
  await writeFile(other, `${JSON.stringify(makeExchange({ index: 1 }))}\n`);
  sha256 = (await hashRecordingFile(recording)).sha256;
});

describe('verifyRecordingHash', () => {
  it('accepts the file the run replayed', async () => {
    const run = makeRun({ recording: { ...makeRun().recording, recording_sha256: sha256 } });
    expect(await verifyRecordingHash({ run, recording })).toEqual({
      expected: sha256,
      actual: sha256,
      mismatch: false,
    });
  });

  it('accepts any file when the run has no hash, null or absent', async () => {
    const withNull = makeRun();
    expect(withNull.recording.recording_sha256).toBeNull();
    expect(await verifyRecordingHash({ run: withNull, recording: other })).toMatchObject({
      expected: null,
      mismatch: false,
    });
    const { recording_sha256: _hash, ...rest } = withNull.recording;
    const absent = { ...withNull, recording: rest };
    expect(await verifyRecordingHash({ run: absent, recording: other })).toMatchObject({
      expected: null,
      mismatch: false,
    });
  });

  it('refuses a different file and names both hashes', async () => {
    const run = makeRun({ recording: { ...makeRun().recording, recording_sha256: sha256 } });
    const actual = (await hashRecordingFile(other)).sha256;
    await expect(verifyRecordingHash({ run, recording: other })).rejects.toThrow(ConfigError);
    await expect(verifyRecordingHash({ run, recording: other })).rejects.toThrow(
      `${other} is not the recording the run replayed: the run recorded sha256 ${sha256} and the file has ${actual}`,
    );
    await expect(verifyRecordingHash({ run, recording: other })).rejects.toThrow(
      '--allow-recording-mismatch',
    );
  });

  it('reports the mismatch instead when allowed', async () => {
    const run = makeRun({ recording: { ...makeRun().recording, recording_sha256: sha256 } });
    const actual = (await hashRecordingFile(other)).sha256;
    expect(await verifyRecordingHash({ run, recording: other, allowMismatch: true })).toEqual({
      expected: sha256,
      actual,
      mismatch: true,
    });
  });

  it('names a file that cannot be read', async () => {
    const missing = join(tmpdir(), 'rp-shrink-hash-missing', 'nope.jsonl');
    await expect(verifyRecordingHash({ run: makeRun(), recording: missing })).rejects.toThrow(
      ConfigError,
    );
    await expect(verifyRecordingHash({ run: makeRun(), recording: missing })).rejects.toThrow(
      missing,
    );
  });
});
