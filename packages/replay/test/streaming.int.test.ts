import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  type ExchangeResult,
  type Run,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { replay, type Adapter } from '../src/index.js';
import { tempDir, writeRecording } from './helpers.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

/** Answers every request at once and gets every third one wrong, at a path by its tag. */
const wrongEveryThird: Adapter = {
  name: 'fake',
  send(req) {
    const i = Number(req.path.split('/').pop());
    const body =
      i % 3 === 0 ? { items: [{ sku: 'wrong' }], n: i } : { items: [{ sku: 'a' }], n: i };
    return Promise.resolve(jsonResponse(body, 200, 1));
  },
};

/** Recorded as overlapping, so the replay may keep many in flight. */
function overlapping(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeExchange({
      index: i,
      tags: [i % 2 === 0 ? 'even' : 'odd'],
      request: makeRequest({ path: `/n/${i}` }),
      response: jsonResponse({ items: [{ sku: 'a' }], n: i }, 200, 10_000),
    }),
  );
}

async function readLines(path: string): Promise<ExchangeResult[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ExchangeResult);
}

/** The fields of a result that do not depend on timing. */
function stable(r: ExchangeResult) {
  return { id: r.id, verdict: r.diff?.verdict, findings: r.diff?.findings, error: r.error };
}

describe('the exchanges sidecar', () => {
  it('streams every result to the sidecar and keeps a sample of the mismatches in the run', async () => {
    const dir = await tempDir();
    const recording = await writeRecording(overlapping(90), dir);
    const inline = await replay({
      recording,
      target: 'fake://',
      adapter: wrongEveryThird,
      pace: 'max',
    });
    const exchangesPath = join(dir, 'run.exchanges.jsonl');
    const run = await replay({
      recording,
      target: 'fake://',
      adapter: wrongEveryThird,
      pace: 'max',
      exchangesPath,
      exchangesSidecar: 'always',
    });
    expect(inline.exchanges_path).toBeNull();
    expect(inline.exchanges).toHaveLength(90);
    expect(run.exchanges_path).toBe(exchangesPath);
    const lines = await readLines(exchangesPath);
    expect(lines.map(stable)).toEqual(inline.exchanges.map(stable));
    // Thirty mismatches at one generalized path, $.items[*].sku: the run keeps the first 20.
    expect(run.exchanges).toHaveLength(20);
    expect(run.exchanges.map((e) => e.id)).toEqual(
      inline.exchanges
        .filter((e) => e.diff?.verdict === 'mismatch')
        .slice(0, 20)
        .map((e) => e.id),
    );
    expect(run.verdict).toBe(inline.verdict);
    expect(run.stats.overall).toMatchObject({ count: 90, mismatches: 30, matches: 60 });
    expect(run.stats.by_tag).toEqual(inline.stats.by_tag);
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('keeps the results in the run below the threshold under auto and when told never', async () => {
    const dir = await tempDir();
    const recording = await writeRecording(overlapping(10), dir);
    for (const mode of ['auto', 'never'] as const) {
      const run = await replay({
        recording,
        target: 'fake://',
        adapter: wrongEveryThird,
        pace: 'max',
        exchangesPath: join(dir, `${mode}.jsonl`),
        exchangesSidecar: mode,
      });
      expect(run.exchanges_path).toBeNull();
      expect(run.exchanges).toHaveLength(10);
    }
    await expect(
      replay({
        recording,
        target: 'fake://',
        adapter: wrongEveryThird,
        exchangesSidecar: 'always',
      }),
    ).rejects.toThrow(/needs a path/);
  });
});

describe('the read window', () => {
  it('replays the same results through a window of one, at the cost of overlap', async () => {
    let inflight = 0;
    let peak = 0;
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(2);
        inflight -= 1;
        return wrongEveryThird.send(req, undefined as never);
      },
    };
    const recording = await writeRecording(overlapping(12));
    const wide = await replay({
      recording,
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
    });
    expect(peak).toBe(4);
    peak = 0;
    const narrow = await replay({
      recording,
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 4,
      window: 1,
    });
    // Nothing is read past the oldest exchange not yet acknowledged, so one is in flight.
    expect(peak).toBe(1);
    expect(narrow.exchanges.map(stable)).toEqual(wide.exchanges.map(stable));
    await expect(replay({ recording, target: 'fake://', adapter, window: 0 })).rejects.toThrow(
      /--window must be a positive integer/,
    );
  });
});

/** Returns the `gc` function, exposing it in this worker when the process was started without it. */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

// A slow test: it writes and replays 200000 exchanges, so it lives in the integration project.
describe('slow: streaming memory', () => {
  it('replays 200000 exchanges with the heap bounded by the window, not the recording', async () => {
    const gc = collector();
    const dir = await tempDir();
    const recording = join(dir, 'large.jsonl');
    const total = 200_000;
    const out = createWriteStream(recording);
    const base = Date.UTC(2026, 9, 16);
    for (let i = 0; i < total; i += 1) {
      const line = JSON.stringify({
        id: `01M537PG${String(i).padStart(18, '0')}`,
        ts: new Date(base + i).toISOString(),
        offset_ms: i,
        adapter: 'http',
        request: {
          method: 'GET',
          path: `/v1/items/${i}`,
          query: {},
          headers: { accept: 'application/json' },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          latency_ms: 50,
          body: { id: i, name: `item ${i}`, note: 'x'.repeat(200) },
        },
        tags: [`t${i % 5}`],
      });
      if (!out.write(`${line}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    // Answers after a timer, so sends stay in flight and the reader fills its window.
    const adapter: Adapter = {
      name: 'fake',
      async send(req) {
        await sleep(1);
        const i = Number(req.path.split('/').pop());
        return jsonResponse({ id: i, name: `item ${i}`, note: 'x'.repeat(200) }, 200, 1);
      },
    };
    gc();
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const run: Run = await replay({
      recording,
      target: 'fake://',
      adapter,
      pace: 'max',
      concurrency: 128,
      exchangesPath: join(dir, 'large.exchanges.jsonl'),
      onProgress(p) {
        if (p.completed % 10_000 === 0) {
          gc();
          peak = Math.max(peak, process.memoryUsage().heapUsed - before);
        }
      },
    });
    expect(run.stats.overall.count).toBe(total);
    expect(run.stats.overall.matches).toBe(total);
    // Over 50000 results the sidecar is on by default and the run keeps no matched exchange.
    expect(run.exchanges_path).toBe(join(dir, 'large.exchanges.jsonl'));
    expect(run.exchanges).toHaveLength(0);
    // The heap after a collection is measured every 10000 acknowledgements. On a quiet machine
    // the peak growth was about 18 MB: a full window of 10000 exchanges of about 1 KB each with
    // their slots and results, and 8 bytes of slip per exchange. Reading the same recording into
    // memory took about 208 MB. A leak of about 270 bytes per exchange, a reaction left on a
    // promise that lived as long as the run, measured 66 MB here before it was fixed, so the
    // bound sits between the two with room for the collector's own variation.
    expect(peak).toBeLessThan(48 * 1024 * 1024);
  });
});
