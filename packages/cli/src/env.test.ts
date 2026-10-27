import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dotEnvCandidates, findProjectRoot, loadDotEnv, parseDotEnv } from './env.js';

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
  it('sets only names that are not already set and reports the file it read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'A=from-file\nB=from-file\n');
    const env: NodeJS.ProcessEnv = { A: 'from-shell' };
    expect(loadDotEnv(path, env)).toEqual({ loaded: path, tried: [path], set: ['B'] });
    expect(env).toEqual({ A: 'from-shell', B: 'from-file' });
    const missing = join(dir, 'missing');
    expect(loadDotEnv(missing, env)).toEqual({ loaded: null, tried: [missing], set: [] });
  });

  it('falls back from the working directory to the project root for a relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-env-root-'));
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await writeFile(join(root, '.env'), 'KEY=at-root\n');
    const nested = join(root, 'packages', 'deep');
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
    expect(findProjectRoot(root)).toBe(root);
    expect(dotEnvCandidates('.env', nested)).toEqual([join(nested, '.env'), join(root, '.env')]);
    expect(dotEnvCandidates('.env', root)).toEqual([join(root, '.env')]);
    expect(dotEnvCandidates('/abs/.env', nested)).toEqual(['/abs/.env']);

    const env: NodeJS.ProcessEnv = {};
    expect(loadDotEnv('.env', env, nested)).toEqual({
      loaded: join(root, '.env'),
      tried: [join(nested, '.env'), join(root, '.env')],
      set: ['KEY'],
    });
    expect(env.KEY).toBe('at-root');

    // The working directory wins when both exist, and the root is not looked at.
    await writeFile(join(nested, '.env'), 'KEY=nested\n');
    const shadowed: NodeJS.ProcessEnv = {};
    expect(loadDotEnv('.env', shadowed, nested)).toEqual({
      loaded: join(nested, '.env'),
      tried: [join(nested, '.env')],
      set: ['KEY'],
    });
    expect(shadowed.KEY).toBe('nested');
  });

  it('recognizes a .git marker and names both paths when neither file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-env-git-'));
    await mkdir(join(root, '.git'));
    const sub = join(root, 'sub');
    await mkdir(sub);
    expect(findProjectRoot(sub)).toBe(root);
    expect(loadDotEnv('.env', {}, sub)).toEqual({
      loaded: null,
      tried: [join(sub, '.env'), join(root, '.env')],
      set: [],
    });
  });
});
