import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, formatZodError, loadYamlFile, parseYaml } from './yaml.js';

const schema = z.object({ name: z.string(), items: z.array(z.object({ n: z.number() })) }).strict();

describe('parseYaml', () => {
  it('parses and validates', () => {
    expect(parseYaml('name: x\nitems:\n  - n: 1\n', schema, 'cfg')).toEqual({
      name: 'x',
      items: [{ n: 1 }],
    });
  });

  it('treats an empty document as an empty object', () => {
    const loose = z.object({ a: z.number().default(1) });
    expect(parseYaml('', loose, 'cfg')).toEqual({ a: 1 });
    expect(parseYaml('# only a comment\n', loose, 'cfg')).toEqual({ a: 1 });
  });

  it('names the source on invalid YAML', () => {
    expect(() => parseYaml('name: [unclosed', schema, 'my.yaml')).toThrow(ConfigError);
    expect(() => parseYaml('name: [unclosed', schema, 'my.yaml')).toThrow(/my\.yaml: invalid YAML/);
  });

  it('names the path of a schema violation', () => {
    expect(() => parseYaml('name: x\nitems:\n  - n: no\n', schema, 'cfg')).toThrow(
      /cfg: .* at items\[0\]\.n/,
    );
  });

  it('names unknown keys', () => {
    expect(() => parseYaml('name: x\nitems: []\nextra: 1\n', schema, 'cfg')).toThrow(
      /unknown key "extra" at \(root\)/,
    );
  });
});

describe('formatZodError', () => {
  it('joins several issues', () => {
    const result = schema.safeParse({ name: 1, items: [{ n: 'x' }], bogus: true, more: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = formatZodError(result.error);
      expect(text).toContain('at name');
      expect(text).toContain('at items[0].n');
      expect(text).toContain('unknown keys "bogus", "more"');
    }
  });
});

describe('loadYamlFile', () => {
  it('loads a file and reports a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-yaml-'));
    const path = join(dir, 'c.yaml');
    await writeFile(path, 'name: f\nitems: []\n');
    expect(await loadYamlFile(path, schema)).toEqual({ name: 'f', items: [] });
    await expect(loadYamlFile(join(dir, 'missing.yaml'), schema)).rejects.toThrow(ConfigError);
  });
});
