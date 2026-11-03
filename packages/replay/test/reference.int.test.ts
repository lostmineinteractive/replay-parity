import {
  compileRunValidator,
  jsonResponse,
  makeExchange,
  makeRequest,
  parseDiffRules,
  parseThresholds,
  type RecordedRequest,
  type RunValidator,
} from '@replay-parity/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { replay, SendError, type Adapter } from '../src/index.js';
import { writeRecording } from './helpers.js';

let validate: RunValidator;

beforeAll(async () => {
  validate = await compileRunValidator();
});

const STRICT = parseThresholds('correctness:\n  mismatch_rate_max: 0\n');

/** Five reads recorded with a timestamp the service sets from its clock on every call. */
const reads = Array.from({ length: 5 }, (_, i) =>
  makeExchange({
    index: i,
    tags: ['read'],
    request: makeRequest({ path: `/items/${i}` }),
    response: jsonResponse({ ts: '2026-10-16T20:50:45.469Z', value: i }, 200, 1),
  }),
);

/** A stand-in that answers with a fresh timestamp, as the real service does. */
function clocked(name: string, shift = 0): Adapter & { paths: string[] } {
  const adapter = {
    name,
    paths: [] as string[],
    send(req: RecordedRequest) {
      adapter.paths.push(req.path);
      const value = Number(req.path.split('/').pop());
      return Promise.resolve(
        jsonResponse({ ts: new Date().toISOString(), value: value + shift }, 200, 1),
      );
    },
  };
  return adapter;
}

describe('reference re-replay', () => {
  it('fails on a fresh timestamp without it and passes with it, marking the finding as noise', async () => {
    const recording = await writeRecording(reads);
    const without = await replay({
      recording,
      target: 'fake://',
      adapter: clocked('candidate'),
      pace: 'max',
      thresholds: STRICT,
    });
    expect(without.verdict).toBe('fail');
    expect(without.exchanges[0]?.diff?.findings.map((f) => f.path)).toEqual(['$.ts']);
    expect(without.reference_target).toBeNull();
    expect(without.exchanges[0]?.reference_now).toBeUndefined();
    expect(without.stats.noise_findings).toBeUndefined();

    const reference = clocked('reference');
    const run = await replay({
      recording,
      target: 'fake://',
      adapter: clocked('candidate'),
      referenceTarget: 'http://reference.test',
      referenceAdapter: reference,
      pace: 'max',
      thresholds: STRICT,
    });
    expect(run.verdict).toBe('pass');
    expect(reference.paths).toEqual(reads.map((e) => e.request.path));
    const first = run.exchanges[0]!;
    expect(first.diff?.verdict).toBe('tolerated');
    expect(first.diff?.findings).toEqual([
      expect.objectContaining({
        path: '$.ts',
        kind: 'value',
        tolerated: true,
        rule: 'noise:reference',
        noise: true,
      }),
    ]);
    expect(first.reference_now).toEqual({ status: 200, latency_ms: 1 });
    expect(run.stats.noise_findings).toEqual({ overall: 5, by_tag: { read: 5 } });
    expect(run.stats.overall.mismatches).toBe(0);
    expect(run.reference_target).toBe('http://reference.test');
    expect(validate(run), validate.errors ?? '').toBe(true);
  });

  it('still fails on a real divergence at a path that is not noise', async () => {
    const run = await replay({
      recording: await writeRecording(reads),
      target: 'fake://',
      adapter: clocked('candidate', 1),
      referenceTarget: 'http://reference.test',
      referenceAdapter: clocked('reference'),
      pace: 'max',
      thresholds: STRICT,
    });
    expect(run.verdict).toBe('fail');
    const findings = run.exchanges[0]?.diff?.findings ?? [];
    expect(findings.find((f) => f.path === '$.value')).toMatchObject({
      tolerated: false,
      reference: 0,
      candidate: 1,
    });
    expect(findings.find((f) => f.path === '$.value')?.noise).toBeUndefined();
    expect(findings.find((f) => f.path === '$.ts')).toMatchObject({ noise: true });
    expect(run.stats.overall.mismatches).toBe(5);
  });

  it('names no noise when the reference answers another status or fails to answer', async () => {
    const recording = await writeRecording(reads);
    const broken: Adapter = {
      name: 'reference',
      send: () => Promise.resolve(jsonResponse({ ts: new Date().toISOString() }, 503, 1)),
    };
    const run = await replay({
      recording,
      target: 'fake://',
      adapter: clocked('candidate'),
      referenceTarget: 'http://reference.test',
      referenceAdapter: broken,
      pace: 'max',
      thresholds: STRICT,
    });
    expect(run.verdict).toBe('fail');
    expect(run.exchanges[0]?.reference_now).toEqual({ status: 503, latency_ms: 1 });
    expect(run.stats.noise_findings).toEqual({ overall: 0, by_tag: {} });

    const down: Adapter = {
      name: 'reference',
      send: () => Promise.reject(new SendError('connection', 'refused')),
    };
    const failed = await replay({
      recording,
      target: 'fake://',
      adapter: clocked('candidate'),
      referenceTarget: 'http://reference.test',
      referenceAdapter: down,
      pace: 'max',
      thresholds: STRICT,
    });
    expect(failed.verdict).toBe('fail');
    expect(failed.exchanges[0]?.reference_now).toBeNull();
    expect(failed.exchanges[0]?.error).toBeNull();
  });

  it('gives the reference its own substitution table built from its answers', async () => {
    const rules = parseDiffRules(
      'substitutions:\n  - name: order_id\n    capture: { tag: create-order, path: "$.order_id" }\n',
    );
    const exchanges = [
      makeExchange({
        index: 0,
        tags: ['create-order'],
        request: makeRequest({ method: 'POST', path: '/orders' }),
        response: jsonResponse({ order_id: 'rec-1' }, 201, 1),
      }),
      makeExchange({
        index: 1,
        tags: ['get-order'],
        request: makeRequest({ path: '/orders/rec-1' }),
        response: jsonResponse({ order_id: 'rec-1' }, 200, 1),
      }),
    ];
    const system = (prefix: string): Adapter & { paths: string[] } => {
      const adapter = {
        name: prefix,
        paths: [] as string[],
        send(req: RecordedRequest) {
          adapter.paths.push(`${req.method} ${req.path}`);
          if (req.method === 'POST')
            return Promise.resolve(jsonResponse({ order_id: `${prefix}-1` }, 201, 1));
          return Promise.resolve(
            jsonResponse({ order_id: req.path.split('/').pop() ?? '' }, 200, 1),
          );
        },
      };
      return adapter;
    };
    const candidate = system('cand');
    const reference = system('ref');
    const run = await replay({
      recording: await writeRecording(exchanges),
      target: 'fake://',
      adapter: candidate,
      referenceTarget: 'http://reference.test',
      referenceAdapter: reference,
      pace: 'max',
      rules,
    });
    expect(candidate.paths).toEqual(['POST /orders', 'GET /orders/cand-1']);
    expect(reference.paths).toEqual(['POST /orders', 'GET /orders/ref-1']);
    // The id is tolerated through the substitution on both sides, so nothing is noise.
    expect(run.exchanges.map((e) => e.diff?.verdict)).toEqual(['tolerated', 'tolerated']);
    expect(run.stats.noise_findings?.overall).toBe(0);
  });
});
