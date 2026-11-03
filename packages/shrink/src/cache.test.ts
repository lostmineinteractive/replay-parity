import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeExchange, makeRequest } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { MemoryAttemptCache, attemptKey, cacheSalt, openAttemptCache } from './cache.js';

describe('MemoryAttemptCache', () => {
  it('answers what it was told and nothing else', async () => {
    const cache = new MemoryAttemptCache();
    expect(cache.get('k')).toBeUndefined();
    await cache.set('k', false);
    await cache.set('j', true);
    expect(cache.get('k')).toBe(false);
    expect(cache.get('j')).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe('openAttemptCache', () => {
  it('persists verdicts as JSON lines and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-cache-'));
    const path = join(dir, 'nested', 'cache.jsonl');
    const first = await openAttemptCache(path);
    expect(first.size).toBe(0);
    await first.set('a', true);
    await first.set('b', false);
    // The same verdict again is not written twice.
    await first.set('a', true);
    expect(await readFile(path, 'utf8')).toBe(
      '{"key":"a","reproduced":true}\n{"key":"b","reproduced":false}\n',
    );
    const second = await openAttemptCache(path);
    expect(second.get('a')).toBe(true);
    expect(second.get('b')).toBe(false);
    expect(second.get('c')).toBeUndefined();
  });

  it('skips a line that is not a verdict, such as one cut short by a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-cache-'));
    const path = join(dir, 'cache.jsonl');
    await writeFile(
      path,
      '{"key":"a","reproduced":true}\n\nnot json\n{"key":1,"reproduced":true}\n{"key":"b","reproduced":fal',
    );
    const cache = await openAttemptCache(path);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(true);
  });

  it('fails on a path that cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-cache-'));
    await expect(openAttemptCache(dir)).rejects.toThrow();
  });
});

describe('attemptKey', () => {
  const a = makeExchange({ index: 0, request: makeRequest({ method: 'POST', body: { qty: 5 } }) });
  const b = makeExchange({ index: 1 });
  const salt = cacheSalt(['rule']);

  it('is the same for the same subset and differs when anything in it differs', () => {
    expect(attemptKey(salt, [a, b])).toBe(attemptKey(salt, [a, b]));
    expect(attemptKey(salt, [a, b])).not.toBe(attemptKey(salt, [b, a]));
    expect(attemptKey(salt, [a])).not.toBe(attemptKey(salt, [a, b]));
    const lowered = { ...a, request: { ...a.request, body: { qty: 1 } } };
    expect(attemptKey(salt, [lowered, b])).not.toBe(attemptKey(salt, [a, b]));
    expect(attemptKey(cacheSalt(['other']), [a, b])).not.toBe(attemptKey(salt, [a, b]));
  });
});
