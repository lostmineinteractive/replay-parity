import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { loadDiffRules, loadThresholds, readRecording } from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkRules, formatCheck, preflight, runCli, scanRecording } from '../src/index.js';

/**
 * The preflight streams the recording and keeps counts. Its output on the demo
 * recording is pinned by files made before it streamed.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');
const THRESHOLDS = join(ROOT, 'demo/thresholds.yaml');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rp-preflight-stream-'));
});

describe('the streaming preflight', () => {
  for (const name of ['diff-rules', 'diff-rules-unordered']) {
    it(`prints what it printed before for demo/${name}.yaml`, async () => {
      const stdout = new Sink();
      const code = await runCli(
        [
          'validate',
          '--recording',
          RECORDING,
          '--rules',
          join(ROOT, `demo/${name}.yaml`),
          '--thresholds',
          THRESHOLDS,
          '--barrier-tag',
          'list-ledger',
          '--barrier-tag',
          'nope',
        ],
        { stdout, stderr: new Sink(), env: {}, cwd: dir },
      );
      expect(code).toBe(1);
      const golden = await readFile(
        join(import.meta.dirname, `fixtures/preflight-${name}.txt`),
        'utf8',
      );
      // The golden file was made with paths relative to the repository root.
      const actual = stdout.text.split(`${ROOT}/`).join('');
      const withoutConfig = (text: string): string => text.replace(/^ok {4}config: .*\n/, '');
      expect(withoutConfig(actual)).toBe(withoutConfig(golden));
    });
  }

  it('gives the same checks from the path as from the exchanges in memory', async () => {
    const rules = await loadDiffRules(join(ROOT, 'demo/diff-rules.yaml'));
    const thresholds = await loadThresholds(THRESHOLDS);
    const exchanges = await readRecording(RECORDING);
    const base = { recording: RECORDING, rules, thresholds, barrierTags: ['list-ledger'] };
    const streamed = await preflight(base);
    const inMemory = await preflight({ ...base, exchanges });
    expect(streamed.map(formatCheck)).toEqual(inMemory.map(formatCheck));
    const scan = await scanRecording(RECORDING, rules);
    expect(checkRules(rules, scan).map(formatCheck)).toEqual(
      checkRules(rules, exchanges).map(formatCheck),
    );
  });

  it('keeps counts and no exchange', async () => {
    const rules = await loadDiffRules(join(ROOT, 'demo/diff-rules.yaml'));
    const scan = await scanRecording(RECORDING, rules);
    expect(scan.count).toBe(283);
    const held = JSON.stringify([scan.tags, scan.substitutions, scan.paths, scan.headers]);
    expect(held.length).toBeLessThan(5000);
  });
});
