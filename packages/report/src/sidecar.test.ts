import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, makeExchangeResult, makeRun } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { readExchangesSidecar, sidecarLocation, withSidecarExchanges } from './sidecar.js';

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-report-sidecar-'));
}

const results = [makeExchangeResult({ id: 'a' }), makeExchangeResult({ id: 'b' })];
const lines = results.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('readExchangesSidecar', () => {
  it('reads every result in order and skips blank lines', async () => {
    const path = join(await dir(), 'run.exchanges.jsonl');
    await writeFile(path, `${lines}\n`);
    expect(await readExchangesSidecar(path)).toEqual(results);
  });

  it('names the file and line of a bad result', async () => {
    const path = join(await dir(), 'run.exchanges.jsonl');
    await writeFile(path, `${JSON.stringify(results[0])}\n{"id":""}\n`);
    await expect(readExchangesSidecar(path)).rejects.toThrow(ConfigError);
    await expect(readExchangesSidecar(path)).rejects.toThrow(/run\.exchanges\.jsonl line 2: /);
    await writeFile(path, '{oops\n');
    await expect(readExchangesSidecar(path)).rejects.toThrow(/line 1: invalid JSON/);
    await expect(readExchangesSidecar(join(await dir(), 'none.jsonl'))).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('withSidecarExchanges', () => {
  it('replaces the kept exchanges with the sidecar, relative to the run file', async () => {
    const root = await dir();
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'run.exchanges.jsonl'), lines);
    const run = makeRun({ exchanges: [], exchanges_path: 'run.exchanges.jsonl' });
    const runPath = join(root, 'out', 'run.json');
    expect(sidecarLocation(run, runPath)).toBe(join(root, 'out', 'run.exchanges.jsonl'));
    const loaded = await withSidecarExchanges(run, runPath);
    expect(loaded.sidecar).toBe('read');
    expect(loaded.run.exchanges).toEqual(results);
  });

  it('leaves a run without a sidecar alone and reports a missing one', async () => {
    const plain = makeRun();
    expect(await withSidecarExchanges(plain, 'run.json')).toEqual({
      run: plain,
      sidecar: 'none',
      path: null,
    });
    const root = await dir();
    const absent = makeRun({ exchanges_path: join(root, 'gone.jsonl') });
    const loaded = await withSidecarExchanges(absent, join(root, 'run.json'));
    expect(loaded).toMatchObject({ sidecar: 'missing', path: join(root, 'gone.jsonl') });
    expect(loaded.run).toBe(absent);
  });
});
