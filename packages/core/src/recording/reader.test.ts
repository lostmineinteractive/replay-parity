import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeExchange } from '../testing.js';
import {
  RecordingParseError,
  iterateRecording,
  parseExchangeLine,
  parseRecordingText,
  readRecording,
} from './reader.js';

const line = (index: number, offset = index * 100): string =>
  JSON.stringify(makeExchange({ index, offset_ms: offset }));

describe('parseRecordingText', () => {
  it('parses every line and skips blank lines', () => {
    const text = `${line(0)}\n\n${line(1)}\n   \n${line(2)}\n`;
    const exchanges = parseRecordingText(text);
    expect(exchanges.map((e) => e.offset_ms)).toEqual([0, 100, 200]);
  });

  it('reports the line number of invalid JSON', () => {
    const text = `${line(0)}\n{not json\n`;
    expect(() => parseRecordingText(text)).toThrow(RecordingParseError);
    expect(() => parseRecordingText(text)).toThrow(/recording line 2: invalid JSON/);
  });

  it('reports the line number and path of a schema violation', () => {
    const bad = JSON.parse(line(1)) as { response: { status: number } };
    bad.response.status = 99;
    const text = `${line(0)}\n${JSON.stringify(bad)}\n`;
    expect(() => parseRecordingText(text)).toThrow(/recording line 2: .*response\.status/);
  });

  it('rejects a decreasing offset', () => {
    const text = `${line(0, 500)}\n${line(1, 400)}\n`;
    expect(() => parseRecordingText(text)).toThrow(
      /line 2: offset_ms 400 is lower than the previous offset 500/,
    );
  });

  it('accepts an equal offset', () => {
    expect(parseRecordingText(`${line(0, 5)}\n${line(1, 5)}\n`)).toHaveLength(2);
  });
});

describe('parseExchangeLine', () => {
  it('exposes the line number on the error', () => {
    try {
      parseExchangeLine('[]', 7);
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecordingParseError);
      expect((err as RecordingParseError).line).toBe(7);
    }
  });
});

describe('file readers', () => {
  it('streams and collects a file, including CRLF line endings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-rec-'));
    const path = join(dir, 'r.jsonl');
    await writeFile(path, `${line(0)}\r\n${line(1)}\r\n`);
    const streamed: number[] = [];
    for await (const e of iterateRecording(path)) streamed.push(e.offset_ms);
    expect(streamed).toEqual([0, 100]);
    expect((await readRecording(path)).map((e) => e.id)).toHaveLength(2);
  });

  it('propagates parse errors from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-rec-'));
    const path = join(dir, 'bad.jsonl');
    await writeFile(path, `${line(0)}\noops\n`);
    await expect(readRecording(path)).rejects.toThrow(/line 2/);
  });
});
