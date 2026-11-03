import { describe, expect, it } from 'vitest';
import { Pool } from './pool.js';

describe('Pool', () => {
  it('hands each item to one holder at a time and queues the rest', async () => {
    const pool = new Pool(['a', 'b']);
    const held: string[] = [];
    let peak = 0;
    const work = async (item: string): Promise<string> => {
      held.push(item);
      peak = Math.max(peak, held.length);
      await new Promise((r) => setTimeout(r, 5));
      held.splice(held.indexOf(item), 1);
      return item;
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => pool.use(work)));
    expect(peak).toBe(2);
    expect(results).toHaveLength(6);
    expect(new Set(results)).toEqual(new Set(['a', 'b']));
    expect(pool.size).toBe(2);
  });

  it('gives the item back when the work throws', async () => {
    const pool = new Pool([1]);
    await expect(pool.use(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await pool.use((n) => Promise.resolve(n))).toBe(1);
  });
});
