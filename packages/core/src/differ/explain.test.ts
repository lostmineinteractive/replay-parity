import { describe, expect, it } from 'vitest';
import { explainDiff, explainFinding } from './explain.js';
import type { Diff, Finding } from './schema.js';

const f = (over: Partial<Finding>): Finding => ({
  path: '$.x',
  kind: 'value',
  tolerated: false,
  ...over,
});

describe('explainFinding', () => {
  it('describes each kind in plain language', () => {
    expect(
      explainFinding(f({ path: 'status', kind: 'status', reference: 404, candidate: 200 })),
    ).toBe('The status differs. The reference returned 404 and the candidate returned 200.');
    expect(
      explainFinding(
        f({ path: 'header:content-type', kind: 'header', reference: 'a', candidate: undefined }),
      ),
    ).toBe('Header content-type differs. The reference sent "a" and the candidate sent absent.');
    expect(
      explainFinding(
        f({
          path: '$.total',
          reference: 12.38,
          candidate: 12.37,
          detail: 'no tolerance rule covers this path',
        }),
      ),
    ).toBe(
      'The value at $.total differs. The reference has 12.38 and the candidate has 12.37. No tolerance rule covers this path.',
    );
    expect(
      explainFinding(
        f({
          path: '$.a',
          kind: 'type',
          reference: 1,
          candidate: '1',
          detail: 'reference is number, candidate is string',
        }),
      ),
    ).toBe('The type at $.a differs. Reference is number, candidate is string.');
    expect(
      explainFinding(f({ path: '$.items[1]', kind: 'missing', reference: { sku: 'B' } })),
    ).toBe('The candidate is missing $.items[1]. The reference has {"sku":"B"}.');
    expect(explainFinding(f({ path: '$.extra', kind: 'unexpected', candidate: 5 }))).toBe(
      'The candidate has an extra value at $.extra: 5.',
    );
    expect(
      explainFinding(
        f({
          path: '$',
          kind: 'body_too_large',
          detail: 'reference body (9 bytes) exceeded the capture size cap',
        }),
      ),
    ).toBe('The body was not compared. Reference body (9 bytes) exceeded the capture size cap.');
    expect(
      explainFinding(
        f({
          path: '$',
          kind: 'body_format',
          detail: 'reference body is json, candidate body is base64',
        }),
      ),
    ).toBe('The body formats differ. Reference body is json, candidate body is base64.');
    expect(
      explainFinding(
        f({
          path: '$',
          kind: 'value',
          detail: 'binary bodies differ (reference 3 bytes, candidate 4 bytes)',
        }),
      ),
    ).toBe('The body differs. binary bodies differ (reference 3 bytes, candidate 4 bytes)');
  });

  it('appends the tolerating rule', () => {
    expect(
      explainFinding(
        f({
          path: '$.total',
          reference: 1,
          candidate: 1.001,
          tolerated: true,
          rule: 'tolerances[0]',
          detail: 'within abs 0.005',
        }),
      ),
    ).toBe(
      'The value at $.total differs. The reference has 1 and the candidate has 1.001. Tolerated by rule tolerances[0].',
    );
  });

  it('truncates long values', () => {
    const long = 'x'.repeat(200);
    const text = explainFinding(f({ reference: long, candidate: 'y' }));
    expect(text).toContain('...');
    expect(text.length).toBeLessThan(200);
  });
});

describe('explainDiff', () => {
  it('summarizes each verdict and lists findings', () => {
    const match: Diff = { verdict: 'match', findings: [] };
    expect(explainDiff(match)).toEqual(['The responses match. No differences were found.']);

    const tolerated: Diff = {
      verdict: 'tolerated',
      findings: [f({ tolerated: true, rule: 'tolerances[0]', reference: 1, candidate: 1.001 })],
    };
    const lines = explainDiff(tolerated);
    expect(lines[0]).toBe(
      'The responses differ in 1 place and every difference is tolerated by a rule.',
    );
    expect(lines[1]?.startsWith('  ~ ')).toBe(true);

    const mismatch: Diff = {
      verdict: 'mismatch',
      findings: [
        f({ reference: 1, candidate: 2 }),
        f({ path: '$.y', reference: 1, candidate: 1.001, tolerated: true, rule: 'tolerances[0]' }),
        f({ path: '$.z', reference: 1, candidate: 3 }),
      ],
    };
    const m = explainDiff(mismatch);
    expect(m[0]).toBe(
      'The responses mismatch. 2 differences are not covered by any rule and 1 is tolerated.',
    );
    expect(m).toHaveLength(4);
    expect(m[1]?.startsWith('  x ')).toBe(true);
    expect(
      explainDiff({ verdict: 'mismatch', findings: [f({ reference: 1, candidate: 2 })] })[0],
    ).toBe('The responses mismatch. 1 difference is not covered by any rule.');
  });
});
