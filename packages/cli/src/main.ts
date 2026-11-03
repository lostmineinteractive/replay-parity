#!/usr/bin/env node
import { runCli } from './cli.js';
import { cliLogger, scanLogFlags, type CliStreams } from './io.js';

const argv = process.argv.slice(2);
const streams: CliStreams = { stdout: process.stdout, stderr: process.stderr };
let log;
try {
  log = cliLogger(streams, scanLogFlags(argv, process.env));
} catch {
  // runCli reports the bad value and exits 1. The signal line keeps the defaults.
  log = cliLogger(streams, { level: 'info', format: 'text' });
}

// The first SIGINT or SIGTERM asks the running command to stop and write what it has.
// A second one ends the process at once with the conventional code for an interrupt.
const controller = new AbortController();
let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    log.warn(
      `rp: ${signal} received, stopping and writing what was done so far. Send it again to exit at once.`,
      { signal },
    );
    controller.abort();
  });
}

const code = await runCli(argv, { signal: controller.signal });
process.exitCode = code;
