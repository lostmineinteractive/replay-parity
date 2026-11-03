import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadInvariantModule, validateInvariantModule } from './load.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-invariant-module-'));
});

async function write(name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source);
  return path;
}

const RULE = `{ id: 1, name: 'r', statement: 'Holds.', check: () => ({ status: 'holds', checks: 1, evidence: [] }) }`;
const PARSE = `(e) => ({ kind: 'x', accepted: true, sentMs: 0, ackedMs: 0, id: e.id })`;

describe('loadInvariantModule', () => {
  it('loads named exports and records the file hash', async () => {
    const source = `export const name = 'named';\nexport const version = '2';\nexport const parse = ${PARSE};\nexport const rules = [${RULE}];\n`;
    const path = await write('named.mjs', source);
    const module = await loadInvariantModule(path);
    expect(module.name).toBe('named');
    expect(module.version).toBe('2');
    expect(module.rules).toHaveLength(1);
    expect(module.sha256).toBe(createHash('sha256').update(source).digest('hex'));
  });

  it('loads a default export object', async () => {
    const path = await write(
      'default.mjs',
      `export default { name: 'dflt', version: '1', parse: ${PARSE}, rules: [${RULE}] };\n`,
    );
    expect((await loadInvariantModule(path)).name).toBe('dflt');
  });

  it('names a missing file', async () => {
    await expect(loadInvariantModule(join(dir, 'nope.mjs'))).rejects.toThrow(
      new ConfigError(`invariant module ${join(dir, 'nope.mjs')} does not exist`),
    );
    await expect(loadInvariantModule(dir)).rejects.toThrow(/does not exist/);
  });

  it('names a module that fails to import', async () => {
    const path = await write('syntax.mjs', 'export const = ;\n');
    await expect(loadInvariantModule(path)).rejects.toThrow(
      new RegExp(`invariant module ${path} failed to load`),
    );
  });

  it('names each missing export', async () => {
    const cases: [string, string][] = [
      [`export const version = '1';`, 'does not export a name'],
      [`export const name = 'n';`, 'does not export a version string'],
      [`export const name = 'n'; export const version = '1';`, 'does not export a parse function'],
      [
        `export const name = 'n'; export const version = '1'; export const parse = ${PARSE};`,
        'does not export a non empty rules array',
      ],
    ];
    for (const [i, [source, message]] of cases.entries()) {
      const path = await write(`missing-${i}.mjs`, `${source}\n`);
      await expect(loadInvariantModule(path)).rejects.toThrow(
        new ConfigError(`invariant module ${path} ${message}`),
      );
    }
  });
});

describe('validateInvariantModule', () => {
  const base = {
    name: 'm',
    version: '1',
    parse: () => ({}),
    rules: [{ id: 1, name: 'a', statement: 'A.', check: () => ({}) }],
  };
  const bad = (over: Record<string, unknown>): string => {
    try {
      validateInvariantModule({ ...base, ...over }, 'm.mjs');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    return 'accepted';
  };

  it('accepts a well formed module', () => {
    expect(bad({})).toBe('accepted');
    expect(bad({ stateChanging: ['a'], epochs: () => [] })).toBe('accepted');
  });

  it('rejects a value that is not an object', () => {
    expect(() => validateInvariantModule(null, 'x.mjs')).toThrow(
      'invariant module x.mjs does not export a module object',
    );
  });

  it('rejects malformed rules', () => {
    const rule = base.rules[0] as Record<string, unknown>;
    expect(bad({ rules: [{ ...rule, id: 0 }] })).toBe(
      'invariant module m.mjs: rules[0] needs an id that is a positive integer',
    );
    expect(bad({ rules: [{ ...rule, id: 1.5 }] })).toContain('positive integer');
    expect(bad({ rules: [{ ...rule, name: '' }] })).toBe(
      'invariant module m.mjs: rules[0] needs a name',
    );
    expect(bad({ rules: [{ ...rule, statement: 3 }] })).toBe(
      'invariant module m.mjs: rules[0] needs a statement',
    );
    expect(bad({ rules: [{ ...rule, check: 'yes' }] })).toBe(
      'invariant module m.mjs: rules[0] needs a check function',
    );
    expect(bad({ rules: ['rule'] })).toContain('rules[0] needs an id');
    expect(bad({ rules: [rule, { ...rule, name: 'b' }] })).toBe(
      'invariant module m.mjs: rules[1] repeats the id 1',
    );
    expect(bad({ rules: [rule, { ...rule, id: 2 }] })).toBe(
      'invariant module m.mjs: rules[1] repeats the name a',
    );
  });

  it('rejects hooks of the wrong type', () => {
    expect(bad({ epochs: [] })).toBe('invariant module m.mjs: epochs must be a function');
    expect(bad({ inconclusive: 'none' })).toBe(
      'invariant module m.mjs: inconclusive must be a function',
    );
    expect(bad({ stateChanging: 'write' })).toBe(
      'invariant module m.mjs: stateChanging must be a list of kinds',
    );
  });
});
