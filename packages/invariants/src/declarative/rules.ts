import {
  canonicalJson,
  type ConservationInvariant,
  type Exchange,
  type IdempotencyInvariant,
  type JsonValue,
  type MonotonicInvariant,
  type ReadYourWritesInvariant,
  type TransitionsInvariant,
} from '@replay-parity/core';
import type { CommandEpoch } from '../module.js';
import { Collector, type RuleOutcome } from '../outcome.js';
import {
  asNumber,
  before,
  compileSource,
  readKey,
  readSource,
  sameAmount,
  tagged,
  unreadable,
  type ExchangeCommand,
  type Source,
} from './source.js';

/**
 * The five declarative rule kinds. Each builder compiles its entry once and
 * returns a `check` over one epoch of exchange commands. A rule decides only
 * from exchanges whose order the timing proves: when two exchanges overlap
 * and the answer depends on which took effect first, the instance is
 * counted as undecided rather than as a violation.
 */

export type DeclarativeEpoch = CommandEpoch<ExchangeCommand>;
export type Check = (epoch: DeclarativeEpoch) => RuleOutcome;

function show(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

/** The request payload, by content or by the stored hash of a body too large to keep. */
function payloadOf(exchange: Exchange): string {
  const { request } = exchange;
  if (request.truncated) return `sha256:${request.body_sha256 ?? ''}`;
  return request.body === undefined ? '' : canonicalJson(request.body);
}

/** The response as compared across retries, or undefined when it was too large to keep. */
function responseOf(exchange: Exchange): string | undefined {
  const { response } = exchange;
  if (response.truncated) return undefined;
  return `${response.status} ${response.body === undefined ? '' : canonicalJson(response.body)}`;
}

export function idempotencyCheck(entry: IdempotencyInvariant): Check {
  const header = entry.header.toLowerCase();
  const identity = entry.identity === undefined ? undefined : compileSource(entry.identity);
  const fingerprint = (c: ExchangeCommand): string | undefined => {
    if (identity === undefined) return responseOf(c.exchange);
    const value = readSource(identity, c.exchange);
    return value === undefined ? undefined : canonicalJson(value);
  };
  return (epoch) => {
    const c = new Collector();
    const byKey = new Map<string, Map<string, ExchangeCommand[]>>();
    for (const command of epoch.commands) {
      if (!tagged(command, entry.tag)) continue;
      const key = command.exchange.request.headers[header];
      if (key === undefined || key.length === 0) continue;
      const payload = entry.by_payload ? payloadOf(command.exchange) : '';
      let groups = byKey.get(key);
      if (!groups) {
        groups = new Map();
        byKey.set(key, groups);
      }
      const group = groups.get(payload) ?? [];
      group.push(command);
      groups.set(payload, group);
    }
    for (const [key, groups] of byKey) {
      c.check();
      const subject = `${header} ${key}`;
      const acceptedGroups = [...groups.values()].filter((g) => g.some((x) => x.accepted));
      const second = acceptedGroups[1]?.find((x) => x.accepted);
      if (second !== undefined) {
        c.violation(
          subject,
          'one accepted payload',
          acceptedGroups.length,
          `a different payload was accepted under the same key in exchange ${second.id}`,
          second.id,
        );
      }
      for (const group of groups.values()) {
        const first = group.find((x) => x.accepted);
        if (first === undefined) continue;
        const expected = fingerprint(first);
        for (const retry of group) {
          if (retry === first || retry.index < first.index) continue;
          if (!retry.accepted) {
            if (before(first, retry)) {
              c.violation(
                subject,
                'the original response',
                `status ${retry.exchange.response.status}`,
                `a retry was rejected after exchange ${first.id} had been accepted`,
                retry.id,
              );
            } else {
              c.undecided(`retry ${retry.id} was rejected while ${first.id} was in flight`);
            }
            continue;
          }
          const observed = fingerprint(retry);
          if (expected === undefined || observed === undefined) {
            c.undecided(
              `${identity === undefined ? 'a response body was too large to keep' : `${identity.text} is absent`} for ${retry.id}`,
            );
          } else if (observed !== expected) {
            c.violation(
              subject,
              identity === undefined ? expected : (JSON.parse(expected) as JsonValue),
              identity === undefined ? observed : (JSON.parse(observed) as JsonValue),
              `a retry answered differently from exchange ${first.id}`,
              retry.id,
            );
          }
        }
      }
    }
    return c.outcome();
  };
}

export function monotonicCheck(entry: MonotonicInvariant): Check {
  const path = compileSource(entry.path);
  const key = compileSource(entry.key);
  return (epoch) => {
    const c = new Collector();
    const seen = new Map<string, { value: number; command: ExchangeCommand }[]>();
    for (const command of epoch.commands) {
      if (!command.accepted || !tagged(command, entry.tag)) continue;
      const k = readKey(key, command.exchange);
      if (k === undefined) continue;
      const raw = readSource(path, command.exchange);
      if (raw === undefined) {
        if (unreadable(path, command.exchange))
          c.undecided(`the body of ${command.id} was not kept`);
        continue;
      }
      const value = asNumber(raw);
      if (value === undefined) {
        c.undecided(`${path.text} in ${command.id} is not a number`);
        continue;
      }
      const earlier = seen.get(k) ?? [];
      if (earlier.length > 0) {
        c.check();
        let settled: { value: number; command: ExchangeCommand } | undefined;
        let overlapping: { value: number; command: ExchangeCommand } | undefined;
        for (const e of earlier) {
          if (before(e.command, command)) {
            if (settled === undefined || e.value > settled.value) settled = e;
          } else if (overlapping === undefined || e.value > overlapping.value) {
            overlapping = e;
          }
        }
        if (settled !== undefined && value < settled.value) {
          c.violation(
            `${key.text} ${k}`,
            `at least ${settled.value}`,
            value,
            `${path.text} went down after exchange ${settled.command.id}`,
            command.id,
          );
        } else if (overlapping !== undefined && value < overlapping.value) {
          c.undecided(`${command.id} overlapped ${overlapping.command.id}, which showed more`);
        }
      }
      earlier.push({ value, command });
      seen.set(k, earlier);
    }
    return c.outcome();
  };
}

interface FieldPair {
  label: string;
  write: Source;
  read: Source;
}

export function readYourWritesCheck(entry: ReadYourWritesInvariant): Check {
  const substitution = compileSource(entry.substitution);
  const fields: FieldPair[] = entry.fields.map((f) =>
    typeof f === 'string'
      ? { label: f, write: compileSource(`request:${f}`), read: compileSource(f) }
      : {
          label: `${f.write} -> ${f.read}`,
          write: compileSource(f.write),
          read: compileSource(f.read),
        },
  );
  return (epoch) => {
    const c = new Collector();
    const writes = new Map<string, ExchangeCommand[]>();
    const checkRead = (command: ExchangeCommand, k: string): void => {
      const candidates = writes.get(k) ?? [];
      const done = candidates.filter((w) => before(w, command));
      const last = done[done.length - 1];
      if (last === undefined) return;
      const inFlight = candidates.find((w) => !before(w, command));
      if (inFlight !== undefined) {
        c.undecided(`read ${command.id} overlapped write ${inFlight.id}`);
        return;
      }
      const rival = done.find((w) => w !== last && !before(w, last));
      if (rival !== undefined) {
        c.undecided(`writes ${rival.id} and ${last.id} overlapped, so the last one is unknown`);
        return;
      }
      c.check();
      for (const field of fields) {
        const written = readSource(field.write, last.exchange);
        if (written === undefined) {
          c.undecided(`write ${last.id} has no value at ${field.write.text}`);
          continue;
        }
        const shown = readSource(field.read, command.exchange);
        if (shown === undefined && unreadable(field.read, command.exchange)) {
          c.undecided(`the body of read ${command.id} was not kept`);
          continue;
        }
        if (shown === undefined || canonicalJson(shown) !== canonicalJson(written)) {
          c.violation(
            `${substitution.text} ${k} at ${field.label}`,
            written,
            show(shown),
            `the read did not show what exchange ${last.id} wrote`,
            command.id,
          );
        }
      }
    };
    for (const command of epoch.commands) {
      if (!command.accepted) continue;
      const tags = command.exchange.tags;
      const k = readKey(substitution, command.exchange);
      if (k === undefined) continue;
      if (tags.includes(entry.read_tag)) checkRead(command, k);
      if (tags.includes(entry.write_tag)) writes.set(k, [...(writes.get(k) ?? []), command]);
    }
    return c.outcome();
  };
}

/** Every state reachable from `from` along one or more allowed moves. */
function reachable(
  allowed: Readonly<Record<string, readonly string[]>>,
  from: string,
): Set<string> {
  const out = new Set<string>();
  const queue = [...(allowed[from] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (out.has(next)) continue;
    out.add(next);
    queue.push(...(allowed[next] ?? []));
  }
  return out;
}

export function transitionsCheck(entry: TransitionsInvariant): Check {
  const path = compileSource(entry.path);
  const key = compileSource(entry.key);
  const closure = new Map<string, Set<string>>();
  const reach = (from: string): Set<string> => {
    let set = closure.get(from);
    if (set === undefined) {
      set = reachable(entry.allowed, from);
      closure.set(from, set);
    }
    return set;
  };
  return (epoch) => {
    const c = new Collector();
    const last = new Map<string, { state: string; command: ExchangeCommand }>();
    for (const command of epoch.commands) {
      if (!command.accepted || !tagged(command, entry.tag)) continue;
      const k = readKey(key, command.exchange);
      if (k === undefined) continue;
      const raw = readSource(path, command.exchange);
      if (raw === undefined && unreadable(path, command.exchange)) {
        c.undecided(`the body of ${command.id} was not kept`);
        continue;
      }
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
      const state = String(raw);
      const previous = last.get(k);
      last.set(k, { state, command });
      if (previous === undefined || previous.state === state) continue;
      c.check();
      if (reach(previous.state).has(state)) continue;
      if (before(previous.command, command)) {
        c.violation(
          `${key.text} ${k}`,
          [...reach(previous.state)].sort(),
          state,
          `${previous.state} cannot move to ${state}; the earlier state was seen in exchange ${previous.command.id}`,
          command.id,
        );
      } else {
        c.undecided(`${previous.command.id} and ${command.id} overlapped`);
      }
    }
    return c.outcome();
  };
}

export function conservationCheck(entry: ConservationInvariant): Check {
  const deltaPath = compileSource(entry.delta_of.path);
  const readPath = compileSource(entry.equals_change_in.path);
  const readKeySource =
    entry.equals_change_in.key === undefined
      ? undefined
      : compileSource(entry.equals_change_in.key);
  const deltaKey =
    entry.delta_of.key === undefined ? readKeySource : compileSource(entry.delta_of.key);
  const NO_KEY = '';
  return (epoch) => {
    const c = new Collector();
    const reads = new Map<string, { value: number; command: ExchangeCommand }[]>();
    const deltas: {
      key: string | undefined;
      amount: number | undefined;
      command: ExchangeCommand;
    }[] = [];
    for (const command of epoch.commands) {
      if (!command.accepted) continue;
      const tags = command.exchange.tags;
      if (tags.includes(entry.delta_of.tag)) {
        deltas.push({
          key: deltaKey === undefined ? NO_KEY : readKey(deltaKey, command.exchange),
          amount: asNumber(readSource(deltaPath, command.exchange)),
          command,
        });
      }
      if (tags.includes(entry.equals_change_in.tag)) {
        const k = readKeySource === undefined ? NO_KEY : readKey(readKeySource, command.exchange);
        const raw = readSource(readPath, command.exchange);
        const value = asNumber(raw);
        if (k === undefined) continue;
        if (raw === undefined) {
          if (unreadable(readPath, command.exchange)) {
            c.undecided(`the body of ${command.id} was not kept`);
          }
          continue;
        }
        if (value === undefined) {
          c.undecided(`${readPath.text} in ${command.id} is not a number`);
          continue;
        }
        reads.set(k, [...(reads.get(k) ?? []), { value, command }]);
      }
    }
    for (const [k, series] of reads) {
      for (let i = 1; i < series.length; i += 1) {
        const a = series[i - 1] as { value: number; command: ExchangeCommand };
        const b = series[i] as { value: number; command: ExchangeCommand };
        if (!before(a.command, b.command)) {
          c.undecided(`reads ${a.command.id} and ${b.command.id} overlapped`);
          continue;
        }
        let sum = 0;
        let count = 0;
        let problem: string | undefined;
        for (const d of deltas) {
          const outside = before(d.command, a.command) || before(b.command, d.command);
          if (outside) continue;
          if (d.key !== undefined && d.key !== k) continue;
          const inside = before(a.command, d.command) && before(d.command, b.command);
          if (!inside) problem = `command ${d.command.id} overlapped a read`;
          else if (d.key === undefined) problem = `command ${d.command.id} has no key`;
          else if (d.amount === undefined)
            problem = `command ${d.command.id} has no number at ${deltaPath.text}`;
          if (problem !== undefined) break;
          sum += d.amount as number;
          count += 1;
        }
        if (problem !== undefined) {
          c.undecided(problem);
          continue;
        }
        c.check();
        const change = b.value - a.value;
        if (!sameAmount(change, sum)) {
          c.violation(
            `${readKeySource === undefined ? readPath.text : `${readKeySource.text} ${k}`} between exchanges ${a.command.id} and ${b.command.id}`,
            sum,
            change,
            `${count} accepted ${entry.delta_of.tag} command${count === 1 ? ' adds' : 's add'} up to ${sum}, and ${readPath.text} changed by ${change}`,
            b.command.id,
          );
        }
      }
    }
    return c.outcome();
  };
}
