/**
 * Measures replay throughput against a running candidate. Replays the
 * committed recording under max pacing, resetting the candidate between
 * repeats, and prints the achieved rate and the candidate's latency. Usage:
 *
 *   pnpm --filter @replay-parity/scripts exec tsx bench-replay.ts \
 *     --candidate http://127.0.0.1:3002 [--recording demo/recording.jsonl] [--concurrency 8] [--repeats 3]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDiffRules, readRecording } from '@replay-parity/core';
import { replayExchanges } from '@replay-parity/replay';

const { values } = parseArgs({
  options: {
    candidate: { type: 'string', default: 'http://127.0.0.1:3002' },
    recording: { type: 'string' },
    concurrency: { type: 'string', default: '8' },
    repeats: { type: 'string', default: '3' },
  },
});

const recordingPath =
  values.recording ?? resolve(dirname(fileURLToPath(import.meta.url)), '../demo/recording.jsonl');
const concurrency = Number(values.concurrency);
const repeats = Number(values.repeats);
const target = values.candidate;
const rules = parseDiffRules(`
ignore: ["$.created_at"]
substitutions:
  - name: order_id
    capture: { tag: create-order, path: "$.order_id" }
controls:
  tags: [admin-restart, admin-reset]
`);

const exchanges = await readRecording(recordingPath);
process.stdout.write(
  `replaying ${exchanges.length} exchanges from ${recordingPath} against ${target} at max pacing, concurrency ${concurrency}, ${repeats} repeats\n`,
);
for (let i = 1; i <= repeats; i += 1) {
  const reset = await fetch(`${target}/admin/reset`, { method: 'POST' });
  if (!reset.ok) throw new Error(`reset answered ${reset.status}`);
  const run = await replayExchanges(exchanges, {
    recording: recordingPath,
    target,
    pace: 'max',
    concurrency,
    rules,
    barrierTags: ['list-ledger'],
  });
  const c = run.stats.overall.candidate;
  process.stdout.write(
    `repeat ${i}: ${run.pacing.achieved_rps.toFixed(1)} rps over ${(run.duration_ms / 1000).toFixed(2)} s, candidate p50 ${c.p50_ms.toFixed(2)} ms, p99 ${c.p99_ms.toFixed(2)} ms, max ${c.max_ms.toFixed(2)} ms, errors ${run.stats.overall.errors}, mismatches ${run.stats.overall.mismatches}, barrier waits ${run.pacing.barrier_waits}\n`,
  );
}
