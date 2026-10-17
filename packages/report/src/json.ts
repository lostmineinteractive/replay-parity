import { serializeRun, type Run } from '@replay-parity/core';

/** The JSON report is the run itself, validated and pretty printed. */
export function renderJson(run: Run): string {
  return serializeRun(run);
}
