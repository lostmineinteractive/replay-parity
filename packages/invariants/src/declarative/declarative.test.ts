import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseInvariantSource,
  type Exchange,
  type InvariantResult,
  type JsonValue,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { evaluateInvariants } from '../evaluate.js';
import { loadDeclarativeRules, parseDeclarativeRules } from './module.js';
import { asNumber, compileSource, readKey, readSource } from './source.js';

interface StepOptions {
  headers?: Record<string, string>;
  /** Send time in milliseconds. Default: 100 per step, so steps never overlap. */
  at?: number;
  latency?: number;
  query?: Record<string, string>;
}

/** A small recording builder. Each call appends one exchange. */
class Log {
  readonly exchanges: Exchange[] = [];

  add(
    tag: string,
    method: string,
    path: string,
    body: JsonValue | null,
    status: number,
    response: JsonValue,
    options: StepOptions = {},
  ): this {
    const index = this.exchanges.length;
    this.exchanges.push(
      makeExchange({
        index,
        tags: [tag],
        offset_ms: options.at ?? index * 100,
        request: makeRequest({
          method,
          path,
          ...(body === null ? {} : { body }),
          headers: options.headers ?? {},
          query: options.query ?? {},
        }),
        response: jsonResponse(response, status, options.latency ?? 10),
      }),
    );
    return this;
  }

  id(i: number): string {
    return (this.exchanges[i] as Exchange).id;
  }
}

function evaluate(yaml: string, log: Log): InvariantResult[] {
  const module = parseDeclarativeRules(yaml, 'invariants.yaml');
  return evaluateInvariants(log.exchanges, { module }).results;
}

function only(yaml: string, log: Log): InvariantResult {
  const results = evaluate(yaml, log);
  expect(results).toHaveLength(1);
  return results[0] as InvariantResult;
}

describe('sources', () => {
  const exchange = makeExchange({
    request: makeRequest({
      method: 'PUT',
      path: '/kv/alpha?x=1',
      headers: { 'idempotency-key': 'k1' },
      query: { page: ['2', '3'] },
      body: { value: 'v', n: 3 },
    }),
    response: { ...jsonResponse({ version: 4 }), headers: { etag: 'e1' } },
  });

  it('reads bodies, headers, query parameters, and path groups', () => {
    const read = (text: string): JsonValue | undefined => readSource(compileSource(text), exchange);
    expect(read('$.version')).toBe(4);
    expect(read('request:$.value')).toBe('v');
    expect(read('header:ETag')).toBe('e1');
    expect(read('request-header:idempotency-key')).toBe('k1');
    expect(read('query:page')).toBe('2');
    expect(read('path:^/kv/([^/]+)$')).toBe('alpha');
    expect(read('path:^/kv/')).toBe('/kv/');
    expect(read('path:^/nope/(.+)')).toBeUndefined();
    expect(readKey(compileSource('request:$.n'), exchange)).toBe('3');
    expect(readKey(compileSource('request:$'), exchange)).toBeUndefined();
  });

  it('rejects malformed sources with a reason', () => {
    expect(parseInvariantSource('body.x')).toMatch(/unsupported source/);
    expect(parseInvariantSource('request:$..x')).toMatch(/unsupported JSONPath/);
    expect(parseInvariantSource('header:')).toBe('header: needs a header name');
    expect(parseInvariantSource('query:')).toBe('query: needs a parameter name');
    expect(parseInvariantSource('path:')).toBe('path: needs a pattern');
    expect(parseInvariantSource('path:(')).toMatch(/invalid pattern/);
    expect(() => compileSource('nope')).toThrow(ConfigError);
  });

  it('reads numbers and numeric strings as numbers', () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber('2.5')).toBe(2.5);
    expect(asNumber('')).toBeUndefined();
    expect(asNumber('x')).toBeUndefined();
    expect(asNumber(null)).toBeUndefined();
  });
});

describe('the rules file', () => {
  it('names the problem and the file', () => {
    expect(() => parseDeclarativeRules('{}', 'invariants.yaml')).toThrow(
      'invariants.yaml: the file defines no rules at (root)',
    );
    expect(() => parseDeclarativeRules('surprise: 1', 'invariants.yaml')).toThrow(
      /unknown key "surprise"/,
    );
    expect(() =>
      parseDeclarativeRules("monotonic: [{ path: 'nope', key: '$.id' }]", 'invariants.yaml'),
    ).toThrow(/unsupported source "nope" .* at monotonic\[0\]\.path/);
    expect(() =>
      parseDeclarativeRules(
        "monotonic: [{ name: a, path: '$.v', key: '$.id' }, { name: a, path: '$.w', key: '$.id' }]",
        'invariants.yaml',
      ),
    ).toThrow('invariants.yaml: invariant rules: the name a is used twice');
    expect(() =>
      parseDeclarativeRules(
        "read_your_writes: [{ write_tag: w, read_tag: r, substitution: '$.id', fields: ['header:x'] }]",
        'invariants.yaml',
      ),
    ).toThrow(/a field given as text is a body path/);
  });

  it('numbers rules in file order and names them by kind', () => {
    const module = parseDeclarativeRules(
      [
        'conservation:',
        "  - { delta_of: { tag: d, path: 'request:$.n' }, equals_change_in: { tag: r, path: '$.n' } }",
        'idempotency: { header: Idempotency-Key }',
        "monotonic: [{ path: '$.v', key: '$.id' }, { name: second, path: '$.w', key: '$.id' }]",
        "read_your_writes: [{ write_tag: w, read_tag: r, substitution: '$.id', fields: ['$.v'] }]",
        "transitions: { path: '$.s', key: '$.id', allowed: { A: [B] } }",
      ].join('\n'),
      'invariants.yaml',
    );
    expect(module.name).toBe('declarative');
    expect(module.rules.map((r) => [r.id, r.name])).toEqual([
      [1, 'idempotency-1'],
      [2, 'monotonic-1'],
      [3, 'second'],
      [4, 'read-your-writes-1'],
      [5, 'transitions-1'],
      [6, 'conservation-1'],
    ]);
  });

  it('loads a file, records its hash, and names a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-declarative-'));
    const path = join(dir, 'invariants.yaml');
    const text = "monotonic: [{ path: '$.v', key: '$.id' }]\n";
    await writeFile(path, text);
    const module = await loadDeclarativeRules(path);
    expect(module.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    const report = evaluateInvariants([], { module });
    expect(report.module).toEqual({ name: 'declarative', version: '1.0.0', sha256: module.sha256 });
    await expect(loadDeclarativeRules(join(dir, 'missing.yaml'))).rejects.toThrow(ConfigError);
  });

  it('starts a new epoch at the reset tag and counts writes as commands', () => {
    const yaml = "reset_tag: reset\nmonotonic: [{ path: '$.v', key: '$.id' }]";
    const log = new Log()
      .add('get', 'GET', '/c/a', null, 200, { id: 'a', v: 5 })
      .add('reset', 'POST', '/admin/reset', null, 200, {})
      .add('get', 'GET', '/c/a', null, 200, { id: 'a', v: 1 });
    const module = parseDeclarativeRules(yaml, 'invariants.yaml');
    const report = evaluateInvariants(log.exchanges, { module });
    expect(report.results[0]?.status).toBe('not_applicable');
    expect(report.commands).toBe(1);
  });
});

describe('idempotency', () => {
  const yaml = 'idempotency: { header: Idempotency-Key, by_payload: true, tag: create }';
  const key = (k: string): StepOptions => ({ headers: { 'idempotency-key': k } });

  it('holds for a replayed response and a rejected conflicting payload', () => {
    const log = new Log()
      .add('create', 'POST', '/o', { qty: 1 }, 201, { id: 'o-1' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 1 }, 201, { id: 'o-1' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 2 }, 422, { error: 'conflict' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 2 }, 201, { id: 'o-2' });
    expect(only(yaml, log)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a second effect, an accepted conflict, and a rejected retry', () => {
    const log = new Log()
      .add('create', 'POST', '/o', { qty: 1 }, 201, { id: 'o-1' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 1 }, 201, { id: 'o-9' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 2 }, 201, { id: 'o-3' }, key('k1'))
      .add('create', 'POST', '/o', { qty: 1 }, 409, { error: 'busy' }, key('k1'));
    const r = only(yaml, log);
    expect(r.status).toBe('violated');
    expect(r.evidence.map((e) => [e.exchange_id, e.detail])).toEqual([
      [log.id(2), `a different payload was accepted under the same key in exchange ${log.id(2)}`],
      [log.id(1), `a retry answered differently from exchange ${log.id(0)}`],
      [log.id(3), `a retry was rejected after exchange ${log.id(0)} had been accepted`],
    ]);
    expect(r.evidence[0]?.subject).toBe('idempotency-key k1');
  });

  it('compares by the identity path and ignores the payload when by_payload is false', () => {
    const relaxed = "idempotency: { header: idempotency-key, by_payload: false, identity: '$.id' }";
    const log = new Log()
      .add('create', 'POST', '/o', { qty: 1 }, 201, { id: 'o-1', at: 1 }, key('k1'))
      .add('create', 'POST', '/o', { qty: 5 }, 200, { id: 'o-1', at: 2 }, key('k1'));
    expect(only(relaxed, log).status).toBe('holds');
    log.add('create', 'POST', '/o', { qty: 1 }, 200, { id: 'o-7' }, key('k1'));
    expect(only(relaxed, log).evidence[0]).toMatchObject({
      expected: 'o-1',
      observed: 'o-7',
      exchange_id: log.id(2),
    });
  });

  it('is inconclusive for a rejection that overlapped the accepted request', () => {
    const log = new Log()
      .add(
        'create',
        'POST',
        '/o',
        { qty: 1 },
        201,
        { id: 'o-1' },
        { ...key('k1'), at: 0, latency: 50 },
      )
      .add(
        'create',
        'POST',
        '/o',
        { qty: 1 },
        409,
        { error: 'in progress' },
        { ...key('k1'), at: 10 },
      );
    const r = only(yaml, log);
    expect(r.status).toBe('inconclusive');
    expect(r.detail).toContain(`retry ${log.id(1)} was rejected while ${log.id(0)} was in flight`);
  });
});

describe('monotonic', () => {
  const yaml = "monotonic: [{ path: '$.version', key: 'path:^/kv/([^/]+)$', tag: get }]";

  it('holds when versions never go back, per key', () => {
    const log = new Log()
      .add('get', 'GET', '/kv/a', null, 200, { version: 1 })
      .add('get', 'GET', '/kv/b', null, 200, { version: 7 })
      .add('get', 'GET', '/kv/a', null, 200, { version: '2' })
      .add('get', 'GET', '/kv/a', null, 404, { version: 0 })
      .add('other', 'GET', '/kv/a', null, 200, { version: 0 });
    expect(only(yaml, log)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a value that went down after an earlier response was acknowledged', () => {
    const log = new Log()
      .add('get', 'GET', '/kv/a', null, 200, { version: 3 })
      .add('get', 'GET', '/kv/a', null, 200, { version: 2 });
    expect(only(yaml, log).evidence).toEqual([
      {
        subject: 'path:^/kv/([^/]+)$ a',
        expected: 'at least 3',
        observed: 2,
        detail: `$.version went down after exchange ${log.id(0)}`,
        exchange_id: log.id(1),
      },
    ]);
  });

  it('is inconclusive when the responses overlapped or the value is not a number', () => {
    const overlap = new Log()
      .add('get', 'GET', '/kv/a', null, 200, { version: 3 }, { at: 0, latency: 50 })
      .add('get', 'GET', '/kv/a', null, 200, { version: 2 }, { at: 10 });
    expect(only(yaml, overlap)).toMatchObject({ status: 'inconclusive', checks: 1 });
    const text = new Log().add('get', 'GET', '/kv/a', null, 200, { version: 'v3' });
    expect(only(yaml, text).detail).toContain('$.version in');
  });
});

describe('read your writes', () => {
  const yaml = [
    'read_your_writes:',
    "  - { write_tag: put, read_tag: get, substitution: 'path:^/kv/([^/]+)$', fields: ['$.value', { write: 'header:etag', read: 'request-header:if-match' }] }",
  ].join('\n');
  const etag = (e: string): StepOptions => ({ headers: { 'if-match': e } });

  function put(
    log: Log,
    key: string,
    value: string,
    etagValue: string,
    options: StepOptions = {},
  ): Log {
    log.add('put', 'PUT', `/kv/${key}`, { value }, 200, { ok: true }, options);
    const last = log.exchanges[log.exchanges.length - 1] as Exchange;
    last.response.headers = { etag: etagValue };
    return log;
  }

  it('holds when each read shows the last acknowledged write', () => {
    const log = put(new Log(), 'a', 'one', 'e1');
    put(log, 'a', 'two', 'e2');
    log
      .add('get', 'GET', '/kv/a', null, 200, { value: 'two' }, etag('e2'))
      .add('get', 'GET', '/kv/b', null, 200, { value: 'x' }, etag('e9'));
    expect(only(yaml, log)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a stale read and names it', () => {
    const log = put(new Log(), 'a', 'one', 'e1');
    put(log, 'a', 'two', 'e2');
    log.add('get', 'GET', '/kv/a', null, 200, { value: 'one' }, etag('e2'));
    const r = only(yaml, log);
    expect(r.status).toBe('violated');
    expect(r.evidence).toEqual([
      {
        subject: 'path:^/kv/([^/]+)$ a at $.value',
        expected: 'two',
        observed: 'one',
        detail: `the read did not show what exchange ${log.id(1)} wrote`,
        exchange_id: log.id(2),
      },
    ]);
  });

  it('is inconclusive when the read overlapped a write or the write has no value', () => {
    const overlap = put(new Log(), 'a', 'one', 'e1');
    put(overlap, 'a', 'two', 'e2', { at: 150, latency: 100 });
    overlap.add('get', 'GET', '/kv/a', null, 200, { value: 'one' }, { ...etag('e1'), at: 200 });
    expect(only(yaml, overlap).detail).toContain(`overlapped write ${overlap.id(1)}`);
    const missing = new Log().add('put', 'PUT', '/kv/a', { other: 1 }, 200, {});
    missing.add('get', 'GET', '/kv/a', null, 200, { value: 'x' }, etag('e'));
    expect(only(yaml, missing)).toMatchObject({ status: 'inconclusive' });
  });
});

describe('transitions', () => {
  const yaml = [
    'transitions:',
    "  path: '$.status'",
    "  key: '$.id'",
    '  allowed: { OPEN: [PARTIAL, CANCELED], PARTIAL: [DONE] }',
  ].join('\n');

  it('holds for allowed moves, including a move that skips a sampled state', () => {
    const log = new Log()
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'OPEN' })
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'OPEN' })
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'DONE' })
      .add('get', 'GET', '/o/2', null, 200, { id: 2, status: 'CANCELED' });
    expect(only(yaml, log)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a move out of a final state', () => {
    const log = new Log()
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'CANCELED' })
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'OPEN' });
    expect(only(yaml, log).evidence).toEqual([
      {
        subject: '$.id 1',
        expected: [],
        observed: 'OPEN',
        detail: `CANCELED cannot move to OPEN; the earlier state was seen in exchange ${log.id(0)}`,
        exchange_id: log.id(1),
      },
    ]);
  });

  it('is inconclusive when the two observations overlapped', () => {
    const log = new Log()
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'DONE' }, { at: 0, latency: 50 })
      .add('get', 'GET', '/o/1', null, 200, { id: 1, status: 'OPEN' }, { at: 10 });
    expect(only(yaml, log)).toMatchObject({ status: 'inconclusive', checks: 1 });
  });
});

describe('conservation', () => {
  const yaml = [
    'conservation:',
    "  - delta_of: { tag: incr, path: 'request:$.by' }",
    "    equals_change_in: { tag: get, path: '$.value', key: 'path:^/counters/([^/]+)' }",
  ].join('\n');

  it('holds when each change equals the sum of the accepted deltas for its key', () => {
    const log = new Log()
      .add('get', 'GET', '/counters/a', null, 200, { value: 10 })
      .add('incr', 'POST', '/counters/a/incr', { by: 2 }, 200, {})
      .add('incr', 'POST', '/counters/a/incr', { by: 0.5 }, 200, {})
      .add('incr', 'POST', '/counters/a/incr', { by: 100 }, 400, {})
      .add('incr', 'POST', '/counters/b/incr', { by: 7 }, 200, {})
      .add('get', 'GET', '/counters/a', null, 200, { value: '12.5' });
    expect(only(yaml, log)).toMatchObject({ status: 'holds', checks: 1 });
  });

  it('flags a change that does not match and names the interval', () => {
    const log = new Log()
      .add('get', 'GET', '/counters/a', null, 200, { value: 10 })
      .add('incr', 'POST', '/counters/a/incr', { by: 2 }, 200, {})
      .add('get', 'GET', '/counters/a', null, 200, { value: 14 });
    expect(only(yaml, log).evidence).toEqual([
      {
        subject: `path:^/counters/([^/]+) a between exchanges ${log.id(0)} and ${log.id(2)}`,
        expected: 2,
        observed: 4,
        detail: '1 accepted incr command adds up to 2, and $.value changed by 4',
        exchange_id: log.id(2),
      },
    ]);
  });

  it('is inconclusive when a delta overlapped a read or has no key', () => {
    const overlap = new Log()
      .add('get', 'GET', '/counters/a', null, 200, { value: 10 }, { at: 0, latency: 50 })
      .add('incr', 'POST', '/counters/a/incr', { by: 2 }, 200, {}, { at: 20 })
      .add('get', 'GET', '/counters/a', null, 200, { value: 12 }, { at: 200 });
    expect(only(yaml, overlap).detail).toContain(`command ${overlap.id(1)} overlapped a read`);
    const keyless = new Log()
      .add('get', 'GET', '/counters/a', null, 200, { value: 10 })
      .add('incr', 'POST', '/bulk', { by: 2 }, 200, {})
      .add('get', 'GET', '/counters/a', null, 200, { value: 12 });
    expect(only(yaml, keyless).detail).toContain(`command ${keyless.id(1)} has no key`);
  });
});

describe('a body the recording did not keep', () => {
  /** Replaces the response body of the last exchange with the hash a capped capture stores. */
  function truncate(log: Log): Log {
    const response = (log.exchanges[log.exchanges.length - 1] as Exchange).response;
    delete response.body;
    response.truncated = true;
    response.body_sha256 = 'a'.repeat(64);
    response.body_size = 4_000_000;
    return log;
  }

  it('is inconclusive rather than a violation for every rule kind that reads it', () => {
    const monotonic = truncate(
      new Log()
        .add('get', 'GET', '/kv/a', null, 200, { id: 'a', v: 1 })
        .add('get', 'GET', '/kv/a', null, 200, {}),
    );
    expect(only("monotonic: [{ path: '$.v', key: 'path:^/kv/(.+)$' }]", monotonic).status).toBe(
      'inconclusive',
    );
    const ryw = truncate(
      new Log()
        .add('put', 'PUT', '/kv/a', { value: 'x' }, 200, {})
        .add('get', 'GET', '/kv/a', null, 200, {}),
    );
    const rywRules =
      "read_your_writes: [{ write_tag: put, read_tag: get, substitution: 'path:^/kv/(.+)$', fields: ['$.value'] }]";
    expect(only(rywRules, ryw)).toMatchObject({ status: 'inconclusive' });
    expect(only(rywRules, ryw).detail).toContain(`the body of read ${ryw.id(1)} was not kept`);
    const transitions = truncate(
      new Log()
        .add('get', 'GET', '/o/1', null, 200, { status: 'A' })
        .add('get', 'GET', '/o/1', null, 200, {}),
    );
    expect(
      only(
        "transitions: { path: '$.status', key: 'path:^/o/(.+)$', allowed: { A: [B] } }",
        transitions,
      ).status,
    ).toBe('inconclusive');
    const conservation = truncate(
      new Log()
        .add('get', 'GET', '/c', null, 200, { value: 1 })
        .add('get', 'GET', '/c', null, 200, {}),
    );
    expect(
      only(
        "conservation: [{ delta_of: { tag: incr, path: 'request:$.by' }, equals_change_in: { tag: get, path: '$.value' } }]",
        conservation,
      ).status,
    ).toBe('inconclusive');
  });
});
