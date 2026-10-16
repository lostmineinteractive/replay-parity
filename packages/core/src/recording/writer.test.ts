import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeExchange } from '../testing.js';
import { parseRecordingText } from './reader.js';
import { RecordingWriter } from './writer.js';

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'rp-writer-')), 'out.jsonl');
}

describe('RecordingWriter', () => {
  it('writes one line per exchange and round trips through the reader', async () => {
    const path = await tempPath();
    const writer = await RecordingWriter.open(path);
    expect(writer.path).toBe(path);
    await writer.write(makeExchange({ index: 0 }));
    await writer.write(makeExchange({ index: 1 }));
    expect(writer.count).toBe(2);
    await writer.close();
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRecordingText(text)).toHaveLength(2);
  });

  it('appends by default and truncates when asked', async () => {
    const path = await tempPath();
    const first = await RecordingWriter.open(path);
    await first.write(makeExchange({ index: 0 }));
    await first.close();
    const second = await RecordingWriter.open(path);
    await second.write(makeExchange({ index: 1 }));
    await second.close();
    expect(parseRecordingText(await readFile(path, 'utf8'))).toHaveLength(2);
    const third = await RecordingWriter.open(path, { append: false });
    await third.write(makeExchange({ index: 5 }));
    await third.close();
    expect(parseRecordingText(await readFile(path, 'utf8'))).toHaveLength(1);
  });

  it('rejects a decreasing offset and writes after close', async () => {
    const path = await tempPath();
    const writer = await RecordingWriter.open(path);
    await writer.write(makeExchange({ index: 0, offset_ms: 50 }));
    await expect(writer.write(makeExchange({ index: 1, offset_ms: 40 }))).rejects.toThrow(
      /lower than/,
    );
    await writer.close();
    await writer.close();
    await expect(writer.write(makeExchange({ index: 2, offset_ms: 60 }))).rejects.toThrow(/closed/);
  });

  it('keeps write order under concurrent calls and flushes', async () => {
    const path = await tempPath();
    const writer = await RecordingWriter.open(path);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writer.write(makeExchange({ index: i }))),
    );
    await writer.flush();
    const text = await readFile(path, 'utf8');
    expect(parseRecordingText(text).map((e) => e.offset_ms)).toEqual(
      Array.from({ length: 20 }, (_, i) => i * 100),
    );
    await writer.close();
  });
});
