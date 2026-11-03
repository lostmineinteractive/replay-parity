// An adapter plugin that answers from a JSON file instead of calling a service.
//
// The file named in `settings.map` maps "<METHOD> <path>" to a response or to a
// list of responses. A list is served in order and its last entry repeats. A
// response is { status, headers?, body? }.
//
//   rp replay --recording recording.jsonl --target echo://map \
//     --adapter-module examples/adapters/echo-adapter.mjs \
//     --adapter-setting map=responses.json
//
// docs/writing-adapters.md describes the contract.

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/**
 * @param {{ target: string, timeoutMs: number, connections: number, settings: Record<string, string> }} options
 */
export async function createAdapter({ settings }) {
  const mapPath = settings.map;
  if (mapPath === undefined) throw new Error('the echo adapter needs --adapter-setting map=<file>');
  const responses = JSON.parse(await readFile(mapPath, 'utf8'));
  const served = new Map();

  return {
    name: 'echo',

    async send(req) {
      const started = performance.now();
      const key = `${req.method} ${req.path}`;
      const entry = responses[key];
      const position = served.get(key) ?? 0;
      served.set(key, position + 1);
      const response = Array.isArray(entry) ? entry[Math.min(position, entry.length - 1)] : entry;
      if (response === undefined) {
        return {
          status: 404,
          headers: { 'content-type': 'application/json' },
          latency_ms: performance.now() - started,
          body: { error: 'not_in_map', key },
        };
      }
      return {
        status: response.status,
        headers: response.headers ?? {},
        latency_ms: performance.now() - started,
        ...(response.body === undefined ? {} : { body: response.body }),
        ...(response.encoding === undefined ? {} : { encoding: response.encoding }),
      };
    },

    async close() {
      served.clear();
    },
  };
}
