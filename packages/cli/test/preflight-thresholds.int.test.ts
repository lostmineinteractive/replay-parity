import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/** Every by_tag section of the thresholds is checked against the recording's tags. */

const RECORDING = resolve(import.meta.dirname, '../../../demo/recording.jsonl');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-preflight-thresholds-'));
});

async function validate(name: string, yaml: string): Promise<{ code: number; out: string[] }> {
  const path = join(dir, name);
  await writeFile(path, yaml, 'utf8');
  const stdout = new Sink();
  const code = await runCli(['validate', '--recording', RECORDING, '--thresholds', path], {
    stdout,
    stderr: new Sink(),
    env: {},
    cwd: dir,
  });
  return { code, out: stdout.text.split('\n') };
}

const MISSING = 'names a tag the recording does not have';

const CASES: [string, string, string][] = [
  ['errors.by_tag', 'errors:\n  by_tag:\n    ghost: { rate_max: 0.1 }\n', 'errors.by_tag.ghost'],
  [
    'latency.relative_to_reference.by_tag',
    'latency:\n  relative_to_reference:\n    by_tag:\n      ghost: { p99_ratio_max: 2 }\n',
    'latency.relative_to_reference.by_tag.ghost',
  ],
  [
    'status.by_tag',
    "status:\n  by_tag:\n    ghost:\n      '500': { rate_max: 0.1 }\n",
    'status.by_tag.ghost',
  ],
  [
    'baseline.latency.by_tag',
    'baseline:\n  latency:\n    by_tag:\n      ghost: { p99_ratio_max: 2 }\n',
    'baseline.latency.by_tag.ghost',
  ],
  [
    'baseline.correctness.by_tag',
    'baseline:\n  correctness:\n    by_tag:\n      ghost: { mismatch_rate_delta_max: 0.1 }\n',
    'baseline.correctness.by_tag.ghost',
  ],
];

describe('threshold tags in the preflight', () => {
  for (const [section, yaml, keyPath] of CASES) {
    it(`reports an unknown tag under ${section} with its own key path`, async () => {
      const res = await validate(`${section}.yaml`, yaml);
      expect(res.code).toBe(1);
      expect(res.out).toContain(`error thresholds: ${keyPath} ${MISSING}`);
    });
  }

  it('reports a known tag under every section as ok', async () => {
    const tag = 'create-order';
    const res = await validate(
      'known.yaml',
      [
        'errors:',
        `  by_tag: { ${tag}: { rate_max: 0.5 } }`,
        'latency:',
        '  relative_to_reference:',
        `    by_tag: { ${tag}: { p99_ratio_max: 3 } }`,
        'status:',
        '  by_tag:',
        `    ${tag}: { '500': { rate_max: 0.5 } }`,
        'baseline:',
        '  latency:',
        `    by_tag: { ${tag}: { p99_ratio_max: 3 } }`,
        '  correctness:',
        `    by_tag: { ${tag}: { mismatch_rate_delta_max: 0.5 } }`,
        '',
      ].join('\n'),
    );
    expect(res.code).toBe(0);
    for (const [, , keyPath] of CASES) {
      const key = keyPath.replace('ghost', tag);
      expect(res.out.some((l) => l.includes(`ok    thresholds: ${key} names `))).toBe(true);
    }
  });
});
