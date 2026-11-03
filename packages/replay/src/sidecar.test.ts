import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeExchangeResult, type ExchangeResult } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  MismatchSample,
  NO_PATH,
  SidecarWriter,
  generalizePath,
  sidecarPathFor,
} from './sidecar.js';

function mismatch(id: string, path: string | null, over: Partial<ExchangeResult> = {}) {
  return makeExchangeResult({
    id,
    diff: {
      verdict: 'mismatch',
      findings:
        path === null
          ? [{ path: '$.x', kind: 'value', tolerated: true, rule: 'ignore[0]' }]
          : [
              { path: '$.ok', kind: 'value', tolerated: true, rule: 'ignore[0]' },
              { path, kind: 'value', tolerated: false },
            ],
    },
    ...over,
  });
}

describe('sidecarPathFor', () => {
  it('puts the sidecar next to the run file', () => {
    expect(sidecarPathFor('out/run.json')).toBe('out/run.exchanges.jsonl');
    expect(sidecarPathFor('run')).toBe('run.exchanges.jsonl');
  });
});

describe('generalizePath', () => {
  it('folds array positions', () => {
    expect(generalizePath('$.items[3].sku')).toBe('$.items[*].sku');
  });
});

describe('MismatchSample', () => {
  it('keeps the first mismatches of each generalized path, in run order', () => {
    const sample = new MismatchSample(2);
    sample.add(mismatch('a', '$.items[0].sku'));
    sample.add(makeExchangeResult({ id: 'match' }));
    sample.add(mismatch('b', '$.items[1].sku'));
    sample.add(mismatch('c', '$.total'));
    sample.add(mismatch('d', '$.items[2].sku'));
    sample.add(mismatch('e', null));
    sample.add(mismatch('control', '$.total', { control: true }));
    sample.add(mismatch('f', '$.total'));
    sample.add(mismatch('g', '$.total'));
    expect(sample.list().map((r) => r.id)).toEqual(['a', 'b', 'c', 'e', 'f']);
    expect(NO_PATH).toBe('(no untolerated finding)');
  });
});

describe('SidecarWriter', () => {
  it('writes results as JSON Lines in order and counts bytes and lines', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'rp-sidecar-')), 'run.exchanges.jsonl');
    const writer = await SidecarWriter.open(path);
    const results = Array.from({ length: 300 }, (_, i) => makeExchangeResult({ id: `r${i}` }));
    for (const r of results) writer.write(r);
    await writer.flush();
    const text = await readFile(path, 'utf8');
    expect(Buffer.byteLength(text)).toBe(writer.bytes);
    expect(writer.lines).toBe(300);
    await writer.close();
    const ids = text
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as ExchangeResult).id);
    expect(ids).toEqual(results.map((r) => r.id));
  });

  it('keeps the first bytes of a file and appends after them on resume', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'rp-sidecar-')), 'run.exchanges.jsonl');
    const first = await SidecarWriter.open(path);
    first.write(makeExchangeResult({ id: 'kept' }));
    await first.flush();
    const keep = { bytes: first.bytes, lines: first.lines };
    first.write(makeExchangeResult({ id: 'dropped' }));
    await first.close();
    const resumed = await SidecarWriter.open(path, keep);
    expect(resumed.lines).toBe(1);
    resumed.write(makeExchangeResult({ id: 'after' }));
    await resumed.close();
    const ids = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as ExchangeResult).id);
    expect(ids).toEqual(['kept', 'after']);
  });
});
