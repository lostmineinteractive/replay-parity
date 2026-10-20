import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  makeRun,
  parseThresholds,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { buildUserPrompt } from './agent.js';
import {
  ROUND_VARYING_HEADING,
  cachePrefixLength,
  loadPrompts,
  renderTemplate,
} from './prompts.js';
import { describeShapes, summarizeRun } from './summary.js';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('prompts', () => {
  it('loads both files with a content version', () => {
    const prompts = loadPrompts();
    expect(prompts.system.text).toContain('Answer with one JSON object');
    expect(prompts.round.text).toContain('{{summary}}');
    expect(prompts.versions).toEqual({
      'system.md': prompts.system.version,
      'round.md': prompts.round.version,
    });
    expect(prompts.system.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('renders placeholders and leaves unknown ones visible', () => {
    expect(renderTemplate('a {{x}} b {{y}}', { x: '1' })).toBe('a 1 b {{y}}');
  });

  it('keeps everything that changes between rounds below the kept heading', () => {
    const prompts = loadPrompts();
    const template = prompts.round.text;
    const varying = template.indexOf(ROUND_VARYING_HEADING);
    expect(varying).toBeGreaterThan(0);
    const stable = template.slice(0, varying);
    for (const placeholder of ['{{round}}', '{{max_rounds}}', '{{count}}', '{{kept}}']) {
      expect(stable).not.toContain(placeholder);
      expect(template.slice(varying)).toContain(placeholder);
    }
    const options = { run: makeRun(), recording: [], maxRounds: 3, casesPerRound: 4 };
    const first = buildUserPrompt(prompts, options, 1, []);
    const second = buildUserPrompt(prompts, options, 2, [
      {
        id: 'case-1-1',
        round: 1,
        hypothesis: 'h',
        tags: ['create-item'],
        steps: [{ request: makeRequest() }],
        repeat: 1,
        dedupe_key: 'mismatch:$.total',
        reference: null,
        candidate: null,
        latency: null,
        error: null,
        diff: null,
        latency_breach: null,
        revealed: 'r',
      },
    ]);
    const n = cachePrefixLength(first);
    expect(n).toBeGreaterThan(0);
    expect(cachePrefixLength(second)).toBe(n);
    expect(second.slice(0, n)).toBe(first.slice(0, n));
    expect(second.slice(n)).toContain('case-1-1');
    expect(second.slice(n)).toContain('Round 2 of 3');
    expect(cachePrefixLength('no heading here')).toBe(0);
  });
});

describe('what the model sees', () => {
  const secret = 'Bearer sk-live-SENTINEL-DO-NOT-LEAK';
  const recording = [
    makeExchange({
      index: 0,
      tags: ['create-order'],
      request: makeRequest({
        method: 'POST',
        path: '/v1/orders',
        headers: {
          authorization: secret,
          cookie: 'session=SENTINEL2',
          'x-api-key': 'SENTINEL3',
          'content-type': 'application/json',
          'idempotency-key': 'k-1',
          'x-tenant': 'acme',
        },
        body: { sku: 'A-100', qty: 3 },
      }),
      response: jsonResponse({ order_id: 'o-1', total: 29.99 }, 201),
    }),
    makeExchange({
      index: 1,
      tags: ['get-order'],
      request: makeRequest({ path: '/v1/orders/o-1', headers: { authorization: secret } }),
      response: jsonResponse({ order_id: 'o-1' }),
    }),
  ];

  it('never shows a header value outside the allowlist, even when the recording was not redacted', () => {
    const shapes = describeShapes(recording);
    expect(shapes).not.toContain('SENTINEL');
    expect(shapes).not.toContain('acme');
    expect(shapes).toContain('"authorization":"<redacted>"');
    expect(shapes).toContain('"idempotency-key":"k-1"');
    expect(shapes).toContain('create-order: POST /v1/orders');
    expect(shapes).toContain('response keys: order_id, total');
    const prompt = buildUserPrompt(
      loadPrompts(),
      { run: makeRun(), recording, maxRounds: 2, casesPerRound: 4 },
      1,
      [],
    );
    expect(prompt).not.toContain('SENTINEL');
    expect(prompt).toContain('Round 1 of 2');
    expect(prompt).toContain('Propose at most 4 new cases');
    expect(prompt).toContain('None yet.');
  });

  it('summarizes the run with failed rows, mismatching paths, and samples', () => {
    const run = makeRun({ thresholds: parseThresholds('correctness:\n  mismatch_rate_max: 0\n') });
    const text = summarizeRun(run);
    expect(text).toContain('Verdict: fail');
    expect(text).toContain(
      'Threshold rows that did not pass: correctness.mismatch_rate_max (fail, limit 0, measured 0.5)',
    );
    expect(text).toContain('Mismatches by tag: create-item: 1 of 1 mismatch');
    expect(text).toContain('Mismatching paths: $.total (1)');
    expect(text).toContain(
      '- POST /v1/items [create-item] status 201 vs 201: $.total 12.38 vs 12.37',
    );
  });

  it('builds prompts from the run and recording alone, never from the defect fixtures', () => {
    const dir = join(ROOT, 'fixtures/defects');
    const sentences: string[] = [];
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name, 'cause.md'), 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.replace(/^[#\-*\s]+/, '').trim();
        if (trimmed.length > 40) sentences.push(trimmed);
      }
    }
    expect(sentences.length).toBeGreaterThan(8);
    const prompts = loadPrompts();
    const prompt = buildUserPrompt(
      prompts,
      { run: makeRun(), recording, maxRounds: 3, casesPerRound: 8 },
      2,
      [],
    );
    for (const sentence of sentences) {
      expect(prompt).not.toContain(sentence);
      expect(prompts.system.text).not.toContain(sentence);
    }
    expect(prompt).not.toContain('cause.md');
    expect(prompt).not.toContain('fixtures/defects');
  });
});
