import { resolve } from 'node:path';
import {
  compileRunValidator,
  hashRecordingFile,
  parseRun,
  readRecording,
  serializeRun,
  type RecordedRequest,
  type RecordedResponse,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { replay, replayExchanges, type Adapter } from '../src/index.js';

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');

/** Answers every request with one fixed response, so no server is needed. */
const stub: Adapter = {
  name: 'stub',
  send: (_req: RecordedRequest): Promise<RecordedResponse> =>
    Promise.resolve({ status: 200, headers: {}, latency_ms: 1, body: {} }),
};

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

describe('the recording hash in the run', () => {
  it('records the sha256 of the file replay read', async () => {
    const { sha256 } = await hashRecordingFile(RECORDING);
    const run = await replay({
      recording: RECORDING,
      target: 'http://stub',
      adapter: stub,
      pace: 'max',
      limit: 3,
    });
    expect(run.recording.recording_sha256).toBe(sha256);
    expect(run.recording).toMatchObject({ path: RECORDING, exchanges: 283, selected: 3 });
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(parseRun(serializeRun(run)).recording.recording_sha256).toBe(sha256);
  });

  it('has no hash when the exchanges were given in memory', async () => {
    const exchanges = (await readRecording(RECORDING)).slice(0, 3);
    const run = await replayExchanges(exchanges, {
      recording: 'in memory',
      target: 'http://stub',
      adapter: stub,
      pace: 'max',
    });
    expect(run.recording.recording_sha256).toBeUndefined();
    expect(validate(run), validate.errors ?? '').toBe(true);
    expect(parseRun(serializeRun(run)).recording.recording_sha256).toBeUndefined();
  });
});
