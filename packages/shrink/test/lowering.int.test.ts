import { parseDiffRules, type Exchange } from '@replay-parity/core';
import { afterEach, describe, expect, it } from 'vitest';
import { shrink } from '../src/index.js';
import { orderExchange, sendJson, startStandIn, type StandIn } from './stand-in.js';

const stands: StandIn[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

/** Answers `{ ok: false }` when any item quantity is at least three, else `{ ok: true }`. */
async function bigOrderDefect(): Promise<StandIn> {
  const stand = await startStandIn((req, res) => {
    const items = (req.body as { items?: { quantity: number }[] }).items ?? [];
    sendJson(res, { ok: !items.some((i) => i.quantity >= 3) });
  });
  stands.push(stand);
  return stand;
}

const noReset = (): Promise<void> => Promise.resolve();

function fixture(): Exchange[] {
  return [
    orderExchange(0, { items: [{ quantity: 1 }], note: 'fine' }),
    orderExchange(1, {
      items: [{ quantity: 10 }, { quantity: 2 }],
      note: 'gift wrap please',
      tags: ['a', 'b'],
      meta: { source: 'web', retries: 3 },
      qty: 7,
    }),
    orderExchange(2, { items: [{ quantity: 1 }] }),
  ];
}

const mismatchOn = (exchange: Exchange | undefined) => ({
  kind: 'mismatch' as const,
  exchangeId: (exchange as Exchange).id,
  path: '$.ok',
});

describe('generic value lowering', () => {
  it('lowers the listed paths and simplifies the others, recording each change', async () => {
    const stand = await bigOrderDefect();
    const exchanges = fixture();
    const rules = parseDiffRules(`
shrink:
  lower: ['$.items[*].quantity']
  simplify: ['$.note', '$.tags', '$.meta']
`);
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset: noReset,
      rule: mismatchOn(exchanges[1]),
      replay: { rules },
      lower: rules.shrink?.lower,
      simplify: rules.shrink?.simplify,
    });
    expect(reproduction.successful).toBe(true);
    expect(reproduction.reduced_steps).toBe(1);
    const step = reproduction.steps[0];
    expect(step?.body).toEqual({
      items: [{ quantity: 3 }, { quantity: 1 }],
      note: '',
      tags: [],
      meta: {},
      qty: 7,
    });
    expect(step?.quantity_reduced).toBe(true);
    expect(step?.changed).toEqual([
      { path: '$.items[0].quantity', from: 10, to: 3 },
      { path: '$.items[1].quantity', from: 2, to: 1 },
      { path: '$.note', from: 'gift wrap please', to: '' },
      { path: '$.tags', from: ['a', 'b'], to: [] },
      { path: '$.meta', from: { source: 'web', retries: 3 }, to: {} },
    ]);
  });

  it('keeps a simplification only when the rule still reproduces', async () => {
    // The defect depends on the note, so the note must survive.
    const stand = await startStandIn((req, res) => {
      const body = req.body as { note?: string };
      sendJson(res, { ok: body.note !== 'bad' });
    });
    stands.push(stand);
    const exchanges = [orderExchange(0, { note: 'bad', tags: ['x'] })];
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset: noReset,
      rule: mismatchOn(exchanges[0]),
      simplify: ['$.note', '$.tags'],
    });
    expect(reproduction.steps[0]?.body).toEqual({ note: 'bad', tags: [] });
    expect(reproduction.steps[0]?.changed).toEqual([{ path: '$.tags', from: ['x'], to: [] }]);
    expect(reproduction.steps[0]?.quantity_reduced).toBe(false);
    expect(reproduction.successful).toBe(true);
  });

  it('lowers nothing for a mismatch rule when lower is absent', async () => {
    const stand = await bigOrderDefect();
    const exchanges = fixture();
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset: noReset,
      rule: mismatchOn(exchanges[1]),
    });
    expect(reproduction.steps[0]?.body).toMatchObject({
      qty: 7,
      items: [{ quantity: 10 }, { quantity: 2 }],
    });
    expect(reproduction.steps[0]?.changed).toBeUndefined();
    expect(reproduction.steps[0]?.quantity_reduced).toBe(false);
  });

  it('leaves values that are not integers above one, or not present, alone', async () => {
    const stand = await bigOrderDefect();
    const exchanges = [
      orderExchange(0, { items: [{ quantity: 4.5 }, { quantity: 'x' }, { quantity: 1 }] }),
      orderExchange(1, { items: [{ quantity: 5 }] }),
    ];
    const { reproduction } = await shrink({
      exchanges,
      target: stand.url,
      reset: noReset,
      rule: mismatchOn(exchanges[1]),
      lower: ['$.items[*].quantity', '$.missing'],
      simplify: ['$.absent'],
    });
    expect(reproduction.reduced_steps).toBe(1);
    expect(reproduction.steps[0]?.body).toEqual({ items: [{ quantity: 3 }] });
  });
});
