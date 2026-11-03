import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ConfigError,
  ExchangeResultSchema,
  formatZodError,
  type ExchangeResult,
  type Run,
} from '@replay-parity/core';

/**
 * Reads the exchanges sidecar a large run streams its results to. Every line
 * is one exchange result in recording order. A line that is not a valid
 * result is a `ConfigError` naming the file and the line.
 */
export async function readExchangesSidecar(path: string): Promise<ExchangeResult[]> {
  const out: ExchangeResult[] = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of rl) {
      line += 1;
      if (text.trim().length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        throw new ConfigError(`${path} line ${line}: invalid JSON (${(err as Error).message})`);
      }
      const result = ExchangeResultSchema.safeParse(raw);
      if (!result.success) {
        throw new ConfigError(`${path} line ${line}: ${formatZodError(result.error)}`);
      }
      out.push(result.data);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  } finally {
    rl.close();
    input.destroy();
  }
  return out;
}

/** Where a run's sidecar is: a relative `exchanges_path` is relative to the run file. */
export function sidecarLocation(run: Run, runPath: string): string | null {
  if (run.exchanges_path === null) return null;
  return isAbsolute(run.exchanges_path)
    ? run.exchanges_path
    : resolve(dirname(runPath), run.exchanges_path);
}

export interface LoadedExchanges {
  /** The run with every exchange from the sidecar, or the run as read. */
  run: Run;
  /** `none` without a sidecar, `read` when it was read, `missing` when the file is not there. */
  sidecar: 'none' | 'read' | 'missing';
  /** The sidecar's resolved path, or null. */
  path: string | null;
}

/**
 * Puts every exchange of the sidecar into the run, so the renderers see the
 * whole run. A missing sidecar leaves the run with the mismatches it kept.
 */
export async function withSidecarExchanges(run: Run, runPath: string): Promise<LoadedExchanges> {
  const path = sidecarLocation(run, runPath);
  if (path === null) return { run, sidecar: 'none', path };
  try {
    await access(path);
  } catch {
    return { run, sidecar: 'missing', path };
  }
  return { run: { ...run, exchanges: await readExchangesSidecar(path) }, sidecar: 'read', path };
}
