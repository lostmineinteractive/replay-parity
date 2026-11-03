import { ConfigError } from '../yaml.js';
import { RUN_SCHEMA_VERSION } from './schema.js';

/**
 * Run file migrations. `RunSchema` accepts only the current `schema_version`,
 * so a file written by an earlier rp is brought up to date here before it is
 * validated. A migration takes the raw file at version k and returns it at
 * version k + 1. The table has one entry per source version.
 */
export type RunMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

export const RUN_MIGRATIONS: Readonly<Record<number, RunMigration>> = {
  // Version 2 added the exchanges sidecar. A version 1 run holds every exchange in the file.
  // Its other additions, the session, speed, loop, retry, and re-replay fields, are optional
  // and stay absent.
  1: (raw) => ({ ...raw, exchanges_path: null }),
  // Version 3 added the baseline an earlier run was compared against. A version 2 run had none.
  // Its other additions, the candidate statuses and the throughput, status, and baseline
  // threshold sections, are optional and stay absent.
  2: (raw) => ({ ...raw, baseline: null }),
};

export interface MigrateRunOptions {
  /** The table to apply. Defaults to `RUN_MIGRATIONS`. */
  migrations?: Readonly<Record<number, RunMigration>> | undefined;
  /** The version to reach. Defaults to `RUN_SCHEMA_VERSION`. */
  target?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies migrations step by step from the file's `schema_version` up to the
 * target. A file already at the target is returned as is. A value that is not
 * an object is also returned as is, so the schema names that problem. A file
 * newer than the target, a missing or non integer version, and a step with no
 * migration are each a `ConfigError`.
 */
export function migrateRun(raw: unknown, options: MigrateRunOptions = {}): unknown {
  if (!isRecord(raw)) return raw;
  const migrations = options.migrations ?? RUN_MIGRATIONS;
  const target = options.target ?? RUN_SCHEMA_VERSION;
  const version = raw.schema_version;
  if (version === undefined) {
    throw new ConfigError('schema_version is missing');
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ConfigError(`schema_version must be an integer, got ${JSON.stringify(version)}`);
  }
  if (version === target) return raw;
  if (version > target) {
    throw new ConfigError(
      `schema_version ${version} is newer than ${target}; the file was written by a newer version of rp`,
    );
  }
  let current = raw;
  for (let k = version; k < target; k += 1) {
    const migration = migrations[k];
    if (migration === undefined) {
      throw new ConfigError(`no migration from version ${k} to ${k + 1}`);
    }
    current = { ...migration(current), schema_version: k + 1 };
  }
  return current;
}
