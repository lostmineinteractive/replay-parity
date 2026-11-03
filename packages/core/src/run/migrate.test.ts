import { describe, expect, it } from 'vitest';
import { ConfigError } from '../yaml.js';
import { RUN_MIGRATIONS, migrateRun, type RunMigration } from './migrate.js';
import { RUN_SCHEMA_VERSION } from './schema.js';

// A test table: version 0 named the candidate `target_url` and version 1 had no `notes`.
const migrations: Readonly<Record<number, RunMigration>> = {
  0: ({ target_url, ...rest }) => ({ ...rest, target: target_url }),
  1: (raw) => ({ ...raw, notes: [] }),
};

describe('migrateRun', () => {
  it('ships one migration per earlier version', () => {
    expect(RUN_SCHEMA_VERSION).toBe(2);
    expect(Object.keys(RUN_MIGRATIONS)).toEqual(['1']);
  });

  it('brings a version 1 run to version 2 with no sidecar and the new fields absent', () => {
    const v1 = { schema_version: 1, run_id: 'r', exchanges: [], pacing: { mode: 'max' } };
    expect(migrateRun(v1)).toEqual({
      schema_version: 2,
      run_id: 'r',
      exchanges: [],
      pacing: { mode: 'max' },
      exchanges_path: null,
    });
  });

  it('returns a file at the target version unchanged', () => {
    const run = { schema_version: RUN_SCHEMA_VERSION, run_id: 'r' };
    expect(migrateRun(run)).toBe(run);
    const later = { schema_version: 2, run_id: 'r' };
    expect(migrateRun(later, { migrations, target: 2 })).toBe(later);
  });

  it('applies a chain of migrations one version at a time', () => {
    const old = { schema_version: 0, run_id: 'r', target_url: 'http://c' };
    const migrated = migrateRun(old, { migrations, target: 2 });
    expect(migrated).toEqual({ schema_version: 2, run_id: 'r', target: 'http://c', notes: [] });
    expect(old).toEqual({ schema_version: 0, run_id: 'r', target_url: 'http://c' });
  });

  it('sets the version on every step even when a migration does not', () => {
    const forgetful: Record<number, RunMigration> = {
      0: ({ schema_version: _v, ...rest }) => rest,
      1: (raw) => ({ ...raw, schema_version: 99 }),
    };
    expect(migrateRun({ schema_version: 0 }, { migrations: forgetful, target: 1 })).toEqual({
      schema_version: 1,
    });
    expect(migrateRun({ schema_version: 0 }, { migrations: forgetful, target: 2 })).toEqual({
      schema_version: 2,
    });
  });

  it('refuses a file written by a newer rp', () => {
    expect(() => migrateRun({ schema_version: 3 }, { migrations, target: 2 })).toThrow(ConfigError);
    expect(() => migrateRun({ schema_version: 3 }, { migrations, target: 2 })).toThrow(
      /schema_version 3 is newer than 2; the file was written by a newer version of rp/,
    );
    expect(() => migrateRun({ schema_version: RUN_SCHEMA_VERSION + 1 })).toThrow(
      /written by a newer version of rp/,
    );
  });

  it('names the step that has no migration', () => {
    expect(() => migrateRun({ schema_version: 0 })).toThrow(ConfigError);
    expect(() => migrateRun({ schema_version: 0 })).toThrow(/no migration from version 0 to 1/);
    const partial: Record<number, RunMigration> = { 0: migrations[0] as RunMigration };
    expect(() => migrateRun({ schema_version: 0 }, { migrations: partial, target: 2 })).toThrow(
      /no migration from version 1 to 2/,
    );
  });

  it('names a missing or non integer version', () => {
    expect(() => migrateRun({ run_id: 'r' })).toThrow(ConfigError);
    expect(() => migrateRun({ run_id: 'r' })).toThrow(/schema_version is missing/);
    expect(() => migrateRun({ schema_version: '1' })).toThrow(
      /schema_version must be an integer, got "1"/,
    );
    expect(() => migrateRun({ schema_version: 1.5 })).toThrow(/must be an integer, got 1.5/);
    expect(() => migrateRun({ schema_version: null })).toThrow(/must be an integer, got null/);
  });

  it('leaves a value that is not an object for the schema to name', () => {
    expect(migrateRun(null)).toBeNull();
    expect(migrateRun([])).toEqual([]);
    expect(migrateRun('run')).toBe('run');
  });
});
