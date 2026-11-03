import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '@replay-parity/core';
import { hasUpstreamOptions, upstreamFetch, type UpstreamTls } from '@replay-parity/replay';

/**
 * Reset strategies. A reset returns the candidate to its initial state before
 * an attempt. Exactly one strategy is chosen: a URL that receives a POST, a
 * shell command, or an ES module that exports `reset()`. After any of them an
 * optional health URL is polled with GET until it answers 2xx.
 */
export const DEFAULT_RESET_TIMEOUT_MS = 30_000;

/** How long the health poll waits between requests. */
const HEALTH_POLL_MS = 100;
/** How much of the command's stderr an error message carries. */
const STDERR_TAIL_CHARS = 2000;

export interface ResetUpstream {
  tls?: UpstreamTls | undefined;
  proxy?: string | undefined;
}

export interface ResetStrategyOptions {
  /** A URL that receives a POST, answering 2xx. */
  url?: string | undefined;
  /** A shell command. A nonzero exit or a timeout fails the reset. */
  command?: string | undefined;
  /** An ES module that exports `reset(): Promise<void>`, as a named export or on the default export. */
  module?: string | undefined;
  /** Polled with GET after the reset until it answers 2xx. */
  health?: string | undefined;
  /** Bounds the command and the health poll. Default 30000. */
  timeoutMs?: number | undefined;
  /** TLS and proxy settings for the URL reset and the health poll. */
  upstream?: ResetUpstream | undefined;
  /** What to print in place of the URL, for a URL that held a secret. */
  urlLabel?: string | undefined;
  /**
   * The candidate this reset serves. It replaces `{target}` in the command and
   * the health URL and is passed to a module's `reset` as `{ target }`.
   */
  target?: string | undefined;
}

/** The flags that name a strategy, for the ones that were given. */
export function chosenStrategies(options: ResetStrategyOptions): string[] {
  const names: string[] = [];
  if (options.url !== undefined) names.push('--reset-url');
  if (options.command !== undefined) names.push('--reset-command');
  if (options.module !== undefined) names.push('--reset-module');
  return names;
}

/** Keeps the end of `text`, which is where a failing command says why. */
function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `...${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

/** Runs `command` through the shell. Rejects with a `ConfigError` on a nonzero exit or a timeout. */
export function runResetCommand(command: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveRun, reject) => {
    // A process group of its own, so the timeout can end the shell and whatever it started.
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS * 2);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const name = JSON.stringify(command);
    const detail = (): string => (stderr.trim() === '' ? '' : `, stderr: ${tail(stderr)}`);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ConfigError(`reset command ${name} failed to start: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ConfigError(`reset command ${name} timed out after ${timeoutMs} ms${detail()}`));
      } else if (code !== 0) {
        const how = code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with ${code}`;
        reject(new ConfigError(`reset command ${name} ${how}${detail()}`));
      } else {
        resolveRun();
      }
    });
  });
}

/** Polls `url` with GET until it answers 2xx or `timeoutMs` passes. */
export async function waitForHealth(
  url: string,
  timeoutMs: number,
  upstream?: ResetUpstream,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const signal = AbortSignal.timeout(Math.min(left, 5000));
      const res =
        upstream !== undefined && hasUpstreamOptions(upstream)
          ? await upstreamFetch(url, { method: 'GET', signal }, upstream)
          : await fetch(url, { method: 'GET', signal });
      if (res.ok) return;
      last = `answered ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    const pause = Math.min(HEALTH_POLL_MS, Math.max(0, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, pause));
  }
  throw new ConfigError(
    `reset health check ${url} did not answer 2xx within ${timeoutMs} ms (last: ${last})`,
  );
}

/** What a reset module's `reset` receives. */
export interface ResetContext {
  target: string | undefined;
}

async function loadResetModule(path: string): Promise<(context: ResetContext) => Promise<void>> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`reset module ${path} failed to load: ${(e as Error).message}`);
  }
  const holder =
    typeof mod.reset === 'function'
      ? mod
      : typeof mod.default === 'object' && mod.default !== null
        ? (mod.default as Record<string, unknown>)
        : mod;
  const fn = holder.reset;
  if (typeof fn !== 'function') {
    throw new ConfigError(`reset module ${path} does not export a reset function`);
  }
  return async (context) => {
    await (fn as (context: ResetContext) => Promise<void> | void).call(holder, context);
  };
}

/**
 * Builds the reset for the strategy chosen. Exactly one of `url`, `command`,
 * and `module` is required. The returned function resets, then waits for the
 * health URL when one is given.
 */
export async function buildReset(options: ResetStrategyOptions): Promise<() => Promise<void>> {
  const chosen = chosenStrategies(options);
  if (chosen.length !== 1) {
    throw new ConfigError(
      chosen.length === 0
        ? 'a reset strategy is required: one of --reset-url, --reset-command, --reset-module'
        : `reset strategies are exclusive, got ${chosen.join(' and ')}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
  const upstream = options.upstream;
  let strategy: () => Promise<void>;
  if (options.url !== undefined) {
    const url = options.url;
    const label = options.urlLabel ?? url;
    strategy = async () => {
      const res =
        upstream !== undefined && hasUpstreamOptions(upstream)
          ? await upstreamFetch(url, { method: 'POST' }, upstream)
          : await fetch(url, { method: 'POST' });
      if (!res.ok) throw new ConfigError(`reset ${label} answered ${res.status}`);
    };
  } else if (options.command !== undefined) {
    const command =
      options.target === undefined
        ? options.command
        : options.command.split('{target}').join(options.target);
    strategy = () => runResetCommand(command, timeoutMs);
  } else {
    const call = await loadResetModule(options.module as string);
    const context: ResetContext = { target: options.target };
    strategy = () => call(context);
  }
  const health =
    options.health === undefined || options.target === undefined
      ? options.health
      : options.health.split('{target}').join(options.target);
  if (health === undefined) return strategy;
  return async () => {
    await strategy();
    await waitForHealth(health, timeoutMs, upstream);
  };
}
