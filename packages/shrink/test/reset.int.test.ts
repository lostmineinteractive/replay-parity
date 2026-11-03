import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@replay-parity/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildReset, chosenStrategies, waitForHealth } from '../src/index.js';

let dir: string;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-reset-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface Stub {
  url: string;
  hits: { method: string; path: string }[];
  server: Server;
}

/** Serves `handler`'s status for every request and records the requests. */
async function stub(status: (hit: number) => number): Promise<Stub> {
  const hits: Stub['hits'] = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', path: req.url ?? '' });
    res.writeHead(status(hits.length));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}

describe('chosenStrategies', () => {
  it('names the strategy flags that were given', () => {
    expect(chosenStrategies({})).toEqual([]);
    expect(chosenStrategies({ url: 'u', command: 'c', module: 'm' })).toEqual([
      '--reset-url',
      '--reset-command',
      '--reset-module',
    ]);
  });
});

describe('buildReset', () => {
  it('requires exactly one strategy', async () => {
    await expect(buildReset({})).rejects.toThrow(
      'a reset strategy is required: one of --reset-url, --reset-command, --reset-module',
    );
    await expect(buildReset({ url: 'http://x', command: 'true' })).rejects.toThrow(
      'reset strategies are exclusive, got --reset-url and --reset-command',
    );
    await expect(buildReset({ url: 'http://x', command: 'true' })).rejects.toThrow(ConfigError);
  });

  it('posts to the reset URL and fails on a non 2xx answer', async () => {
    const ok = await stub(() => 204);
    await (
      await buildReset({ url: `${ok.url}/reset` })
    )();
    expect(ok.hits).toEqual([{ method: 'POST', path: '/reset' }]);
    const bad = await stub(() => 500);
    await expect((await buildReset({ url: `${bad.url}/reset` }))()).rejects.toThrow(
      `reset ${bad.url}/reset answered 500`,
    );
    const labelled = await buildReset({ url: `${bad.url}/reset`, urlLabel: '${TARGET}/reset' });
    await expect(labelled()).rejects.toThrow('reset ${TARGET}/reset answered 500');
  });

  it('runs the command through the shell and writes its marker', async () => {
    const marker = join(dir, 'marker.txt');
    const reset = await buildReset({ command: `echo run >> "${marker}"` });
    await reset();
    await reset();
    expect((await readFile(marker, 'utf8')).split('\n').filter(Boolean)).toEqual(['run', 'run']);
  });

  it('puts the target in the {target} placeholder', async () => {
    const marker = join(dir, 'target-marker.txt');
    const reset = await buildReset({
      command: `echo {target} >> "${marker}"`,
      target: 'http://127.0.0.1:9',
    });
    await reset();
    expect(await readFile(marker, 'utf8')).toBe('http://127.0.0.1:9\n');
  });

  it('names the command, the exit code, and the stderr tail when the command fails', async () => {
    const reset = await buildReset({ command: 'echo first >&2; echo disk full >&2; exit 3' });
    const error = await reset().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('reset command "echo first >&2;');
    expect((error as Error).message).toContain('exited with 3');
    expect((error as Error).message).toContain('stderr: first\ndisk full');
  });

  it('fails a command that runs past the timeout and ends it', async () => {
    const marker = join(dir, 'late-marker.txt');
    const reset = await buildReset({
      command: `echo started >&2; sleep 3; echo late > "${marker}"`,
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(reset()).rejects.toThrow(/timed out after 300 ms, stderr: started/);
    expect(Date.now() - started).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 200));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('calls the module reset, as a named or a default export', async () => {
    const marker = join(dir, 'module-marker.txt');
    const named = join(dir, 'named-reset.mjs');
    await writeFile(
      named,
      `import { appendFileSync } from 'node:fs';
export async function reset() { appendFileSync(${JSON.stringify(marker)}, 'named\\n'); }
`,
    );
    const viaDefault = join(dir, 'default-reset.mjs');
    await writeFile(
      viaDefault,
      `import { appendFileSync } from 'node:fs';
export default { async reset() { appendFileSync(${JSON.stringify(marker)}, 'default\\n'); } };
`,
    );
    await (
      await buildReset({ module: named })
    )();
    await (
      await buildReset({ module: viaDefault })
    )();
    expect(await readFile(marker, 'utf8')).toBe('named\ndefault\n');
  });

  it('passes the target to a module reset and puts it in the health URL', async () => {
    const marker = join(dir, 'context-marker.txt');
    const module = join(dir, 'context-reset.mjs');
    await writeFile(
      module,
      `import { appendFileSync } from 'node:fs';
export async function reset(context) { appendFileSync(${JSON.stringify(marker)}, context.target + '\\n'); }
`,
    );
    const health = await stub(() => 200);
    const reset = await buildReset({
      module,
      target: health.url,
      health: '{target}/ready',
    });
    await reset();
    expect(await readFile(marker, 'utf8')).toBe(`${health.url}\n`);
    expect(health.hits).toEqual([{ method: 'GET', path: '/ready' }]);
  });

  it('refuses a module that is missing, broken, or has no reset', async () => {
    await expect(buildReset({ module: join(dir, 'nope.mjs') })).rejects.toThrow(
      /reset module .*nope\.mjs failed to load/,
    );
    const empty = join(dir, 'empty-reset.mjs');
    await writeFile(empty, 'export const other = 1;\n');
    await expect(buildReset({ module: empty })).rejects.toThrow('does not export a reset function');
  });

  it('waits for the health URL to answer 2xx after the reset', async () => {
    const readyAfter = Date.now() + 600;
    const health = await stub(() => (Date.now() >= readyAfter ? 200 : 503));
    const marker = join(dir, 'health-marker.txt');
    const reset = await buildReset({
      command: `echo reset >> "${marker}"`,
      health: `${health.url}/ready`,
      timeoutMs: 10_000,
    });
    const started = Date.now();
    await reset();
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(health.hits.length).toBeGreaterThan(2);
    expect(health.hits.every((h) => h.method === 'GET' && h.path === '/ready')).toBe(true);
    expect(await readFile(marker, 'utf8')).toBe('reset\n');
  });

  it('fails the reset when the health URL never answers 2xx', async () => {
    const health = await stub(() => 503);
    const reset = await buildReset({
      command: 'true',
      health: `${health.url}/ready`,
      timeoutMs: 400,
    });
    await expect(reset()).rejects.toThrow(
      `reset health check ${health.url}/ready did not answer 2xx within 400 ms (last: answered 503)`,
    );
  });
});

describe('waitForHealth', () => {
  it('names a connection failure as the last error', async () => {
    await expect(waitForHealth('http://127.0.0.1:1/ready', 250)).rejects.toThrow(
      /did not answer 2xx within 250 ms \(last: /,
    );
  });
});
