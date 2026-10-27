import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REDACTED,
  jsonResponse,
  makeRequest,
  readRecording,
  type KeptCase,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import type { SideResult } from './execute.js';
import { casesToExchanges, writeCaseRecording, type KeptExecution } from './export-recording.js';

function kept(id: string, tags: string[], steps: number): KeptCase {
  return {
    id,
    round: 1,
    hypothesis: 'h',
    tags,
    steps: Array.from({ length: steps }, () => ({ request: makeRequest() })),
    repeat: 1,
    dedupe_key: 'mismatch:$.total',
    reference: { status: 200, latency_ms: 1 },
    candidate: { status: 200, latency_ms: 1 },
    latency: null,
    error: null,
    diff: null,
    latency_breach: null,
    revealed: 'r',
  };
}

function side(latencies: number[]): SideResult {
  return {
    requests: latencies.map((_, i) =>
      makeRequest({
        method: 'POST',
        path: `/v1/orders/${i}`,
        headers: { authorization: REDACTED, 'content-type': 'application/json' },
        body: { step: i },
      }),
    ),
    responses: latencies.map((ms, i) => jsonResponse({ order_id: `o-${i}` }, 201, ms)),
    captures: new Map(),
    latencies: [latencies[latencies.length - 1] ?? 0],
    error: null,
  };
}

const executions: KeptExecution[] = [
  { kept: kept('case-1-1', ['create-order'], 2), reference: side([5.5, 2]) },
  { kept: kept('case-1-2', ['get-order'], 1), reference: side([10]) },
];

describe('casesToExchanges', () => {
  it('writes one exchange per step in case order with offsets that grow by the reference latency', () => {
    const exchanges = casesToExchanges('2026-10-20T12:00:00.000Z', executions);
    expect(exchanges.map((e) => e.id)).toEqual(['case-1-1:1', 'case-1-1:2', 'case-1-2:1']);
    expect(exchanges.map((e) => e.offset_ms)).toEqual([0, 5.5, 7.5]);
    expect(exchanges.map((e) => e.ts)).toEqual([
      '2026-10-20T12:00:00.000Z',
      '2026-10-20T12:00:00.005Z',
      '2026-10-20T12:00:00.007Z',
    ]);
    expect(exchanges.map((e) => e.tags)).toEqual([
      ['create-order', 'agent:case-1-1'],
      ['create-order', 'agent:case-1-1'],
      ['get-order', 'agent:case-1-2'],
    ]);
    expect(exchanges.every((e) => e.adapter === 'http')).toBe(true);
    // The request keeps the redaction marker and the response is the reference's.
    expect(exchanges[0]?.request.headers.authorization).toBe(REDACTED);
    expect(exchanges[0]?.request.body).toEqual({ step: 0 });
    expect(exchanges[1]?.response.body).toEqual({ order_id: 'o-1' });
    expect(exchanges[2]?.response.latency_ms).toBe(10);
    expect(casesToExchanges('2026-10-20T12:00:00.000Z', [])).toEqual([]);
  });
});

describe('writeCaseRecording', () => {
  it('writes a recording that reads back, replacing what was there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-export-'));
    const path = join(dir, 'agent-cases.jsonl');
    await writeFile(path, 'stale line\n', 'utf8');
    const exchanges = casesToExchanges('2026-10-20T12:00:00.000Z', executions);
    expect(await writeCaseRecording(path, exchanges)).toBe(3);
    const back = await readRecording(path);
    expect(back).toEqual(exchanges);
    expect((await readFile(path, 'utf8')).split('\n').filter((l) => l.length > 0)).toHaveLength(3);
    expect(await writeCaseRecording(path, [])).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('');
  });
});
