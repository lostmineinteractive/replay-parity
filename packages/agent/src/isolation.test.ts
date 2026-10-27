import { describe, expect, it } from 'vitest';
import { resetByPost, resolveIsolation, runResets } from './isolation.js';

const noop = (): Promise<void> => Promise.resolve();

describe('resolveIsolation', () => {
  it('runs one case at a time whenever a reset is set, else as many as requested', () => {
    expect(resolveIsolation(undefined, undefined)).toEqual({
      reset_between_cases: false,
      case_concurrency: 1,
    });
    expect(resolveIsolation({}, 4)).toEqual({ reset_between_cases: false, case_concurrency: 4 });
    expect(resolveIsolation({ candidate: noop }, 4)).toEqual({
      reset_between_cases: true,
      case_concurrency: 1,
    });
    expect(resolveIsolation({ reference: noop }, undefined)).toEqual({
      reset_between_cases: true,
      case_concurrency: 1,
    });
    expect(resolveIsolation(undefined, 0)).toEqual({
      reset_between_cases: false,
      case_concurrency: 1,
    });
    expect(resolveIsolation(undefined, 2.9)).toEqual({
      reset_between_cases: false,
      case_concurrency: 2,
    });
  });
});

describe('resetByPost', () => {
  it('posts to the URL, reads the body, and fails outside 2xx', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const answer = (status: number): typeof fetch => {
      return (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: init?.method });
        return Promise.resolve(new Response(status === 204 ? null : 'ok', { status }));
      };
    };
    await resetByPost('http://127.0.0.1:1/admin/reset', answer(204))();
    await resetByPost('http://127.0.0.1:1/admin/reset', answer(200))();
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:1/admin/reset', method: 'POST' },
      { url: 'http://127.0.0.1:1/admin/reset', method: 'POST' },
    ]);
    await expect(resetByPost('http://127.0.0.1:1/admin/reset', answer(500))()).rejects.toThrow(
      'reset http://127.0.0.1:1/admin/reset answered 500',
    );
  });
});

describe('runResets', () => {
  it('runs every hook that is set and rejects on the first failure', async () => {
    const order: string[] = [];
    const push = (name: string) => (): Promise<void> => {
      order.push(name);
      return Promise.resolve();
    };
    await runResets(undefined);
    await runResets({});
    await runResets({ reference: push('reference'), candidate: push('candidate') });
    await runResets({ candidate: push('candidate only') });
    expect(order).toEqual(['reference', 'candidate', 'candidate only']);
    await expect(
      runResets({ reference: () => Promise.reject(new Error('down')), candidate: noop }),
    ).rejects.toThrow('down');
  });
});
