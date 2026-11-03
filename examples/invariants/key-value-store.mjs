// An invariant module for a generic key value service, run with
//   rp invariants --recording examples/invariants/key-value-store.jsonl \
//     --module examples/invariants/key-value-store.mjs
//
// The service it describes:
//   PUT    /kv/{key}  body { "value": ... }  answers { "key", "value", "version" }
//   GET    /kv/{key}                         answers { "key", "value", "version" } or 404
//   DELETE /kv/{key}                         answers 204, and later gets answer 404
//   POST   /admin/reset                      empties the store
//
// The module has no imports, so it runs from any directory. docs/invariants.md
// describes the contract it follows.

export const name = 'key-value-store';
export const version = '1.0.0';

const KEY = /^\/kv\/([^/?]+)$/;

/** The integer version in a response body, or null. */
function versionOf(body) {
  const v = body !== null && typeof body === 'object' ? body.version : undefined;
  return Number.isInteger(v) ? v : null;
}

/**
 * Maps one exchange to a command. Every command carries the generic fields
 * kind, accepted, sentMs, ackedMs, and id, and the fields these rules read.
 */
export function parse(exchange, index) {
  const { request, response } = exchange;
  const base = {
    index,
    id: exchange.id,
    sentMs: exchange.offset_ms,
    ackedMs: exchange.offset_ms + response.latency_ms,
    status: response.status,
    accepted: response.status >= 200 && response.status < 300,
  };
  const method = request.method.toUpperCase();
  if (method === 'POST' && request.path === '/admin/reset') return { ...base, kind: 'reset' };
  const m = KEY.exec(request.path);
  if (m === null) return { ...base, kind: 'other' };
  const key = decodeURIComponent(m[1]);
  const body = response.body;
  const shown = {
    version: versionOf(body),
    value: body !== null && typeof body === 'object' && 'value' in body ? body.value : undefined,
  };
  if (method === 'PUT') {
    const sent = request.body;
    const value = sent !== null && typeof sent === 'object' ? sent.value : undefined;
    return { ...base, kind: 'put', key, value, version: shown.version };
  }
  if (method === 'GET') return { ...base, kind: 'get', key, ...shown };
  if (method === 'DELETE') return { ...base, kind: 'delete', key };
  return { ...base, kind: 'other' };
}

export const stateChanging = ['put', 'delete', 'reset'];

/** Collects checks, evidence, and undecided instances for one rule over one epoch. */
function collector() {
  let checks = 0;
  const evidence = [];
  const undecided = [];
  return {
    check() {
      checks += 1;
    },
    violation(subject, expected, observed, detail, exchangeId) {
      evidence.push({ subject, expected, observed, detail, exchange_id: exchangeId });
    },
    undecided(note) {
      undecided.push(note);
    },
    outcome() {
      if (evidence.length > 0)
        return { status: 'violated', checks, evidence: evidence.slice(0, 25) };
      if (undecided.length > 0) {
        return {
          status: 'inconclusive',
          checks,
          evidence: [],
          detail: `${undecided.length} could not be decided: ${undecided.slice(0, 3).join('; ')}`,
        };
      }
      if (checks === 0) return { status: 'not_applicable', checks: 0, evidence: [] };
      return { status: 'holds', checks, evidence: [] };
    },
  };
}

/** True when a was acknowledged before b was sent. */
const before = (a, b) => a.ackedMs <= b.sentMs;

/**
 * The last acknowledged write (put or delete) to the key of `read`, or a
 * reason it cannot be known: a write overlapped the read, or the last two
 * writes overlapped each other.
 */
function lastWrite(epoch, read) {
  const writes = epoch.commands.filter(
    (c) => (c.kind === 'put' || c.kind === 'delete') && c.accepted && c.key === read.key,
  );
  const overlapping = writes.find(
    (w) => w.index !== read.index && !before(w, read) && !before(read, w),
  );
  if (overlapping) return { unknown: `${read.id} overlapped write ${overlapping.id}` };
  const done = writes.filter((w) => before(w, read));
  const last = done[done.length - 1];
  if (last === undefined) return { last: null };
  const rival = done.find((w) => w !== last && !before(w, last));
  if (rival) return { unknown: `writes ${rival.id} and ${last.id} overlapped` };
  return { last };
}

export const rules = [
  {
    id: 1,
    name: 'put-returns-version',
    statement: 'An accepted put answers with an integer version.',
    check(epoch) {
      const c = collector();
      for (const cmd of epoch.commands) {
        if (cmd.kind !== 'put' || !cmd.accepted) continue;
        c.check();
        if (cmd.version === null) {
          c.violation(
            `key ${cmd.key}`,
            'an integer version',
            null,
            'the put answered without a version',
            cmd.id,
          );
        }
      }
      return c.outcome();
    },
  },
  {
    id: 2,
    name: 'get-latest-version',
    statement: 'A get after an acknowledged put shows that put, with its version and value.',
    check(epoch) {
      const c = collector();
      for (const read of epoch.commands) {
        if (read.kind !== 'get') continue;
        const found = lastWrite(epoch, read);
        if (found.unknown) {
          c.undecided(found.unknown);
          continue;
        }
        if (found.last === null || found.last.kind !== 'put') continue;
        const put = found.last;
        c.check();
        if (read.status !== 200) {
          c.violation(
            `key ${read.key}`,
            `version ${put.version}`,
            `status ${read.status}`,
            `the get did not find what exchange ${put.id} wrote`,
            read.id,
          );
        } else if (
          read.version !== put.version ||
          JSON.stringify(read.value) !== JSON.stringify(put.value)
        ) {
          c.violation(
            `key ${read.key}`,
            { version: put.version, value: put.value ?? null },
            { version: read.version, value: read.value ?? null },
            `the get did not show the last put, exchange ${put.id}`,
            read.id,
          );
        }
      }
      return c.outcome();
    },
  },
  {
    id: 3,
    name: 'delete-then-404',
    statement: 'A get after an acknowledged delete, with no put since, answers 404.',
    check(epoch) {
      const c = collector();
      for (const read of epoch.commands) {
        if (read.kind !== 'get') continue;
        const found = lastWrite(epoch, read);
        if (found.unknown) {
          c.undecided(found.unknown);
          continue;
        }
        if (found.last === null || found.last.kind !== 'delete') continue;
        c.check();
        if (read.status !== 404) {
          c.violation(
            `key ${read.key}`,
            'status 404',
            `status ${read.status}`,
            `the key was deleted in exchange ${found.last.id}`,
            read.id,
          );
        }
      }
      return c.outcome();
    },
  },
  {
    id: 4,
    name: 'versions-never-backwards',
    statement: 'The versions one key shows never go backwards, across puts, gets, and deletes.',
    check(epoch) {
      const c = collector();
      const seen = new Map();
      for (const cmd of epoch.commands) {
        if ((cmd.kind !== 'put' && cmd.kind !== 'get') || !cmd.accepted || cmd.version === null)
          continue;
        const earlier = seen.get(cmd.key) ?? [];
        if (earlier.length > 0) c.check();
        let highest = null;
        let overlapped = null;
        for (const e of earlier) {
          if (before(e, cmd)) {
            if (highest === null || e.version > highest.version) highest = e;
          } else if (overlapped === null || e.version > overlapped.version) {
            overlapped = e;
          }
        }
        if (highest !== null && cmd.version < highest.version) {
          c.violation(
            `key ${cmd.key}`,
            `at least ${highest.version}`,
            cmd.version,
            `the version went back after exchange ${highest.id}`,
            cmd.id,
          );
        } else if (overlapped !== null && cmd.version < overlapped.version) {
          c.undecided(`${cmd.id} overlapped ${overlapped.id}`);
        }
        earlier.push(cmd);
        seen.set(cmd.key, earlier);
      }
      return c.outcome();
    },
  },
];
