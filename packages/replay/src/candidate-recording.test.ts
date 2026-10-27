import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REDACTED,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseRecordingText,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import {
  candidateExchanges,
  writeCandidateRecording,
  type SentExchange,
} from './candidate-recording.js';

function sent(index: number, over: Partial<SentExchange> = {}): SentExchange {
  return {
    exchange: makeExchange({ index, tags: ['get-order'] }),
    request: makeRequest({
      path: `/v1/orders/c-${index}`,
      query: { api_key: 'k-1', Token: 't-1', page: '2', tag: ['a', 'b'] },
      headers: { authorization: 'Bearer x', accept: 'application/json' },
    }),
    response: jsonResponse({ ok: true }, 200, 4.25),
    sentAtMs: 100 + index * 10,
    sentWallMs: Date.parse('2026-10-16T18:00:00.000Z') + index * 10,
    ...over,
  };
}

describe('candidateExchanges', () => {
  it('writes the request as sent with the default query and header redaction', () => {
    const [first, second] = candidateExchanges({
      sent: [sent(2), sent(1)],
      adapter: 'http',
      redactHeaders: ['authorization'],
    });
    expect(first?.id).toBe(makeExchange({ index: 1 }).id);
    expect(first?.offset_ms).toBe(0);
    expect(second?.offset_ms).toBe(10);
    expect(first?.request.path).toBe('/v1/orders/c-1');
    expect(first?.request.query).toEqual({
      api_key: REDACTED,
      Token: REDACTED,
      page: '2',
      tag: ['a', 'b'],
    });
    expect(first?.request.headers).toEqual({
      authorization: REDACTED,
      accept: 'application/json',
    });
    expect(first?.response).toMatchObject({ status: 200, latency_ms: 4.25, body: { ok: true } });
    expect(first?.tags).toEqual(['get-order']);
  });

  it('honors a custom query list and leaves out failed sends', () => {
    const exchanges = candidateExchanges({
      sent: [sent(1), sent(2, { response: null })],
      adapter: 'http',
      redactHeaders: [],
      redactQuery: ['tag'],
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.request.query).toEqual({
      api_key: 'k-1',
      Token: 't-1',
      page: '2',
      tag: [REDACTED, REDACTED],
    });
  });
});

describe('writeCandidateRecording', () => {
  it('writes a recording that parses back with the query redacted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-candidate-'));
    const path = join(dir, 'candidate.jsonl');
    const count = await writeCandidateRecording(path, {
      sent: [sent(1)],
      adapter: 'http',
      redactHeaders: ['authorization'],
    });
    expect(count).toBe(1);
    const [written] = parseRecordingText(await readFile(path, 'utf8'));
    expect(written?.request.query.api_key).toBe(REDACTED);
    expect(written?.request.query.page).toBe('2');
  });
});
