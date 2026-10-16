import { describe, expect, it } from 'vitest';
import { OrderedSink } from './ordered-sink.js';

describe('OrderedSink', () => {
  it('emits in reservation order regardless of completion order', async () => {
    const out: number[] = [];
    const sink = new OrderedSink<number>((n) => {
      out.push(n);
      return Promise.resolve();
    });
    const a = sink.reserve();
    const b = sink.reserve();
    const c = sink.reserve();
    await sink.complete(c, 3);
    expect(out).toEqual([]);
    await sink.complete(b, 2);
    expect(out).toEqual([]);
    await sink.complete(a, 1);
    expect(out).toEqual([1, 2, 3]);
    expect(sink.pending).toBe(0);
  });

  it('skips null slots and resolves idle when everything is flushed', async () => {
    const out: string[] = [];
    const sink = new OrderedSink<string>((s) => {
      out.push(s);
      return Promise.resolve();
    });
    const a = sink.reserve();
    const b = sink.reserve();
    const idle = sink.idle();
    let idleResolved = false;
    void idle.then(() => {
      idleResolved = true;
    });
    await sink.complete(a, null);
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    await sink.complete(b, 'b');
    await idle;
    expect(out).toEqual(['b']);
    await expect(sink.idle()).resolves.toBeUndefined();
  });

  it('reports emit failures and keeps going', async () => {
    const errors: unknown[] = [];
    const out: number[] = [];
    const sink = new OrderedSink<number>(
      (n) => {
        if (n === 2) return Promise.reject(new Error('disk full'));
        out.push(n);
        return Promise.resolve();
      },
      (err) => errors.push(err),
    );
    const slots = [sink.reserve(), sink.reserve(), sink.reserve()];
    await Promise.all(slots.map((s, i) => sink.complete(s, i + 1)));
    expect(out).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  it('rejects completing an unknown or already completed slot', async () => {
    const sink = new OrderedSink<number>(() => Promise.resolve());
    const a = sink.reserve();
    await sink.complete(a, 1);
    await expect(sink.complete(a, 1)).rejects.toThrow(/not pending/);
    await expect(sink.complete(42, 1)).rejects.toThrow(/not pending/);
  });
});
