#!/usr/bin/env node
import { runCli } from './cli.js';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const code = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exitCode = code;
