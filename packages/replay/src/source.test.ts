import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RecordingParseError,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  type Exchange,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { fileSource, memorySource, type ExchangeSource, type SelectionOptions } from './source.js';

const rules = parseDiffRules(
  'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
).substitutions;

/** Two creates, reads of each, and unrelated listings, in recording order. */
const exchanges: Exchange[] = [
  makeExchange({
    index: 0,
    tags: ['create-order'],
    request: makeRequest({ method: 'POST', path: '/orders' }),
    response: jsonResponse({ order_id: 'o-1' }, 201),
  }),
  makeExchange({ index: 1, tags: ['list'], request: makeRequest({ path: '/orders' }) }),
  makeExchange({
    index: 2,
    tags: ['create-order'],
    request: makeRequest({ method: 'POST', path: '/orders' }),
    response: jsonResponse({ order_id: 'o-2' }, 201),
  }),
  makeExchange({ index: 3, tags: ['get-order'], request: makeRequest({ path: '/orders/o-2' }) }),
  makeExchange({ index: 4, tags: ['list'], request: makeRequest({ path: '/orders' }) }),
  makeExchange({ index: 5, tags: ['get-order'], request: makeRequest({ path: '/orders/o-1' }) }),
];

async function file(lines: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'rp-source-')), 'recording.jsonl');
  await writeFile(path, lines);
  return path;
}

async function drain(source: ExchangeSource): Promise<[string, boolean][]> {
  const out: [string, boolean][] = [];
  for await (const item of source.pass()) out.push([item.exchange.id, item.dependency]);
  return out;
}

const cases: [string, SelectionOptions][] = [
  ['everything', { filterTag: null, limit: null, includeDependencies: true, rules }],
  ['a limit', { filterTag: null, limit: 4, includeDependencies: true, rules }],
  [
    'a filter with dependencies',
    { filterTag: 'get-order', limit: null, includeDependencies: true, rules },
  ],
  ['a filter with a limit', { filterTag: 'get-order', limit: 1, includeDependencies: true, rules }],
  [
    'a filter without dependencies',
    { filterTag: 'get-order', limit: null, includeDependencies: false, rules },
  ],
  [
    'a filter that matches nothing',
    { filterTag: 'nothing', limit: null, includeDependencies: true, rules },
  ],
];

describe('sources', () => {
  it.each(cases)(
    'select the same exchanges from a file and from memory with %s',
    async (_, options) => {
      const path = await file(exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const fromFile = await fileSource(path, options);
      const fromMemory = memorySource(exchanges, options);
      for (const source of [fromFile, fromMemory]) {
        expect(source.exchanges).toBe(6);
        expect(source.first_ts).toBe(exchanges[0]?.ts);
        expect(source.last_ts).toBe(exchanges[5]?.ts);
      }
      expect(fromFile.selected).toBe(fromMemory.selected);
      expect(fromFile.dependencies).toBe(fromMemory.dependencies);
      const selected = await drain(fromMemory);
      expect(await drain(fromFile)).toEqual(selected);
      // A second pass reads the file again and gives the same selection.
      expect(await drain(fromFile)).toEqual(selected);
      expect(selected).toHaveLength(fromFile.selected);
    },
  );

  it('pulls in the producers of a filtered read, transitively, and marks them', async () => {
    const source = memorySource(exchanges, cases[2]![1]);
    expect(await drain(source)).toEqual([
      [exchanges[0]!.id, true],
      [exchanges[2]!.id, true],
      [exchanges[3]!.id, false],
      [exchanges[5]!.id, false],
    ]);
    expect(source.dependencies).toBe(2);
  });

  it('refuses a recording that does not parse before any pass', async () => {
    const path = await file(`${JSON.stringify(exchanges[0])}\n{broken\n`);
    await expect(fileSource(path, cases[0]![1])).rejects.toThrow(RecordingParseError);
  });

  it('reads an empty recording as nothing selected', async () => {
    const source = await fileSource(await file(''), cases[0]![1]);
    expect(source).toMatchObject({ exchanges: 0, selected: 0, first_ts: null, last_ts: null });
    expect(await drain(source)).toEqual([]);
  });
});
