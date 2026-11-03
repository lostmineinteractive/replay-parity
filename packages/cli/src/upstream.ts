import { readFile } from 'node:fs/promises';
import { ConfigError } from '@replay-parity/core';
import { hasUpstreamOptions, type UpstreamTls } from '@replay-parity/replay';
import type { Command } from 'commander';

/**
 * The flags that decide how a command connects to its target: the TLS
 * settings, the proxy, and where the key material comes from. Shared by
 * `rp replay`, `rp shrink`, and the preflight probe so one set of flags means
 * the same thing everywhere.
 */

export interface UpstreamFlags {
  upstreamCa?: string;
  upstreamCert?: string;
  upstreamKey?: string;
  upstreamInsecure?: boolean;
  upstreamServername?: string;
  httpProxy?: string;
}

export interface Upstream {
  tls: UpstreamTls | undefined;
  proxy: string | undefined;
}

/** Registers the upstream flags on a command. */
export function addUpstreamOptions(command: Command): Command {
  return command
    .option('--upstream-ca <path>', 'PEM file of the authorities that sign the target certificate')
    .option('--upstream-cert <path>', 'PEM client certificate to present to the target')
    .option('--upstream-key <path>', 'PEM private key for --upstream-cert')
    .option('--upstream-insecure', 'accept any certificate the target presents', false)
    .option(
      '--upstream-servername <name>',
      'server name sent in SNI and checked against the certificate',
    )
    .option('--http-proxy <url>', 'HTTP proxy to reach the target through');
}

async function readPem(flag: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const reason = (e as NodeJS.ErrnoException).code ?? String(e);
    throw new ConfigError(`${flag} ${path} cannot be read: ${reason}`);
  }
}

/** Reads the key material the flags name. Throws a `ConfigError` for an unreadable file or a certificate without a key. */
export async function resolveUpstream(flags: UpstreamFlags): Promise<Upstream> {
  if ((flags.upstreamCert === undefined) !== (flags.upstreamKey === undefined)) {
    throw new ConfigError('--upstream-cert and --upstream-key are used together');
  }
  const tls: UpstreamTls = {};
  if (flags.upstreamCa !== undefined) tls.ca = await readPem('--upstream-ca', flags.upstreamCa);
  if (flags.upstreamCert !== undefined && flags.upstreamKey !== undefined) {
    tls.cert = await readPem('--upstream-cert', flags.upstreamCert);
    tls.key = await readPem('--upstream-key', flags.upstreamKey);
  }
  if (flags.upstreamInsecure === true) tls.rejectUnauthorized = false;
  if (flags.upstreamServername !== undefined) tls.servername = flags.upstreamServername;
  const settings = Object.keys(tls).length === 0 ? undefined : tls;
  return { tls: settings, proxy: flags.httpProxy };
}

/** True when the flags change how the connection is made, so the default transport no longer fits. */
export function customUpstream(upstream: Upstream): boolean {
  return hasUpstreamOptions(upstream);
}
