import { parseArgs } from 'node:util';
import { runLoad } from './run.js';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    seed: { type: 'string', default: '42' },
    background: { type: 'string', default: '14' },
    'min-gap-ms': { type: 'string', default: '20' },
    'max-gap-ms': { type: 'string', default: '60' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.target) {
  process.stdout.write(
    [
      'Usage: demo-load --target <url> [--seed 42] [--background 14] [--min-gap-ms 20] [--max-gap-ms 60] [--verbose]',
      '',
      'Sends the demo traffic plan to the target: twelve order lifecycle scenarios with background',
      'traffic between them, a ledger read after each, and a final read of every order and the ledger.',
      '',
    ].join('\n'),
  );
  process.exit(values.help ? 0 : 1);
}

const summary = await runLoad({
  target: values.target,
  seed: Number(values.seed),
  backgroundPerBlock: Number(values.background),
  minGapMs: Number(values['min-gap-ms']),
  maxGapMs: Number(values['max-gap-ms']),
  log: values.verbose
    ? (line) => {
        process.stderr.write(`${line}\n`);
      }
    : undefined,
});

const lines = [
  `sent ${summary.sent} requests in ${(summary.durationMs / 1000).toFixed(1)} s`,
  `by kind: ${Object.entries(summary.byKind)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
  `by status: ${Object.entries(summary.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
  `orders created: ${summary.orderIds.length}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
