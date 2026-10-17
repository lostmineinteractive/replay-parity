import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prose guard, run against small temporary trees. The exemption for
 * docs/oms-mapping.md is by exact path, so it cannot widen silently.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/check-prose.sh');
// Built at run time so this file never contains the word the guard bans.
const WORD = ['tr', 'ade'].join('');

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-prose-'));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await copyFile(SCRIPT, join(dir, 'scripts/check-prose.sh'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

function run(dir: string): { status: number; out: string } {
  const result = spawnSync('sh', [join(dir, 'scripts/check-prose.sh')], { encoding: 'utf8' });
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe('check-prose.sh', () => {
  it('passes a clean tree', async () => {
    const dir = await tree({ 'docs/a.md': 'Plain words.\n', 'src/a.ts': 'export const x = 1;\n' });
    expect(run(dir)).toEqual({ status: 0, out: 'prose check passed\n' });
  });

  it('allows a banned word only in docs/oms-mapping.md, by exact path', async () => {
    const exempt = await tree({
      'docs/oms-mapping.md': `A fill and a cancel racing. Pre ${WORD} checks apply.\n`,
    });
    expect(run(exempt).status).toBe(0);
    const other = await tree({ 'docs/other.md': `Pre ${WORD} checks apply.\n` });
    const result = run(other);
    expect(result.status).toBe(1);
    expect(result.out).toContain('banned term found in ./docs/other.md');
    const nested = await tree({ 'docs/sub/oms-mapping.md': `Pre ${WORD} checks apply.\n` });
    expect(run(nested).status).toBe(1);
    const code = await tree({ 'src/x.ts': `const ${WORD} = 1;\n` });
    expect(run(code).status).toBe(1);
  });

  it('still rejects an em dash in the exempt file and anywhere else', async () => {
    const dash = '—';
    const exempt = await tree({ 'docs/oms-mapping.md': `A fill ${dash} a cancel.\n` });
    const result = run(exempt);
    expect(result.status).toBe(1);
    expect(result.out).toContain('em dash found in ./docs/oms-mapping.md');
    const elsewhere = await tree({ 'README.md': `Plain ${dash} words.\n` });
    expect(run(elsewhere).status).toBe(1);
  });

  it('matches whole words only', async () => {
    const dir = await tree({ 'docs/a.md': `The ${WORD}sman found nothing. A ${WORD}mark.\n` });
    expect(run(dir).status).toBe(0);
  });
});
