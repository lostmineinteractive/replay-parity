import type { Diff } from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { NOISE_RULE, markNoise, noisePaths } from './noise.js';

const diff = (findings: Diff['findings']): Diff => ({
  verdict: findings.every((f) => f.tolerated) ? 'tolerated' : 'mismatch',
  findings,
});

describe('noisePaths', () => {
  it('names the untolerated paths where the reference moved by itself', () => {
    const paths = noisePaths(
      diff([
        { path: '$.ts', kind: 'value', tolerated: false, reference: 'a', candidate: 'b' },
        { path: '$.id', kind: 'value', tolerated: true, rule: 'ignore[0]' },
      ]),
    );
    expect([...paths]).toEqual(['$.ts']);
  });

  it('names nothing when the reference answered another status or an incomparable body', () => {
    for (const kind of ['status', 'body_format', 'body_too_large'] as const) {
      const paths = noisePaths(
        diff([
          { path: '$.ts', kind: 'value', tolerated: false },
          { path: kind === 'status' ? 'status' : '$', kind, tolerated: false },
        ]),
      );
      expect(paths.size).toBe(0);
    }
  });
});

describe('markNoise', () => {
  it('tolerates and marks the findings at noise paths and recomputes the verdict', () => {
    const marked = markNoise(
      diff([{ path: '$.ts', kind: 'value', tolerated: false, reference: 1, candidate: 2 }]),
      new Set(['$.ts']),
    );
    expect(marked).toEqual({
      count: 1,
      diff: {
        verdict: 'tolerated',
        findings: [
          {
            path: '$.ts',
            kind: 'value',
            tolerated: true,
            reference: 1,
            candidate: 2,
            rule: NOISE_RULE,
            noise: true,
          },
        ],
      },
    });
  });

  it('keeps a mismatch at another path and leaves tolerated findings alone', () => {
    const input = diff([
      { path: '$.ts', kind: 'value', tolerated: false },
      { path: '$.total', kind: 'value', tolerated: false },
      { path: '$.id', kind: 'value', tolerated: true, rule: 'ignore[0]' },
    ]);
    const marked = markNoise(input, new Set(['$.ts', '$.id']));
    expect(marked.count).toBe(1);
    expect(marked.diff.verdict).toBe('mismatch');
    expect(marked.diff.findings[1]).toEqual({ path: '$.total', kind: 'value', tolerated: false });
    expect(marked.diff.findings[2]).toEqual(input.findings[2]);
    expect(markNoise(input, new Set(['$.other']))).toEqual({ diff: input, count: 0 });
  });
});
