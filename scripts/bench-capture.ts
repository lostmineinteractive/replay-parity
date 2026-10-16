/**
 * Measures the capture proxy's overhead. Starts a capture proxy in this
 * process in front of a running reference service, then sends the same load
 * directly and through the proxy and compares the latency distributions.
 * Usage:
 *
 *   pnpm --filter @replay-parity/scripts exec tsx bench-capture.ts \
 *     --reference http://127.0.0.1:3001 [--requests 5000] [--warmup 500] [--concurrency 8] [--path /v1/inventory]
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { CaptureServer } from '@replay-parity/capture';
import { LatencyAccumulator, type LatencySummary } from '@replay-parity/core';
import { Pool } from 'undici';

const { values } = parseArgs({
  options: {
    reference: { type: 'string', default: 'http://127.0.0.1:3001' },
    requests: { type: 'string', default: '5000' },
    warmup: { type: 'string', default: '500' },
    concurrency: { type: 'string', default: '8' },
    path: { type: 'string', default: '/v1/inventory' },
  },
});

const requests = Number(values.requests);
const warmup = Number(values.warmup);
const concurrency = Number(values.concurrency);
const path = values.path;

async function measure(baseUrl: string): Promise<LatencySummary> {
  const pool = new Pool(baseUrl, { connections: concurrency });
  const acc = new LatencyAccumulator();
  let issued = 0;
  const total = requests + warmup;
  const worker = async (): Promise<void> => {
    while (issued < total) {
      const n = issued;
      issued += 1;
      const t0 = performance.now();
      const res = await pool.request({ method: 'GET', path });
      await res.body.arrayBuffer();
      const elapsed = performance.now() - t0;
      if (n >= warmup) acc.record(elapsed);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await pool.close();
  return acc.summary();
}

const dir = await mkdtemp(join(tmpdir(), 'rp-bench-'));
const capture = await CaptureServer.create({
  target: values.reference,
  out: join(dir, 'bench.jsonl'),
});
const addr = await capture.listen({ port: 0, host: '127.0.0.1' });
const proxyUrl = `http://127.0.0.1:${addr.port}`;

const direct1 = await measure(values.reference);
const proxied1 = await measure(proxyUrl);
const direct2 = await measure(values.reference);
const proxied2 = await measure(proxyUrl);
await capture.close();

const fmt = (n: number): string => n.toFixed(3).padStart(9);
const row = (label: string, s: LatencySummary): string =>
  `${label.padEnd(16)}${fmt(s.p50_ms)}${fmt(s.p90_ms)}${fmt(s.p99_ms)}${fmt(s.max_ms)}${String(s.count).padStart(8)}`;
const overheadP50 = (proxied1.p50_ms + proxied2.p50_ms) / 2 - (direct1.p50_ms + direct2.p50_ms) / 2;
const overheadP99 = (proxied1.p99_ms + proxied2.p99_ms) / 2 - (direct1.p99_ms + direct2.p99_ms) / 2;

process.stdout.write(
  [
    `reference ${values.reference}  path ${path}  concurrency ${concurrency}  requests ${requests} after ${warmup} warmup, two passes each`,
    `${'series'.padEnd(16)}${'p50 ms'.padStart(9)}${'p90 ms'.padStart(9)}${'p99 ms'.padStart(9)}${'max ms'.padStart(9)}${'count'.padStart(8)}`,
    row('direct pass 1', direct1),
    row('proxied pass 1', proxied1),
    row('direct pass 2', direct2),
    row('proxied pass 2', proxied2),
    `capture overhead: p50 ${overheadP50.toFixed(3)} ms, p99 ${overheadP99.toFixed(3)} ms (recorded ${capture.stats.recorded} exchanges)`,
    '',
  ].join('\n'),
);
