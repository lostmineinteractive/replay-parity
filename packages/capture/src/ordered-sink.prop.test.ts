import { setImmediate as nextTurn } from 'node:timers/promises';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OrderedSink } from './ordered-sink.js';

/**
 * Property based tests for the ordered sink. Fixed seed, see
 * packages/core/src/differ/diff.prop.test.ts for how to replay a counterexample.
 */
const SEED = 20261027;
const params = { seed: SEED, numRuns: 200 };

interface Scenario {
  count: number;
  /** The order in which slots complete, a permutation of 0..count-1. */
  order: number[];
  /** Slots that complete with null and produce nothing. */
  nulls: boolean[];
  /** Slots whose emit rejects. */
  failures: boolean[];
  /** Await every completion before the next, or fire them all and wait at the end. */
  awaitEach: boolean;
  /** Emit after a turn of the event loop instead of synchronously. */
  slowEmit: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 1, max: 24 }).chain((count) => {
  const slots = Array.from({ length: count }, (_, i) => i);
  const flags = fc.array(fc.boolean(), { minLength: count, maxLength: count });
  return fc.record({
    count: fc.constant(count),
    order: fc.shuffledSubarray(slots, { minLength: count, maxLength: count }),
    nulls: flags,
    failures: flags,
    awaitEach: fc.boolean(),
    slowEmit: fc.boolean(),
  });
});

describe('OrderedSink properties', () => {
  it('emits items in reservation order under any completion order, and idle resolves', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const out: number[] = [];
        const errors: unknown[] = [];
        const sink = new OrderedSink<number>(
          async (item) => {
            if (s.slowEmit) await nextTurn();
            if (s.failures[item]) throw new Error(`emit ${item} failed`);
            out.push(item);
          },
          (err) => errors.push(err),
        );
        const slots = Array.from({ length: s.count }, () => sink.reserve());
        expect(sink.pending).toBe(s.count);
        const idle = sink.idle();
        const completions: Promise<void>[] = [];
        for (const k of s.order) {
          const done = sink.complete(slots[k] as number, s.nulls[k] ? null : k);
          if (s.awaitEach) await done;
          else completions.push(done);
        }
        await Promise.all(completions);
        await idle;
        await sink.idle();

        const expected = slots.filter((k) => !s.nulls[k] && !s.failures[k]);
        expect(out).toEqual(expected);
        expect(errors).toHaveLength(slots.filter((k) => !s.nulls[k] && s.failures[k]).length);
        expect(sink.pending).toBe(0);
      }),
      params,
    );
  });

  it('never emits a slot before every earlier slot has completed', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const out: number[] = [];
        const sink = new OrderedSink<number>((item) => {
          out.push(item);
          return Promise.resolve();
        });
        const slots = Array.from({ length: s.count }, () => sink.reserve());
        const completed = new Set<number>();
        for (const k of s.order) {
          completed.add(k);
          await sink.complete(slots[k] as number, k);
          // What has been emitted so far is a prefix of the reservation order, and every
          // member of it has completed.
          out.forEach((item, i) => {
            expect(item).toBe(i);
            expect(completed.has(item)).toBe(true);
          });
        }
        expect(out).toEqual(slots);
      }),
      params,
    );
  });
});
