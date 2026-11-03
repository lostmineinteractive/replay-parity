import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  jsonResponse,
  makeExchange,
  makeRequest,
  type Exchange,
  type JsonValue,
} from '@replay-parity/core';

/**
 * A small HTTP stand-in for a candidate system, for tests that need a defect
 * the demo does not have. The handler gets the parsed JSON body.
 */
export interface StandIn {
  url: string;
  requests: { method: string; path: string; body: JsonValue | undefined }[];
  close: () => Promise<void>;
}

export type StandInHandler = (
  req: { method: string; path: string; body: JsonValue | undefined },
  res: ServerResponse,
) => void | Promise<void>;

async function readBody(req: IncomingMessage): Promise<JsonValue | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as JsonValue);
}

export async function startStandIn(handler: StandInHandler): Promise<StandIn> {
  const requests: StandIn['requests'] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const seen = { method: req.method ?? 'GET', path: req.url ?? '/', body };
      requests.push(seen);
      await handler(seen, res);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: ServerResponse, body: JsonValue, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A recorded POST /orders whose recorded answer is `{ ok: true }`. */
export function orderExchange(
  index: number,
  body: JsonValue,
  tags: string[] = ['order'],
): Exchange {
  return makeExchange({
    index,
    request: makeRequest({ method: 'POST', path: '/orders', body }),
    response: jsonResponse({ ok: true }),
    tags,
  });
}
