import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { jsonResponse, makeExchange, makeRequest, parseRun } from '@replay-parity/core';
import { RedisStreamsBus, serveBus } from '@replay-parity/replay';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(args: string[]): Promise<{ code: number; err: string }> {
  const stderr = new Sink();
  const code = await runCli(args, { stdout: new Sink(), stderr });
  return { code, err: stderr.text };
}

async function recordingFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-bus-group-'));
  const path = join(dir, 'recording.jsonl');
  const exchange = makeExchange({
    request: makeRequest({ path: '/v1/items' }),
    response: jsonResponse({ items: [1] }),
  });
  await writeFile(path, `${JSON.stringify(exchange)}\n`);
  return path;
}

const REDIS_URL = process.env.REDIS_URL;

describe('rp replay --bus-group and --bus-consumer', () => {
  it('refuses a consumer name without a group before it connects', async () => {
    const recording = await recordingFile();
    const result = await rp([
      'replay',
      '--recording',
      recording,
      '--target',
      'bus://test',
      '--no-preflight',
      '--adapter',
      'bus',
      '--bus-url',
      'redis://127.0.0.1:1',
      '--bus-consumer',
      'worker-1',
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('a consumer name needs a consumer group');
  });

  it.skipIf(REDIS_URL === undefined || REDIS_URL === '')(
    'replays through a consumer group when REDIS_URL is set',
    async () => {
      const url = REDIS_URL as string;
      const recording = await recordingFile();
      const responderBus = await RedisStreamsBus.connect(url, {
        blockMs: 100,
        group: `rp-test-${Date.now()}`,
        consumer: 'responder',
      });
      const stop = await serveBus(responderBus, 'rp.requests.v1', () => ({
        status: 200,
        body: { items: [1] },
      }));
      try {
        const out = join(await mkdtemp(join(tmpdir(), 'rp-bus-group-out-')), 'run.json');
        const result = await rp([
          'replay',
          '--recording',
          recording,
          '--target',
          'bus://test',
          '--out',
          out,
          '--pace',
          'max',
          '--quiet',
          '--no-preflight',
          '--adapter',
          'bus',
          '--bus-url',
          url,
          '--bus-group',
          `rp-replies-${Date.now()}`,
          '--bus-consumer',
          'replay-1',
        ]);
        expect(result.code).toBe(0);
        expect(parseRun(await readFile(out, 'utf8')).adapter).toBe('bus');
      } finally {
        await stop();
        await responderBus.close();
      }
    },
  );
});
