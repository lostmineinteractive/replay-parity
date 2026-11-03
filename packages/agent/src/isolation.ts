import { hasUpstreamOptions, upstreamFetch, type UpstreamTls } from '@replay-parity/replay';

/**
 * Isolation between cases. A reset hook runs before each case and returns a
 * system to a known state; `resetByPost` builds one from a URL the way
 * `rp shrink` does. Cases run in parallel only when neither system is reset,
 * because a reset in the middle of another case's steps would corrupt it.
 */
export type ResetHook = () => Promise<void>;

export interface ResetHooks {
  reference?: ResetHook | undefined;
  candidate?: ResetHook | undefined;
}

/** The mode a run executed its cases in. Recorded in the transcript. */
export interface Isolation {
  reset_between_cases: boolean;
  case_concurrency: number;
}

/** The effective mode: a requested concurrency above one applies only without resets. */
export function resolveIsolation(
  resets: ResetHooks | undefined,
  requestedConcurrency: number | undefined,
): Isolation {
  const reset = resets?.reference !== undefined || resets?.candidate !== undefined;
  const requested = Math.max(1, Math.floor(requestedConcurrency ?? 1));
  return { reset_between_cases: reset, case_concurrency: reset ? 1 : requested };
}

/** The TLS and proxy settings a reset POST connects with. */
export interface ResetUpstream {
  tls?: UpstreamTls | undefined;
  proxy?: string | undefined;
}

/**
 * A hook that sends a POST to `url` and fails on any status outside 2xx. With
 * `upstream` settings that change the connection, the POST goes through them.
 */
export function resetByPost(
  url: string,
  fetchImpl: typeof fetch = fetch,
  upstream?: ResetUpstream,
): ResetHook {
  return async () => {
    if (upstream !== undefined && hasUpstreamOptions(upstream)) {
      const res = await upstreamFetch(url, { method: 'POST' }, upstream);
      if (!res.ok) throw new Error(`reset ${url} answered ${res.status}`);
      return;
    }
    const res = await fetchImpl(url, { method: 'POST' });
    // Read the body so the connection is released whatever the status.
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`reset ${url} answered ${res.status}`);
  };
}

/** Runs every hook that is set. The first failure rejects. */
export async function runResets(resets: ResetHooks | undefined): Promise<void> {
  if (resets === undefined) return;
  await Promise.all([resets.reference?.(), resets.candidate?.()]);
}
