import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  createDiffer,
  makeExchange,
  makeRequest,
  makeResponse,
  parseDiffRules,
  type Exchange,
  type JsonValue,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { generalizePath, shapePattern } from '../src/commands/rules.js';
import { checkRules, runCli } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDING = join(ROOT, 'demo/recording.jsonl');

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function rp(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(args, { stdout, stderr });
  return { code, out: stdout.text, err: stderr.text };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rp-rules-'));
}

async function writeRecording(dir: string, name: string, exchanges: Exchange[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}

function exchange(index: number, tags: string[], path: string, body: JsonValue): Exchange {
  return makeExchange({
    index,
    tags,
    request: makeRequest({ method: 'GET', path }),
    response: makeResponse({ status: 200, headers: { etag: `"${index}"` }, body }),
  });
}

describe('rp rules lint', () => {
  it('lists every rule with its scope and match count, warns on zero, and groups by tag', async () => {
    const dir = await tempDir();
    const recording = await writeRecording(dir, 'rec.jsonl', [
      exchange(0, ['list'], '/v1/items', {
        lines: [
          { type: 'fee', amount: '1.00' },
          { type: 'item', amount: '2.00' },
        ],
        meta: { request_id: 'a' },
      }),
      exchange(1, ['get'], '/v1/items/1', { id: 'i-1', at: '2026-01-01T00:00:00Z' }),
    ]);
    await writeFile(join(dir, 'pack.yaml'), 'ignore: ["$..request_id"]\n', 'utf8');
    const rules = join(dir, 'rules.yaml');
    await writeFile(
      rules,
      [
        'include: [pack.yaml]',
        'decimal:',
        '  - path: "$.lines[?(@.type==\'fee\')].amount"',
        '    scale: 2',
        '    when: { tags: [list] }',
        'time:',
        '  - { path: "$.at", abs_ms: 1000, when: { methods: [GET], paths: ["/v1/items/*"] } }',
        'mask:',
        '  - { path: "$.missing", pattern: "x" }',
        'headers:',
        '  compare: [etag]',
        'substitutions:',
        '  - name: item',
        '    capture: { tag: get, path: "$.id" }',
      ].join('\n'),
      'utf8',
    );
    const { code, out, err } = await rp([
      'rules',
      'lint',
      '--rules',
      rules,
      '--recording',
      recording,
    ]);
    expect(err).toBe('');
    expect(code).toBe(0);
    const row = (name: string) => out.split('\n').find((l) => l.includes(` ${name} `)) ?? '';
    expect(row('ignore[0]')).toMatch(
      /^\s+ok\s+ignore\[0\]\s+ignore\s+\$\.\.request_id\s+global\s+1 of 2$/,
    );
    expect(row('decimal[0]')).toMatch(/tags list\s+1 of 1$/);
    expect(row('time[0]')).toMatch(/methods GET; paths \/v1\/items\/\*\s+1 of 1$/);
    expect(row('mask[0]')).toMatch(/^\s+warn\s+mask\[0\].*0 of 2$/);
    expect(row('headers.compare[0]')).toMatch(/2 of 2$/);
    expect(row('substitution:item')).toMatch(
      /\$\.id from the response body \(tag get\)\s+global\s+1 of 1$/,
    );
    expect(out).toContain('warn: mask[0] $.missing (x) matches nothing in its scope (global)');
    expect(out).toContain(
      'get (1 exchange): ignore[0], time[0], mask[0], headers.compare[0], extra_fields, substitution:item',
    );
    expect(out).toContain(
      'list (1 exchange): ignore[0], decimal[0], mask[0], headers.compare[0], extra_fields, substitution:item',
    );
    expect(out).toMatch(/1 warning\n$/);

    const json = await rp(['rules', 'lint', '--rules', rules, '--recording', recording, '--json']);
    const report = JSON.parse(json.out) as {
      warnings: number;
      rows: { name: string; matched: number | null }[];
    };
    expect(report.warnings).toBe(1);
    expect(report.rows.find((r) => r.name === 'extra_fields')?.matched).toBeNull();
  });

  it('lints the demo rules against the demo recording with the scoped unordered rule', async () => {
    const { code, out } = await rp([
      'rules',
      'lint',
      '--rules',
      join(ROOT, 'demo/diff-rules-unordered.yaml'),
      '--recording',
      RECORDING,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(
      /unordered\[0\]\s+unordered\s+\$\.items \(key \$\.sku\)\s+tags list-inventory\s+53 of 53/,
    );
    expect(out).toMatch(/0 warnings\n$/);
  });

  it('loads the example rules with their packs', async () => {
    const { code, out } = await rp([
      'rules',
      'lint',
      '--rules',
      join(ROOT, 'examples/diff-rules.yaml'),
      '--recording',
      RECORDING,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(
      /time\[0\]\s+time\s+\$\.\.created_at \(iso8601, 5000 ms\)\s+global\s+152 of 283/,
    );
    expect(out).toMatch(/mask\[0\]\s+mask\s+\$\.\.request_id/);
    expect(out).toMatch(/headers\.ignore\[0\]\s+header ignore\s+date/);
    expect(out).toMatch(/substitution:shipment_ref\s+substitution\s+header location through/);
  });

  it('exits 1 on a bad rules file', async () => {
    const dir = await tempDir();
    const rules = join(dir, 'bad.yaml');
    await writeFile(rules, 'mask:\n  - { path: "$.a", pattern: "(" }\n', 'utf8');
    const { code, err } = await rp(['rules', 'lint', '--rules', rules, '--recording', RECORDING]);
    expect(code).toBe(1);
    expect(err).toMatch(/bad pattern/);
  });
});

describe('rp rules suggest', () => {
  const ids = [
    ['ord_0000aaaa', 'ord_1234beef'],
    ['ord_00ff00aa', 'ord_9999cccc'],
    ['ord_abcdef01', 'ord_10203040'],
  ];
  const requestIds = [
    ['x9', 'q7Z'],
    ['m3', 'k88'],
    ['Zz', 'p'],
  ];

  function body(i: number, side: 0 | 1): JsonValue {
    const base = Date.UTC(2026, 0, 1, 0, 0, i);
    return {
      id: (ids[i] as string[])[side] as string,
      created_at: new Date(base + side * 250).toISOString(),
      updated_ms: base + side * 40,
      request_id: (requestIds[i] as string[])[side] as string,
      total: i === 1 && side === 1 ? 11 : 10,
      lines: [{ qty: 1 }],
    };
  }

  it('proposes time, mask, and ignore rules with evidence and lists the rest as unexplained', async () => {
    const dir = await tempDir();
    const a = [0, 1, 2].map((i) => exchange(i, ['get'], `/v1/orders/${i}`, body(i, 0)));
    const b = [0, 1, 2].map((i) => exchange(i, ['get'], `/v1/orders/${i}`, body(i, 1)));
    b.push(exchange(3, ['get'], '/v1/extra', {}));
    const first = await writeRecording(dir, 'a.jsonl', a);
    const second = await writeRecording(dir, 'b.jsonl', b);
    const outPath = join(dir, 'suggested.yaml');
    const { code, out, err } = await rp([
      'rules',
      'suggest',
      '--recording',
      first,
      '--recording',
      second,
      '--out',
      outPath,
    ]);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toBe(
      `compared 3 response pairs, 3 with differences: suggested 1 ignore, 2 time, 1 mask, 1 unexplained, written to ${outPath}\n`,
    );
    const text = await readFile(outPath, 'utf8');
    expect(text).toContain(
      '# 3 response pairs compared under empty rules, 3 with differences, 1 exchange unpaired.',
    );
    expect(text).toContain(
      "ignore:\n  # differs 3 times across 3 pairs holding it, with no shape in common\n  - '$.request_id'",
    );
    expect(text).toContain(
      "  # differs 3 times across 3 pairs holding it, every value reads as iso8601, at most 250 ms apart\n  - { path: '$.created_at', abs_ms: 1000, format: iso8601 }",
    );
    expect(text).toContain("  - { path: '$.updated_ms', abs_ms: 1000, format: epoch_ms }");
    expect(text).toContain(
      "mask:\n  # differs 3 times across 3 pairs holding it, all 6 values match the pattern\n  - { path: '$.id', pattern: 'ord_[0-9a-f]{8}' }",
    );
    expect(text).toContain('#   $.total: value 1 across 3 pairs holding it');

    // The file is a valid rules file, and under it only the unexplained difference is left.
    const rules = parseDiffRules(text);
    const differ = createDiffer(rules);
    const verdicts = a.map((x, i) => differ.diff(x.response, (b[i] as Exchange).response));
    expect(verdicts.map((d) => d.verdict)).toEqual(['tolerated', 'mismatch', 'tolerated']);
    expect(verdicts[1]?.findings.filter((f) => !f.tolerated).map((f) => f.path)).toEqual([
      '$.total',
    ]);
  });

  it('suggests nothing for the demo recording against itself', async () => {
    const dir = await tempDir();
    const outPath = join(dir, 'none.yaml');
    const { code, out } = await rp([
      'rules',
      'suggest',
      '--recording',
      RECORDING,
      '--recording',
      RECORDING,
      '--out',
      outPath,
      '--json',
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      pairs: number;
      suggestions: unknown[];
      unexplained: unknown[];
    };
    expect(report.pairs).toBe(283);
    expect(report.suggestions).toEqual([]);
    expect(report.unexplained).toEqual([]);
    const text = await readFile(outPath, 'utf8');
    expect(text).toContain('# No rule to suggest.');
    expect(parseDiffRules(text)).toEqual(parseDiffRules(''));
  });

  it('needs exactly two recordings', async () => {
    const { code, err } = await rp([
      'rules',
      'suggest',
      '--recording',
      RECORDING,
      '--out',
      '/dev/null',
    ]);
    expect(code).toBe(1);
    expect(err).toMatch(/--recording exactly twice/);
  });
});

describe('suggest helpers', () => {
  it('widens indices and keyed segments', () => {
    expect(generalizePath('$.items[3].a')).toBe('$.items[*].a');
    expect(generalizePath('$.items[sku=A-1].a')).toBe('$.items[*].a');
  });

  it('finds a shape only where one exists', () => {
    expect(shapePattern(['ord_12', 'ord_345'])).toBe('ord_[0-9]+');
    expect(shapePattern(['abcd', '0f9e'])).toBe('[0-9a-f]{4}');
    expect(shapePattern(['ab', 'xyz'])).toBeUndefined();
    expect(shapePattern(['a.b-1', 'a.b-2'])).toBe('a\\.b-[0-9]{1}');
    expect(shapePattern(['ord_', 'ord_1'])).toBeUndefined();
    expect(
      shapePattern([
        '123e4567-e89b-12d3-a456-426614174000',
        'A23E4567-E89B-12D3-A456-426614174000',
      ]),
    ).toBe('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
  });
});

describe('rp rules help', () => {
  it('describes every flag', async () => {
    for (const [sub, flags] of [
      ['lint', ['--rules', '--recording', '--json']],
      ['suggest', ['--recording', '--out', '--json']],
    ] as const) {
      const { out } = await rp(['rules', sub, '--help']);
      for (const flag of flags) expect(out).toMatch(new RegExp(`${flag}[^\\n]*\\S+\\s{2,}\\S`));
    }
  });
});

describe('preflight checkRules with scoped rules and header captures', () => {
  it('counts a path rule within its scope, reads header captures, and checks compared headers', () => {
    const exchanges = [
      exchange(0, ['list'], '/v1/items', { at: 1 }),
      makeExchange({
        index: 1,
        tags: ['create'],
        request: makeRequest({ method: 'POST', path: '/v1/items' }),
        response: makeResponse({ status: 201, headers: { location: '/v1/items/9' } }),
      }),
    ];
    const rules = parseDiffRules(
      [
        'ignore:',
        '  - { path: "$.at", when: { tags: [create] } }',
        '  - { path: "$.at", when: { tags: [list] } }',
        'headers:',
        '  compare: [etag, x-none]',
        'substitutions:',
        '  - name: item',
        '    capture: { tag: create, header: location, pattern: "/v1/items/(.+)" }',
      ].join('\n'),
    );
    const lines = checkRules(rules, exchanges).map((c) => `${c.level} ${c.detail}`);
    expect(lines).toContain(
      'ok substitution item captures header:location from 1 of 1 create exchange',
    );
    expect(lines).toContain('warn ignore $.at matches no response body');
    expect(lines.filter((l) => l.startsWith('ok ignore $.at'))).toHaveLength(1);
    expect(lines).toContain('ok headers.compare etag appears in 1 response');
    expect(lines).toContain('warn headers.compare x-none appears in no response');
  });
});
