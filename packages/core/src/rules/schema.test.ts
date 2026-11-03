import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { loadDiffRules } from './load.js';
import { emptyRules, parseDiffRules } from './schema.js';

const example = `
ignore:
  - "$.request_id"
  - "$.timestamps.*"
tolerances:
  - path: "$.total"
    abs: 0.005
  - path: "$.items[*].unit_price"
    rel: 0.0001
unordered:
  - path: "$.items"
    key: "$.sku"
status:
  equivalent:
    - [200, 201]
headers:
  compare: ["content-type"]
substitutions:
  - name: order_id
    capture:
      tag: create-order
      path: "$.order_id"
    apply: [path, body]
`;

describe('the shrink key', () => {
  it('is absent by default and lists the paths to lower and to simplify', () => {
    expect(emptyRules().shrink).toBeUndefined();
    const rules = parseDiffRules(`
shrink:
  lower: ['$.qty', '$.items[*].quantity']
  simplify: ['$.note', '$.tags']
`);
    expect(rules.shrink).toEqual({
      lower: ['$.qty', '$.items[*].quantity'],
      simplify: ['$.note', '$.tags'],
    });
    expect(parseDiffRules('shrink: { simplify: ["$.note"] }').shrink).toEqual({
      simplify: ['$.note'],
    });
  });

  it('rejects an unknown key and a path outside the plain subset', () => {
    expect(() => parseDiffRules('shrink: { raise: ["$.qty"] }')).toThrow(ConfigError);
    expect(() => parseDiffRules('shrink: { lower: ["$..qty"] }')).toThrow(/unsupported JSONPath/);
  });
});

describe('parseDiffRules', () => {
  it('parses the full example', () => {
    const rules = parseDiffRules(example);
    expect(rules.ignore).toEqual(['$.request_id', '$.timestamps.*']);
    expect(rules.tolerances).toEqual([
      { path: '$.total', abs: 0.005 },
      { path: '$.items[*].unit_price', rel: 0.0001 },
    ]);
    expect(rules.unordered).toEqual([{ path: '$.items', key: '$.sku' }]);
    expect(rules.status.equivalent).toEqual([[200, 201]]);
    expect(rules.headers.compare).toEqual(['content-type']);
    expect(rules.substitutions).toEqual([
      {
        name: 'order_id',
        capture: { tag: 'create-order', path: '$.order_id' },
        apply: ['path', 'body'],
      },
    ]);
  });

  it('applies defaults to an empty file', () => {
    expect(parseDiffRules('')).toEqual(emptyRules());
    expect(emptyRules()).toEqual({
      ignore: [],
      tolerances: [],
      unordered: [],
      status: { equivalent: [] },
      headers: { compare: [], ignore: [], masks: [] },
      extra_fields: 'deny',
      extra_fields_rules: [],
      equivalences: { null_absent: false, empty_absent: false, numeric_strings: false },
      decimal: [],
      time: [],
      mask: [],
      substitutions: [],
      controls: { tags: [] },
    });
  });

  it('parses harness control tags', () => {
    const rules = parseDiffRules('controls:\n  tags: [admin-restart, admin-reset]\n');
    expect(rules.controls.tags).toEqual(['admin-restart', 'admin-reset']);
    expect(() => parseDiffRules('controls:\n  tag: [x]\n')).toThrow(/unknown key "tag"/);
  });

  it('defaults substitution apply to every location', () => {
    const rules = parseDiffRules(
      'substitutions:\n  - name: id\n    capture: { tag: t, path: "$.id" }\n',
    );
    expect(rules.substitutions[0]?.apply).toEqual(['path', 'query', 'body']);
  });

  it('rejects unknown keys with their path', () => {
    expect(() => parseDiffRules('tolerance: []', 'rules.yaml')).toThrow(ConfigError);
    expect(() => parseDiffRules('tolerance: []', 'rules.yaml')).toThrow(/unknown key "tolerance"/);
    expect(() => parseDiffRules('tolerances:\n  - path: "$.a"\n    abs: 1\n    rl: 2\n')).toThrow(
      /unknown key "rl" at tolerances\[0\]/,
    );
  });

  it('rejects unsupported JSONPaths at load time', () => {
    expect(() => parseDiffRules('ignore:\n  - "$.a[1:2]"\n')).toThrow(
      /unsupported JSONPath .* at ignore\[0\]/,
    );
    // Rule paths accept filters and descent; keys and captures keep the plain subset.
    expect(() => parseDiffRules('ignore:\n  - "$..deep"\n')).not.toThrow();
    expect(() => parseDiffRules('unordered:\n  - path: "$.items"\n    key: "$..sku"\n')).toThrow(
      /unsupported JSONPath .* at unordered\[0\]\.key/,
    );
  });

  it('rejects a tolerance without abs or rel and a bad substitution name', () => {
    expect(() => parseDiffRules('tolerances:\n  - path: "$.a"\n')).toThrow(/abs, rel, or both/);
    expect(() =>
      parseDiffRules(
        'substitutions:\n  - name: "bad-name"\n    capture: { tag: t, path: "$.id" }\n',
      ),
    ).toThrow(/identifier/);
  });

  it('loads from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-rules-'));
    const path = join(dir, 'diff-rules.yaml');
    await writeFile(path, example);
    expect((await loadDiffRules(path)).unordered).toHaveLength(1);
  });
});
