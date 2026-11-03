import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, makeRequest } from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdapterModule, pluginAdapterName } from '../src/index.js';

let dir: string;
const options = { target: 'queue://x', timeoutMs: 500, connections: 2, settings: { a: '1' } };
const ctx = { id: 'e', index: 0, tags: [], signal: new AbortController().signal };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-load-'));
});

async function module(name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source);
  return path;
}

describe('loadAdapterModule', () => {
  it('prefixes the adapter name and passes send, close, and the options through', async () => {
    const path = await module(
      'ok.mjs',
      `let closed = 0;
export async function createAdapter(options) {
  return {
    name: 'mine',
    send: async () => ({ status: 200, headers: {}, latency_ms: 1, body: { options, closed } }),
    close: async () => { closed += 1; },
  };
}
`,
    );
    const adapter = await loadAdapterModule(path, options);
    expect(adapter.name).toBe('plugin:mine');
    expect(pluginAdapterName('mine')).toBe('plugin:mine');
    const res = await adapter.send(makeRequest(), ctx);
    expect(res.body).toEqual({ options, closed: 0 });
    await adapter.close?.();
    expect((await adapter.send(makeRequest(), ctx)).body).toMatchObject({ closed: 1 });
  });

  it('accepts an adapter returned without a promise and without close', async () => {
    const path = await module(
      'sync.mjs',
      `export function createAdapter() {
  return { name: 'sync', send: async () => ({ status: 204, headers: {}, latency_ms: 1 }) };
}
`,
    );
    const adapter = await loadAdapterModule(path, options);
    await expect(adapter.close?.()).resolves.toBeUndefined();
    expect((await adapter.send(makeRequest(), ctx)).status).toBe(204);
  });

  it('throws a ConfigError for a missing file', async () => {
    await expect(loadAdapterModule(join(dir, 'none.mjs'), options)).rejects.toThrow(ConfigError);
    await expect(loadAdapterModule(dir, options)).rejects.toThrow(/does not exist/);
  });

  it('throws a ConfigError for a module that does not parse', async () => {
    const path = await module('broken.mjs', 'export function (\n');
    await expect(loadAdapterModule(path, options)).rejects.toThrow(/failed to load/);
  });

  it('throws a ConfigError for a missing export', async () => {
    const path = await module('empty.mjs', 'export const x = 1;\n');
    await expect(loadAdapterModule(path, options)).rejects.toThrow(
      /does not export a createAdapter function/,
    );
  });

  it('throws a ConfigError for a result without name or send', async () => {
    for (const [file, value] of [
      ['no-send.mjs', '{ name: "x" }'],
      ['no-name.mjs', '{ send: async () => ({}) }'],
      ['null.mjs', 'null'],
      ['bad-close.mjs', '{ name: "x", send: async () => ({}), close: 1 }'],
    ] as const) {
      const path = await module(file, `export function createAdapter() { return ${value}; }\n`);
      await expect(loadAdapterModule(path, options), file).rejects.toThrow(
        /must return an object with a name and a send function/,
      );
    }
  });

  it('wraps an error thrown by createAdapter in a ConfigError', async () => {
    const path = await module(
      'throws.mjs',
      'export function createAdapter() { throw new Error("no map"); }\n',
    );
    await expect(loadAdapterModule(path, options)).rejects.toThrow(/failed: no map/);
  });
});
