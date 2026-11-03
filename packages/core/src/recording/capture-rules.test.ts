import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { makeExchange, makeRequest, makeResponse } from '../testing.js';
import {
  CaptureRulesSchema,
  HASH_PREFIX,
  Redactor,
  anonymizeRecording,
  hashRedaction,
  loadCaptureRules,
  redactionText,
} from './capture-rules.js';
import { buildManifest, manifestLine } from './manifest.js';
import { readRecording, readRecordingManifest } from './reader.js';
import { REDACTED } from './redact.js';

const KEY = 'test-key-not-a-secret';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-capture-rules-'));
}

const rules = CaptureRulesSchema.parse({
  redact: {
    body: [
      { path: '$.card.number', mode: 'drop' },
      { path: '$..order_id', mode: 'hash' },
      { path: '$.items[*].email', mode: 'hash' },
    ],
    query: ['api_key', { name: 'session', mode: 'hash' }],
    headers: [{ name: 'X-User', mode: 'hash' }, 'x-trace'],
  },
});

describe('capture rules schema', () => {
  it('reads names as drop rules and defaults a missing mode to drop', () => {
    expect(rules.redact.query).toEqual([
      { name: 'api_key', mode: 'drop' },
      { name: 'session', mode: 'hash' },
    ]);
    expect(CaptureRulesSchema.parse({ redact: { body: [{ path: '$.a' }] } }).redact).toEqual({
      body: [{ path: '$.a', mode: 'drop' }],
      query: [],
      headers: [],
    });
    expect(CaptureRulesSchema.parse({})).toEqual({ redact: { body: [], query: [], headers: [] } });
  });

  it('loads a file and names a bad path, an unknown mode, and an unknown key', async () => {
    const dir = await tempDir();
    const good = join(dir, 'good.yaml');
    await writeFile(good, "redact:\n  body:\n    - { path: '$.a.b', mode: hash }\n");
    expect((await loadCaptureRules(good)).redact.body).toEqual([{ path: '$.a.b', mode: 'hash' }]);
    const badPath = join(dir, 'bad-path.yaml');
    await writeFile(badPath, "redact:\n  body:\n    - { path: 'a.b' }\n");
    await expect(loadCaptureRules(badPath)).rejects.toThrow(/redact\.body\[0\]/);
    const badMode = join(dir, 'bad-mode.yaml');
    await writeFile(badMode, "redact:\n  body:\n    - { path: '$.a', mode: blur }\n");
    await expect(loadCaptureRules(badMode)).rejects.toThrow(ConfigError);
    const badKey = join(dir, 'bad-key.yaml');
    await writeFile(badKey, 'redact:\n  cookies: []\n');
    await expect(loadCaptureRules(badKey)).rejects.toThrow(/unknown key/);
  });
});

describe('hashRedaction', () => {
  it('is the keyed HMAC-SHA256 of the text with a prefix', () => {
    const expected = createHmac('sha256', KEY).update('ord-1').digest('hex');
    expect(hashRedaction(KEY, 'ord-1')).toBe(`${HASH_PREFIX}${expected}`);
  });

  it('keeps equal values equal and different values or keys apart', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(hashRedaction(KEY, a) === hashRedaction(KEY, b)).toBe(a === b);
        expect(hashRedaction(KEY, a)).not.toBe(hashRedaction(`${KEY}x`, a));
      }),
    );
  });

  it('hashes a string as its text, a lossless number as its text, and others as canonical JSON', () => {
    expect(redactionText('abc')).toBe('abc');
    expect(redactionText({ $num: '1.10' })).toBe('1.10');
    expect(redactionText(12)).toBe('12');
    expect(redactionText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('Redactor', () => {
  const redactor = new Redactor({ headers: ['authorization'], query: [], rules, key: KEY });
  const h = (text: string): string => hashRedaction(KEY, text);

  it('drops and hashes body paths, wildcards and descent included, on both sides', () => {
    const e = makeExchange({
      request: {
        ...makeRequest(),
        method: 'POST',
        path: '/v1/orders',
        body: {
          card: { number: '4111111111111111', exp: '12/30' },
          items: [{ email: 'a@example.com' }, { email: 'b@example.com' }, { sku: 'x' }],
        },
      },
      response: {
        ...makeResponse(),
        status: 201,
        body: { order_id: 'ord-1', nested: { order_id: 'ord-1' } },
      },
    });
    const out = redactor.exchange(e);
    expect(out.request.body).toEqual({
      card: { number: REDACTED, exp: '12/30' },
      items: [{ email: h('a@example.com') }, { email: h('b@example.com') }, { sku: 'x' }],
    });
    expect(out.response.body).toEqual({
      order_id: h('ord-1'),
      nested: { order_id: h('ord-1') },
    });
    // The input is not changed.
    expect((e.response.body as { order_id: string }).order_id).toBe('ord-1');
  });

  it('applies header and query modes and leaves an already redacted value as the marker', () => {
    const out = redactor.request({
      method: 'GET',
      path: '/a',
      query: { API_KEY: 'k', session: ['s1', REDACTED], other: 'o' },
      headers: { Authorization: 'Bearer t', 'x-user': 'u-9', 'x-trace': 't', accept: '*/*' },
    });
    expect(out.query).toEqual({ API_KEY: REDACTED, session: [h('s1'), REDACTED], other: 'o' });
    expect(out.headers).toEqual({
      authorization: REDACTED,
      'x-user': h('u-9'),
      'x-trace': REDACTED,
      accept: '*/*',
    });
  });

  it('keeps base64, truncated, and absent bodies as they are', () => {
    const fields = { body: 'aGk=', encoding: 'base64' as const };
    expect(redactor.body(fields)).toBe(fields);
    expect(redactor.body({})).toEqual({});
  });

  it('refuses a hash rule without a key and accepts drop rules without one', () => {
    expect(() => new Redactor({ rules })).toThrow(/RP_REDACTION_KEY/);
    expect(() => new Redactor({ rules, key: '' })).toThrow(ConfigError);
    const dropOnly = CaptureRulesSchema.parse({ redact: { body: [{ path: '$.a' }] } });
    expect(new Redactor({ rules: dropOnly }).hashes).toBe(false);
  });

  it('describes its rules for the manifest without the key', () => {
    const described = redactor.manifestRules;
    expect(described?.headers).toEqual([
      { name: 'x-user', mode: 'hash' },
      { name: 'x-trace', mode: 'drop' },
    ]);
    expect(JSON.stringify(described)).not.toContain(KEY);
    expect(new Redactor().manifestRules).toBeUndefined();
    expect(redactor.droppedHeaders).toEqual(['authorization', 'x-trace']);
    expect(redactor.droppedQuery).toEqual(['api_key']);
  });
});

describe('anonymizeRecording', () => {
  const exchanges = [0, 1, 2].map((i) =>
    makeExchange({
      index: i,
      offset_ms: i * 10,
      response: { ...makeResponse(), body: { order_id: `ord-${i % 2}` } },
    }),
  );
  const text = exchanges.map((e) => JSON.stringify(e)).join('\n');

  it('rewrites every exchange and keeps ids, order, and offsets', async () => {
    const dir = await tempDir();
    const input = join(dir, 'in.jsonl');
    await writeFile(input, `${text}\n`);
    const out = join(dir, 'out.jsonl');
    const result = await anonymizeRecording(input, out, new Redactor({ rules, key: KEY }));
    expect(result).toEqual({ exchanges: 3, manifest: false });
    const written = await readRecording(out);
    expect(written.map((e) => [e.id, e.offset_ms])).toEqual(
      exchanges.map((e) => [e.id, e.offset_ms]),
    );
    const ids = written.map((e) => (e.response.body as { order_id: string }).order_id);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(await readRecordingManifest(out)).toBeNull();
    expect(await readFile(out, 'utf8')).not.toContain('ord-');
  });

  it('keeps a manifest with the rules added', async () => {
    const dir = await tempDir();
    const input = join(dir, 'in.jsonl');
    const manifest = buildManifest({ tool_version: '1.0.0', headers: ['authorization'] });
    await writeFile(input, `${manifestLine(manifest)}${text}\n`);
    const out = join(dir, 'out.jsonl');
    const result = await anonymizeRecording(
      input,
      out,
      new Redactor({ headers: [], query: [], rules, key: KEY }),
    );
    expect(result.manifest).toBe(true);
    const kept = await readRecordingManifest(out);
    expect(kept?.redaction.headers).toEqual(['authorization', 'x-trace']);
    expect(kept?.redaction.rules?.body).toHaveLength(3);
    expect(kept?.tool_version).toBe('1.0.0');
  });

  it('refuses to write over its input and names a missing input', async () => {
    const dir = await tempDir();
    const input = join(dir, 'in.jsonl');
    await writeFile(input, `${text}\n`);
    await expect(anonymizeRecording(input, input, new Redactor())).rejects.toThrow(/must differ/);
    await expect(
      anonymizeRecording(join(dir, 'missing.jsonl'), join(dir, 'o.jsonl'), new Redactor()),
    ).rejects.toThrow(ConfigError);
  });
});
