import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  InvariantRulesFileSchema,
  parseYaml,
  type InvariantRulesFile,
} from '@replay-parity/core';
import type { InvariantModule, InvariantRule, LoadedInvariantModule } from '../module.js';
import {
  conservationCheck,
  idempotencyCheck,
  monotonicCheck,
  readYourWritesCheck,
  transitionsCheck,
  type Check,
  type DeclarativeEpoch,
} from './rules.js';
import { parseExchangeCommand, type ExchangeCommand } from './source.js';

/**
 * The built in module behind `invariants.yaml`. Rules are numbered in file
 * order: idempotency, monotonic, read_your_writes, transitions, then
 * conservation. A rule without a `name` is named after its kind and its
 * position within the kind, as `monotonic-2`.
 */

export const DECLARATIVE_NAME = 'declarative';
export const DECLARATIVE_VERSION = '1.0.0';

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Builds the module for a validated rules file. `sha256` is the hash of the file, when there is one. */
export function declarativeModule(
  file: InvariantRulesFile,
  sha256: string | null = null,
): InvariantModule<ExchangeCommand, DeclarativeEpoch> & { sha256: string | null } {
  const rules: InvariantRule<DeclarativeEpoch>[] = [];
  const add = (
    kind: string,
    n: number,
    name: string | undefined,
    statement: string,
    check: Check,
  ): void => {
    rules.push({ id: rules.length + 1, name: name ?? `${kind}-${n}`, statement, check });
  };
  list(file.idempotency).forEach((e, i) => {
    add(
      'idempotency',
      i + 1,
      e.name,
      e.by_payload
        ? `Requests with the same ${e.header} and payload have one effect, and a different payload under the same ${e.header} is not accepted.`
        : `Requests with the same ${e.header} have one effect.`,
      idempotencyCheck(e),
    );
  });
  file.monotonic.forEach((e, i) => {
    add(
      'monotonic',
      i + 1,
      e.name,
      `${e.path} never decreases across responses${e.tag === undefined ? '' : ` tagged ${e.tag}`} that share ${e.key}.`,
      monotonicCheck(e),
    );
  });
  file.read_your_writes.forEach((e, i) => {
    add(
      'read-your-writes',
      i + 1,
      e.name,
      `A ${e.read_tag} read after an acknowledged ${e.write_tag} with the same ${e.substitution} shows the written values.`,
      readYourWritesCheck(e),
    );
  });
  list(file.transitions).forEach((e, i) => {
    add(
      'transitions',
      i + 1,
      e.name,
      `${e.path} for one ${e.key} moves only along the allowed transitions.`,
      transitionsCheck(e),
    );
  });
  file.conservation.forEach((e, i) => {
    add(
      'conservation',
      i + 1,
      e.name,
      `Between two ${e.equals_change_in.tag} reads, ${e.equals_change_in.path} changes by the sum of ${e.delta_of.path} over the accepted ${e.delta_of.tag} commands between them.`,
      conservationCheck(e),
    );
  });
  const names = new Set<string>();
  for (const rule of rules) {
    if (names.has(rule.name))
      throw new ConfigError(`invariant rules: the name ${rule.name} is used twice`);
    names.add(rule.name);
  }
  const resetTag = file.reset_tag;
  return {
    name: DECLARATIVE_NAME,
    version: DECLARATIVE_VERSION,
    sha256,
    parse: (exchange, index) => parseExchangeCommand(exchange, index, resetTag),
    rules,
    stateChanging: ['write', 'reset'],
  };
}

/** Parses and validates the text of a rules file. `source` names the file in errors. */
export function parseDeclarativeRules(text: string, source: string): LoadedInvariantModule {
  const file = parseYaml(text, InvariantRulesFileSchema, source);
  const sha256 = createHash('sha256').update(text).digest('hex');
  try {
    return declarativeModule(file, sha256);
  } catch (e) {
    throw new ConfigError(`${source}: ${(e as Error).message}`);
  }
}

/** Loads `invariants.yaml` as a module. Throws a `ConfigError` naming the file and the problem. */
export async function loadDeclarativeRules(path: string): Promise<LoadedInvariantModule> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return parseDeclarativeRules(text, path);
}
