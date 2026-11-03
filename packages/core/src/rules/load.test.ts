import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { loadDiffRules, mergeRules } from './load.js';
import { parseDiffRules } from './schema.js';

async function dir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-packs-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text, 'utf8');
  }
  return root;
}

describe('rule packs', () => {
  it('prepends included lists and lets the including file win on scalars', async () => {
    const root = await dir({
      'packs/time.yaml': [
        'ignore: ["$.a"]',
        'time:',
        '  - { path: "$..at", abs_ms: 1000 }',
        'extra_fields: allow',
        'headers: { compare: [etag] }',
      ].join('\n'),
      'packs/ids.yaml': 'include: [./nested/ids2.yaml]\nignore: ["$.b"]\n',
      'packs/nested/ids2.yaml': 'ignore: ["$.c"]\n',
      'rules.yaml': [
        'include: [packs/time.yaml, packs/ids.yaml]',
        'ignore: ["$.d"]',
        'extra_fields: deny',
        'headers: { compare: [x-a] }',
      ].join('\n'),
    });
    const rules = await loadDiffRules(join(root, 'rules.yaml'));
    expect(rules.ignore).toEqual(['$.a', '$.c', '$.b', '$.d']);
    expect(rules.time).toEqual([{ path: '$..at', abs_ms: 1000, format: 'iso8601' }]);
    expect(rules.extra_fields).toBe('deny');
    expect(rules.headers.compare).toEqual(['etag', 'x-a']);
  });

  it('names the chain for a missing file and for a cycle', async () => {
    const root = await dir({
      'a.yaml': 'include: [b.yaml]\n',
      'b.yaml': 'include: [missing.yaml]\n',
      'c.yaml': 'include: [d.yaml]\n',
      'd.yaml': 'include: [c.yaml]\n',
    });
    const missing = loadDiffRules(join(root, 'a.yaml'));
    await expect(missing).rejects.toThrow(ConfigError);
    await expect(loadDiffRules(join(root, 'a.yaml'))).rejects.toThrow(
      /missing\.yaml: .*\(included by .*a\.yaml -> .*b\.yaml\)/,
    );
    await expect(loadDiffRules(join(root, 'c.yaml'))).rejects.toThrow(
      /include cycle .*c\.yaml -> .*d\.yaml -> .*c\.yaml/,
    );
  });

  it('rejects a bad include list and validates the merged result against the including file', async () => {
    const root = await dir({
      'bad.yaml': 'include: packs.yaml\n',
      'pack.yaml': 'tolerances:\n  - path: "$.a"\n',
      'top.yaml': 'include: [pack.yaml]\n',
    });
    await expect(loadDiffRules(join(root, 'bad.yaml'))).rejects.toThrow(/include must be a list/);
    await expect(loadDiffRules(join(root, 'top.yaml'))).rejects.toThrow(/top\.yaml: .*abs, rel/);
  });

  it('refuses include in text parsed without a file', () => {
    expect(() => parseDiffRules('include: [a.yaml]\n')).toThrow(/loadDiffRules/);
  });

  it('merges mappings key by key', () => {
    expect(mergeRules({ a: [1], m: { x: 1, l: [1] } }, { a: [2], m: { l: [2] }, s: 3 })).toEqual({
      a: [1, 2],
      m: { x: 1, l: [1, 2] },
      s: 3,
    });
  });
});
