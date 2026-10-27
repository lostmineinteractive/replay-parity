#!/usr/bin/env node
import { runCli } from './cli.js';

// The first SIGINT or SIGTERM asks the running command to stop and write what it has.
// A second one ends the process at once with the conventional code for an interrupt.
const controller = new AbortController();
let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    process.stderr.write(
      `rp: ${signal} received, stopping and writing what was done so far. Send it again to exit at once.\n`,
    );
    controller.abort();
  });
}

const code = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exitCode = code;
