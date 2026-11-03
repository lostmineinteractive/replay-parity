import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { CaptureRulesSchema, Redactor, hashRedaction } from './capture-rules.js';
import { harToExchanges, importHarFile, parseHar } from './har.js';
import { readRecording, readRecordingManifest } from './reader.js';
import { REDACTED } from './redact.js';

function entry(over: {
  started: string;
  method?: string;
  url: string;
  status?: number;
  time?: number;
  reqHeaders?: { name: string; value: string }[];
  resHeaders?: { name: string; value: string }[];
  postData?: { mimeType?: string; text?: string };
  content?: { mimeType?: string; text?: string; encoding?: string };
}) {
  return {
    startedDateTime: over.started,
    time: over.time ?? 5,
    request: {
      method: over.method ?? 'GET',
      url: over.url,
      headers: over.reqHeaders ?? [],
      ...(over.postData === undefined ? {} : { postData: over.postData }),
    },
    response: {
      status: over.status ?? 200,
      headers: over.resHeaders ?? [],
      ...(over.content === undefined ? {} : { content: over.content }),
    },
  };
}

const har = parseHar({
  log: {
    version: '1.2',
    entries: [
      entry({
        started: '2026-11-01T10:00:00.500Z',
        url: 'https://h.test/v1/items/7?token=t&x=1&x=2',
        reqHeaders: [
          { name: ':path', value: '/v1/items/7' },
          { name: 'Authorization', value: 'Bearer z' },
          { name: 'Connection', value: 'close' },
        ],
        resHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Content-Encoding', value: 'br' },
          { name: 'Vary', value: 'a' },
          { name: 'Vary', value: 'b' },
        ],
        content: { mimeType: 'application/json', text: '{"id":"7","price":1.10}' },
        time: 8.25,
      }),
      entry({
        started: '2026-11-01T10:00:00.000Z',
        method: 'post',
        url: 'https://h.test/v1/items',
        postData: { mimeType: 'application/json', text: '{"name":"a"}' },
        status: 201,
        content: { mimeType: 'text/plain', text: 'aGk=', encoding: 'base64' },
      }),
      entry({ started: 'not a date', url: 'https://h.test/a' }),
      entry({ started: '2026-11-01T10:00:01.000Z', url: 'https://h.test/b', status: 0 }),
      entry({ started: '2026-11-01T10:00:01.000Z', url: 'not a url' }),
      entry({ started: '2026-11-01T10:00:01.000Z', url: 'https://h.test/same-ms-1' }),
      entry({ started: '2026-11-01T10:00:01.000Z', url: 'https://h.test/same-ms-2', time: -1 }),
    ],
  },
});

describe('harToExchanges', () => {
  const { exchanges, skipped, origin } = harToExchanges(har, {
    redactor: new Redactor(),
    tags: (method, path) => (method === 'POST' ? [`create:${path}`] : []),
  });

  it('orders by startedDateTime, keeps file order on ties, and skips what it cannot read', () => {
    expect(exchanges.map((e) => e.request.path)).toEqual([
      '/v1/items',
      '/v1/items/7',
      '/same-ms-1',
      '/same-ms-2',
    ]);
    expect(exchanges.map((e) => e.offset_ms)).toEqual([0, 500, 1000, 1000]);
    expect(skipped.map((s) => s.index)).toEqual([2, 3, 4]);
    expect(skipped[1]?.reason).toBe('no response (status 0)');
    expect(origin).toBe('https://h.test');
  });

  it('maps the request and response and applies the default redaction', () => {
    const [create, read] = exchanges;
    expect(create?.request).toMatchObject({ method: 'POST', body: { name: 'a' } });
    expect(create?.tags).toEqual(['create:/v1/items']);
    expect(create?.response).toMatchObject({ status: 201, body: 'aGk=', encoding: 'base64' });
    expect(read?.request.query).toEqual({ token: REDACTED, x: ['1', '2'] });
    expect(read?.request.headers).toEqual({ authorization: REDACTED });
    expect(read?.response.headers).toEqual({
      'content-type': 'application/json',
      'content-encoding': 'br',
      vary: 'a, b',
    });
    expect(read?.response).toMatchObject({
      latency_ms: 8.25,
      body: { id: '7', price: { $num: '1.10' } },
      content_encoding: 'br',
    });
    expect(exchanges[3]?.response.latency_ms).toBe(0);
    expect(read?.ts).toBe('2026-11-01T10:00:00.500Z');
  });

  it('gives the same ids every time and distinct ids within the file', () => {
    const again = harToExchanges(har, { redactor: new Redactor() }).exchanges;
    expect(again.map((e) => e.id)).toEqual(exchanges.map((e) => e.id));
    expect(new Set(exchanges.map((e) => e.id)).size).toBe(exchanges.length);
  });

  it('applies body rules from a capture rules file', () => {
    const rules = CaptureRulesSchema.parse({
      redact: { body: [{ path: '$.id', mode: 'hash' }] },
    });
    const [, read] = harToExchanges(har, { redactor: new Redactor({ rules, key: 'k' }) }).exchanges;
    expect((read?.response.body as { id: string }).id).toBe(hashRedaction('k', '7'));
  });

  it('caps a body over the limit to its hash and size', () => {
    const [create] = harToExchanges(har, { redactor: new Redactor(), maxBodyBytes: 4 }).exchanges;
    expect(create?.request).toMatchObject({ truncated: true, body_size: 12 });
  });

  it('refuses a file that is not HAR', () => {
    expect(() => parseHar({ entries: [] }, 'x.har')).toThrow(ConfigError);
    expect(() => parseHar({ log: { entries: [{ time: 1 }] } })).toThrow(/not a HAR file/);
  });
});

describe('importHarFile', () => {
  it('writes a recording with a manifest naming the source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-har-'));
    const path = join(dir, 'trace.har');
    await writeFile(path, JSON.stringify(har));
    const out = join(dir, 'out.jsonl.gz');
    const result = await importHarFile(path, out, {
      toolVersion: '2.0.0',
      createdAt: '2026-11-02T00:00:00.000Z',
      redactor: new Redactor(),
      redactedHeaders: ['authorization'],
      redactedQuery: ['token'],
      tagRuleTexts: ['POST /v1/items=create'],
    });
    expect(result.exchanges).toBe(4);
    expect(result.skipped).toHaveLength(3);
    expect(await readRecording(out)).toHaveLength(4);
    expect(await readRecordingManifest(out)).toMatchObject({
      tool_version: '2.0.0',
      created_at: '2026-11-02T00:00:00.000Z',
      target: 'https://h.test',
      tag_rules: ['POST /v1/items=create'],
      source: 'har:trace.har',
    });
  });

  it('names a file that is missing or not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-har-'));
    const options = {
      toolVersion: '1',
      redactor: new Redactor(),
      redactedHeaders: [],
      redactedQuery: [],
    };
    await expect(
      importHarFile(join(dir, 'none.har'), join(dir, 'o.jsonl'), options),
    ).rejects.toThrow(ConfigError);
    const bad = join(dir, 'bad.har');
    await writeFile(bad, gzipSync('{}'));
    await expect(importHarFile(bad, join(dir, 'o.jsonl'), options)).rejects.toThrow(bad);
  });
});
