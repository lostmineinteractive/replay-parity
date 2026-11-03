import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  type RecordedRequest,
  type RecordedResponse,
} from '@replay-parity/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpAdapter,
  replayExchanges,
  type Adapter,
  type ReplayContext,
  type ReplayProgress,
} from '../src/index.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0)) await fn();
});

/** A server that keeps the headers of every request it gets. */
async function recordingServer(): Promise<{ url: string; headers: IncomingHttpHeaders[] }> {
  const headers: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    headers.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

function context(extra: Partial<ReplayContext> = {}): ReplayContext {
  return {
    id: 'ex-1',
    index: 0,
    tags: [],
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('the HTTP adapter and traceparent', () => {
  it('sends the traceparent of the context', async () => {
    const server = await recordingServer();
    const adapter = new HttpAdapter(server.url);
    closers.push(() => adapter.close());
    await adapter.send(makeRequest({ path: '/v1/items' }), context({ traceparent: TRACEPARENT }));
    expect(server.headers[0]?.traceparent).toBe(TRACEPARENT);
  });

  it('sends it over a recorded traceparent header', async () => {
    const server = await recordingServer();
    const adapter = new HttpAdapter(server.url);
    closers.push(() => adapter.close());
    const request = makeRequest({
      path: '/v1/items',
      headers: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
    });
    await adapter.send(request, context({ traceparent: TRACEPARENT }));
    expect(server.headers[0]?.traceparent).toBe(TRACEPARENT);
  });

  it('sends none when the context has none', async () => {
    const server = await recordingServer();
    const adapter = new HttpAdapter(server.url);
    closers.push(() => adapter.close());
    await adapter.send(makeRequest({ path: '/v1/items' }), context());
    expect(server.headers[0]).toBeDefined();
    expect(server.headers[0]?.traceparent).toBeUndefined();
  });
});

/** An adapter that answers 200 after `delayMs`. */
function slowAdapter(delayMs: number): Adapter {
  return {
    name: 'slow',
    send: async (_req: RecordedRequest): Promise<RecordedResponse> => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { status: 200, headers: {}, latency_ms: delayMs, body: { ok: true } };
    },
  };
}

async function replayWith(adapter: Adapter, heartbeatMs: number): Promise<ReplayProgress[]> {
  const exchange = makeExchange({
    request: makeRequest({ path: '/v1/items' }),
    response: jsonResponse({ ok: true }),
  });
  const events: ReplayProgress[] = [];
  await replayExchanges([exchange], {
    recording: 'in memory',
    target: 'http://stub',
    adapter,
    pace: 'max',
    heartbeatMs,
    onProgress: (p) => events.push(p),
  });
  return events;
}

describe('the engine heartbeat', () => {
  it('calls onProgress during a long wait with nothing completing', async () => {
    const events = await replayWith(slowAdapter(400), 50);
    const beats = events.filter((e) => e.heartbeat);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (const beat of beats) {
      expect(beat.last).toBeNull();
      expect(beat.completed).toBe(0);
      expect(beat.total).toBe(1);
      expect(beat.inflight).toBe(1);
    }
    // The completion is the one event that is not a heartbeat, and it comes after the beats.
    const done = events.filter((e) => !e.heartbeat);
    expect(done).toHaveLength(1);
    expect(done[0]?.completed).toBe(1);
    expect(events.indexOf(done[0] as ReplayProgress)).toBeGreaterThan(
      events.indexOf(beats[0] as ReplayProgress),
    );
  });

  it('does not beat when heartbeatMs is 0', async () => {
    const events = await replayWith(slowAdapter(120), 0);
    expect(events.some((e) => e.heartbeat)).toBe(false);
  });
});
