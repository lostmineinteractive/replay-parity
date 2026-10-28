import { mkdtemp, readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseRecordingText } from '@replay-parity/core';
import { request, type Dispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureServer } from '../src/index.js';

/**
 * Undici ends the upload stream once it is sent, resets it when the upstream
 * answers before reading all of it, and fails it on a socket error, so the
 * bound on the upload wait in the proxy cannot be reached through a real
 * upstream. This file replaces `Pool` with a stand-in upstream that reads one
 * chunk of the request body, answers at once, and never touches the stream
 * again, which is the case the bound exists for. Without the bound the
 * handler would wait on the client forever and this test would time out.
 */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class StallingPool {
    request(options: { body?: Readable | null }): Promise<Dispatcher.ResponseData> {
      const answer = {
        statusCode: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '2' },
        body: Readable.from([Buffer.from('ok')]),
        trailers: {},
        opaque: null,
        context: {},
      } as unknown as Dispatcher.ResponseData;
      const body = options.body ?? null;
      if (body === null) return Promise.resolve(answer);
      return new Promise((resolve) => {
        body.once('data', () => {
          body.pause();
          resolve(answer);
        });
        body.resume();
      });
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, Pool: StallingPool };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** One chunk of a chunked request body. */
function chunk(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n')]);
}

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${deadlineMs} ms`);
    await sleep(5);
  }
}

async function rawClient(port: number): Promise<{ socket: Socket; text: () => string }> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  let received = '';
  socket.on('data', (data: Buffer) => {
    received += data.toString('latin1');
  });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  cleanups.push(() => {
    socket.destroy();
  });
  return { socket, text: () => received };
}

describe('the upload wait', () => {
  it('ends at the upstream timeout, records the bytes seen, and names the exchange', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-capture-'));
    const out = join(dir, 'recording.jsonl');
    const errors: { context: string; message: string }[] = [];
    const capture = await CaptureServer.create({
      target: 'http://stand-in',
      out,
      upstreamTimeoutMs: 200,
      onError: (err, context) => errors.push({ context, message: (err as Error).message }),
    });
    cleanups.push(() => capture.close());
    const addr = await capture.listen({ port: 0, host: '127.0.0.1' });

    // A raw client keeps the connection and the request body open after the
    // response arrives, so nothing but the bound can end the wait.
    const client = await rawClient(addr.port);
    const parts = [Buffer.from('first part '), Buffer.from('second part '), Buffer.from('third')];
    client.socket.write(
      'POST /stall HTTP/1.1\r\nhost: proxy\r\ncontent-type: application/octet-stream\r\ntransfer-encoding: chunked\r\n\r\n',
    );
    client.socket.write(chunk(parts[0]!));
    await waitFor(() => client.text().endsWith('ok'), 5000);
    client.socket.write(chunk(parts[1]!));
    client.socket.write(chunk(parts[2]!));
    await waitFor(() => capture.stats.recorded === 1, 5000);

    expect(client.text().startsWith('HTTP/1.1 200 OK')).toBe(true);
    expect(errors).toEqual([
      {
        context: 'POST /stall upload wait',
        message: 'the upstream did not finish with the request body within 200 ms of the response',
      },
    ]);
    expect(capture.stats).toEqual({ seen: 1, recorded: 1, failed: 0 });

    // The proxy keeps serving after the bounded wait.
    const next = await request(`http://127.0.0.1:${addr.port}/next`);
    expect(next.statusCode).toBe(200);
    expect(await next.body.text()).toBe('ok');

    client.socket.destroy();
    await capture.close();
    const [stalled, after] = parseRecordingText(await readFile(out, 'utf8'));
    expect(stalled?.request).toMatchObject({ method: 'POST', path: '/stall', encoding: 'base64' });
    expect(stalled?.response.body).toBe(Buffer.from('ok').toString('base64'));
    // The recorded body is what the tee saw: at least the chunk the stand-in
    // read, and never more than the client sent, in order.
    const seen = Buffer.from(stalled?.request.body as string, 'base64');
    const sent = Buffer.concat(parts);
    expect(seen.length).toBeGreaterThanOrEqual(parts[0]!.length);
    expect(seen.equals(sent.subarray(0, seen.length))).toBe(true);
    expect(after?.request.path).toBe('/next');
    expect(capture.stats).toEqual({ seen: 2, recorded: 2, failed: 0 });
  });
});
