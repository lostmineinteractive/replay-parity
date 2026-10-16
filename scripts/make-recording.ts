/**
 * Produces demo/recording.jsonl without Docker: starts the reference service
 * and the capture proxy in this process, runs the demo load through the proxy,
 * and writes the recording. Usage:
 *
 *   pnpm --filter @replay-parity/scripts exec tsx make-recording.ts [--count 300] [--seed 42]
 */
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CaptureServer, parseTagRule } from '@replay-parity/capture';
import { readRecording } from '@replay-parity/core';
import { DEMO_TAG_RULES, runLoad } from '@replay-parity/demo-load';
import { buildApp } from '@replay-parity/demo-reference';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '300' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string' },
  },
});

const out =
  values.out ?? resolve(dirname(fileURLToPath(import.meta.url)), '../demo/recording.jsonl');

const reference = buildApp();
await reference.listen({ port: 0, host: '127.0.0.1' });
const referenceUrl = `http://127.0.0.1:${(reference.server.address() as AddressInfo).port}`;

const capture = await CaptureServer.create({
  target: referenceUrl,
  out,
  append: false,
  tagRules: DEMO_TAG_RULES.map(parseTagRule),
  onError: (err, context) => process.stderr.write(`capture error (${context}): ${String(err)}\n`),
});
const addr = await capture.listen({ port: 0, host: '127.0.0.1' });

const summary = await runLoad({
  target: `http://127.0.0.1:${addr.port}`,
  count: Number(values.count),
  seed: Number(values.seed),
});

await capture.close();
await reference.close();

const exchanges = await readRecording(out);
const byTag: Record<string, number> = {};
for (const e of exchanges) for (const t of e.tags) byTag[t] = (byTag[t] ?? 0) + 1;
process.stdout.write(
  [
    `wrote ${out}`,
    `exchanges: ${exchanges.length} (sent ${summary.sent}, recorded ${capture.stats.recorded})`,
    `by tag: ${Object.entries(byTag)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    `by status: ${Object.entries(summary.byStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    `span: ${exchanges.at(-1)?.offset_ms ?? 0} ms`,
    '',
  ].join('\n'),
);
