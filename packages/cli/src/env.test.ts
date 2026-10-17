import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, parseDotEnv } from './env.js';

describe('parseDotEnv', () => {
  it('reads assignments, quotes, exports, and comments', () => {
    expect(
      parseDotEnv(
        [
          '# comment',
          '',
          'PLAIN=value',
          'export EXPORTED=yes',
          'QUOTED="with spaces # not a comment"',
          "SINGLE='single'",
          'TRAILING=value # comment',
          'SPACED = padded ',
          'not an assignment',
          '1BAD=nope',
        ].join('\n'),
      ),
    ).toEqual({
      PLAIN: 'value',
      EXPORTED: 'yes',
      QUOTED: 'with spaces # not a comment',
      SINGLE: 'single',
      TRAILING: 'value',
      SPACED: 'padded',
    });
  });
});

describe('loadDotEnv', () => {
  it('sets only names that are not already set and tolerates a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'A=from-file\nB=from-file\n');
    const env: NodeJS.ProcessEnv = { A: 'from-shell' };
    expect(loadDotEnv(path, env)).toEqual(['B']);
    expect(env).toEqual({ A: 'from-shell', B: 'from-file' });
    expect(loadDotEnv(join(dir, 'missing'), env)).toEqual([]);
  });
});
