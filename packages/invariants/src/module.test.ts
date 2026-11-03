import {
  ConfigError,
  InvariantReportSchema,
  jsonResponse,
  makeExchange,
  makeRequest,
  type Exchange,
} from '@replay-parity/core';
import { describe, expect, it } from 'vitest';
import { evaluateInvariants } from './evaluate.js';
import { defaultEpochs, splitAtResets, type BaseCommand, type InvariantModule } from './module.js';
import { ORDER_LIFECYCLE_NAME, ORDER_LIFECYCLE_VERSION } from './order-lifecycle/index.js';
import { Collector } from './outcome.js';

function exchange(index: number, path: string, status = 200): Exchange {
  return makeExchange({
    index,
    request: makeRequest({ method: 'POST', path }),
    response: jsonResponse({ ok: true }, status, 1),
  });
}

function cmd(kind: string, accepted = true): BaseCommand {
  return { kind, accepted, sentMs: 0, ackedMs: 1, id: kind };
}

/** A module that counts accepted writes per epoch and rejects any write to `/bad`. */
const counter: InvariantModule = {
  name: 'counter',
  version: '0.1.0',
  parse(e, index) {
    const path = e.request.path;
    const kind = path === '/reset' ? 'reset' : path === '/noise' ? 'other' : 'write';
    return {
      kind,
      accepted: e.response.status < 300,
      sentMs: e.offset_ms,
      ackedMs: e.offset_ms + e.response.latency_ms,
      id: `${index}:${path}`,
    };
  },
  rules: [
    {
      id: 1,
      name: 'no-bad-write',
      statement: 'No accepted write goes to /bad.',
      check(epoch) {
        const c = new Collector();
        for (const command of epoch.commands) {
          if (command.kind !== 'write') continue;
          c.check();
          if (command.accepted && command.id.endsWith('/bad')) {
            c.violation(
              'write',
              'rejected',
              'accepted',
              'a write to /bad was accepted',
              command.id,
            );
          }
        }
        return c.outcome();
      },
    },
  ],
};

describe('splitAtResets and defaultEpochs', () => {
  it('starts a new epoch at each accepted reset and ignores a rejected one', () => {
    const commands = [cmd('write'), cmd('reset'), cmd('write'), cmd('reset', false), cmd('write')];
    expect(splitAtResets(commands).map((g) => g.map((c) => c.kind))).toEqual([
      ['write'],
      ['reset', 'write', 'reset', 'write'],
    ]);
    expect(defaultEpochs(commands).map((e) => e.start)).toEqual([0, 1]);
    expect(defaultEpochs([])).toEqual([{ start: 0, commands: [] }]);
  });
});

describe('evaluateInvariants with a module', () => {
  it('runs the module rules, records the module, and uses the default hooks', () => {
    const log = [exchange(0, '/a'), exchange(1, '/bad'), exchange(2, '/noise')];
    const report = evaluateInvariants(log, { module: counter, system: 'svc' });
    expect(report.module).toEqual({ name: 'counter', version: '0.1.0', sha256: null });
    expect(report.commands).toBe(2);
    expect(report.snapshots).toEqual({ ledger_reads: 0, stock_reads: 0, order_reads: 0 });
    expect(report.inconclusive).toEqual([]);
    expect(report.violations).toBe(1);
    expect(report.results[0]).toMatchObject({
      id: 1,
      status: 'violated',
      checks: 2,
      evidence: [{ exchange_id: '1:/bad' }],
    });
    expect(InvariantReportSchema.parse(report)).toEqual(report);
  });

  it('merges outcomes across the default epochs', () => {
    const log = [exchange(0, '/a'), exchange(1, '/reset'), exchange(2, '/b')];
    const report = evaluateInvariants(log, { module: counter });
    expect(report.results[0]).toMatchObject({ status: 'holds', checks: 2 });
  });

  it('counts only the stateChanging kinds when the module names them', () => {
    const log = [exchange(0, '/a'), exchange(1, '/reset')];
    const report = evaluateInvariants(log, { module: { ...counter, stateChanging: ['reset'] } });
    expect(report.commands).toBe(1);
  });

  it('records the hash a loaded module carries', () => {
    const sha256 = 'a'.repeat(64);
    const report = evaluateInvariants([], { module: { ...counter, sha256 } });
    expect(report.module?.sha256).toBe(sha256);
    expect(report.results[0]?.status).toBe('not_applicable');
  });

  it('defaults to the built in order lifecycle module', () => {
    const report = evaluateInvariants([]);
    expect(report.module).toEqual({
      name: ORDER_LIFECYCLE_NAME,
      version: ORDER_LIFECYCLE_VERSION,
      sha256: null,
    });
    expect(report.results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('throws a ConfigError naming the rule when a rule throws', () => {
    const broken: InvariantModule = {
      ...counter,
      rules: [
        {
          id: 4,
          name: 'boom',
          statement: 'Throws.',
          check() {
            throw new Error('no epoch for you');
          },
        },
      ],
    };
    expect(() => evaluateInvariants([exchange(0, '/a')], { module: broken })).toThrow(
      new ConfigError('invariant module counter: rule 4 (boom) failed: no epoch for you'),
    );
  });

  it('throws a ConfigError when parse throws', () => {
    const broken: InvariantModule = {
      ...counter,
      parse() {
        throw new Error('bad route');
      },
    };
    expect(() => evaluateInvariants([exchange(0, '/a')], { module: broken })).toThrow(
      'invariant module counter: parse failed: bad route',
    );
  });

  it('rejects a malformed outcome and a malformed inconclusive condition', () => {
    const malformed: InvariantModule = {
      ...counter,
      rules: [
        {
          id: 2,
          name: 'liar',
          statement: 'Returns a status that does not exist.',
          check: () => ({ status: 'fine' as 'holds', checks: 1, evidence: [] }),
        },
      ],
    };
    expect(() => evaluateInvariants([], { module: malformed })).toThrow(
      /rule 2 \(liar\) returned a malformed outcome/,
    );
    const condition: InvariantModule = {
      ...counter,
      inconclusive: () => [{ kind: 'made_up' as 'snapshot_before_ack', detail: 'x' }],
    };
    expect(() => evaluateInvariants([], { module: condition })).toThrow(
      /inconclusive returned a malformed condition/,
    );
  });
});
