# Invariants

An invariant is a statement about one system that its own recording can prove or refute: a counter never goes down, a read after an acknowledged write shows the write, a retried request has one effect. Invariants never compare the reference with the candidate. Agreement between two systems is not evidence of correctness, so each system is checked against its own acknowledgements.

Rules come from one of three places:

- the built in `order-lifecycle` module, the ten rules for the demo's order service, which is the default;
- an invariant module, an ES module of your own, with `--module`;
- a declarative rules file, `invariants.yaml`, with `--rules`, for rules that need no code.

This page gives the module contract, the declarative rules with examples, the built in module, and how to run invariants on a recording of the reference alone as an audit.

## Running

```sh
rp invariants --recording recording.jsonl                                   # the built in module
rp invariants --recording recording.jsonl --module ./invariants.mjs         # a module of your own
rp invariants --recording recording.jsonl --rules ./invariants.yaml         # declarative rules
rp invariants --recording recording.jsonl --rules ./invariants.yaml --out report.json --system reference
```

`--module` and `--rules` cannot be combined. Every flag can also come from `rp.yaml`:

```yaml
invariants:
  recording: recordings/reference.jsonl
  rules: invariants.yaml
  system: reference
```

The exit code is 0 when every rule holds or has nothing to check, 2 when a rule is violated, 3 when a rule could not decide and none was violated, and 1 for a configuration error such as a missing file or a malformed module. A condition from the module's `inconclusive` hook makes the whole report inconclusive, so the exit code is 3 even when a rule was violated.

The terminal shows one line per rule and up to five evidence entries each. `--out` writes the full report as JSON. The report names the module that produced it:

```json
"module": { "name": "key-value-store", "version": "1.0.0", "sha256": "af4c8e40..." }
```

`sha256` is the hash of the module file or the rules file, so a report says exactly which rules it ran. It is `null` for the built in module, which the package version identifies. Reports written before modules existed have no `module` key and came from the order lifecycle rules.

`rp replay --invariants` evaluates the built in module on both recordings. `rp replay --invariants-module <path>` and `rp replay --invariants-rules <path>` evaluate another module or a declarative rules file instead, on both recordings, and imply `--invariants`. The two flags cannot be combined.

## The module contract

A module is an ES module. It exports `name`, `version`, `parse`, and `rules`, either as named exports or as one default export object with those keys.

```ts
/** The fields every command carries, whatever the module. */
interface BaseCommand {
  kind: string; // what the exchange did; 'other' is ignored, an accepted 'reset' starts an epoch
  accepted: boolean; // the system acknowledged it, normally a 2xx
  sentMs: number; // when the request was sent, from the start of the recording
  ackedMs: number; // when the response arrived
  id: string; // the exchange id, which evidence names
}

interface InvariantRule<E> {
  id: number; // a positive integer, unique within the module
  name: string; // unique within the module
  statement: string; // the invariant in one sentence
  check(epoch: E): RuleOutcome;
}

interface RuleOutcome {
  status: 'holds' | 'violated' | 'not_applicable' | 'inconclusive';
  checks: number; // instances examined
  evidence: {
    subject: string; // what the finding is about, such as 'key alpha'
    expected: JsonValue;
    observed: JsonValue;
    detail: string;
    exchange_id: string | null; // the exchange that witnessed it
  }[];
  detail?: string;
}

interface InvariantModule<C extends BaseCommand, E = { start: number; commands: C[] }> {
  name: string;
  version: string;
  parse(exchange: Exchange, index: number): C;
  rules: InvariantRule<E>[];
  // Optional hooks, with their defaults:
  epochs?(commands: C[]): E[]; // a new epoch at every accepted 'reset'
  stateChanging?: string[]; // the kinds the report counts as commands; every kind except 'other'
  snapshots?(commands: C[]): { ledger_reads: number; stock_reads: number; order_reads: number }; // zeros
  inconclusive?(commands: C[]): { kind: string; detail: string }[]; // none
}
```

`parse` sees one exchange at a time, in recording order, with its position. A command is whatever the rules need: the generic fields above plus any of your own, such as a key, a value, or a parsed response. `Exchange` is the recording's own type: `id`, `offset_ms`, `request` with `method`, `path`, `query`, `headers`, and `body`, `response` with `status`, `headers`, `latency_ms`, and `body`, and `tags`.

The evaluator calls `parse` on every exchange, groups the commands into epochs, calls each rule's `check` once per epoch, and merges the outcomes: violated wins, then inconclusive, then holds, and a rule with no checks in any epoch is not applicable. Evidence is capped at 25 entries per rule. Every outcome is validated, so a rule that returns an unknown status or a malformed evidence entry stops the run with a message naming the module and the rule, as does a `parse` or `check` that throws.

`loadInvariantModule(path)` in `@replay-parity/invariants` loads a module the way `--module` does. It throws a `ConfigError` for a file that does not exist, a module that fails to import, a missing or empty `name`, a `version` that is not a string, a missing `parse`, an empty `rules`, a rule without a positive integer `id`, a `name`, a `statement`, and a `check` function, two rules with the same id or name, and an optional hook of the wrong type. A program calls `evaluateInvariants(exchanges, { module })` with the result.

### Deciding under concurrency

A recording of concurrent traffic does not say when the system applied each command, only that it happened between `sentMs` and `ackedMs`. A rule should decide only what the timing proves. Command `a` is known to precede `b` when `a.ackedMs <= b.sentMs`. When two exchanges overlap and the verdict depends on their order, the rule should count the instance as inconclusive with a note naming both exchanges, not as a violation. The built in rules and the example below follow this.

### The example module

`examples/invariants/key-value-store.mjs` is a module for a generic key value service, with no imports so it runs from any directory:

| Rule                         | Statement                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ |
| 1 `put-returns-version`      | An accepted put answers with an integer version.                               |
| 2 `get-latest-version`       | A get after an acknowledged put shows that put, with its version and value.    |
| 3 `delete-then-404`          | A get after an acknowledged delete, with no put since, answers 404.            |
| 4 `versions-never-backwards` | The versions one key shows never go backwards, across puts, gets, and deletes. |

```sh
rp invariants --recording examples/invariants/key-value-store.jsonl \
  --module examples/invariants/key-value-store.mjs
```

The recording beside it is fifteen synthetic exchanges, including a delete, a reset, and a key that was never written, and every rule holds on it. The module's `parse` maps `PUT`, `GET`, and `DELETE` on `/kv/{key}` to `put`, `get`, and `delete` commands and `POST /admin/reset` to `reset`, so the default epochs restart the version history at a reset.

## Declarative rules

`invariants.yaml` covers the rule shapes most services share. The built in `declarative` module evaluates it, so no code is involved. Every section is optional, and the file must define at least one rule. Each entry takes an optional `name` of lower case letters, digits, and dashes. Without one, a rule is named after its kind and its position within the kind, as `monotonic-2`. Rules are numbered in the order idempotency, monotonic, read_your_writes, transitions, conservation.

### Where values come from

Paths, keys, and fields are sources. A source reads one value from one exchange:

| Source                | Reads                                                                              |
| --------------------- | ---------------------------------------------------------------------------------- |
| `$.a.b`               | the response body                                                                  |
| `request:$.a.b`       | the request body                                                                   |
| `header:name`         | a response header                                                                  |
| `request-header:name` | a request header                                                                   |
| `query:name`          | a query parameter, the first when it repeats                                       |
| `path:pattern`        | the request path through a regular expression: the first group, or the whole match |

Body paths use the plain JSONPath subset: `$`, `.name`, `['name']`, `[n]`, `[*]`, `.*`. A key is a string or a number; an exchange whose key source reads anything else is skipped. A numeric value may be a number or a string that spells one.

Only accepted exchanges, those with a 2xx status, count as observations, except where a rule says otherwise. An exchange counts as a `read` when its method is `GET`, `HEAD`, or `OPTIONS` and as a `write` otherwise, and the report counts writes as commands.

### reset_tag

```yaml
reset_tag: admin-reset
```

An accepted exchange with this tag starts a new epoch. Every rule starts over in each epoch.

### idempotency

```yaml
idempotency:
  header: idempotency-key # the request header that carries the key
  by_payload: true # group by payload under a key (default true)
  tag: create-order # only these requests (default: every request with the header)
  identity: '$.order_id' # compare accepted responses by this value (default: status and body)
```

For each key, three things are checked. With `by_payload`, requests under one key are grouped by their canonical request body, and at most one payload is ever accepted. Within a group, every accepted retry answers like the first accepted request, by `identity` when it is given and by status and body otherwise. A retry sent after the first accepted request was acknowledged is not rejected. With `by_payload: false`, every request under a key is a retry of the first. `idempotency` takes one entry or a list.

Inconclusive: a rejected retry that was sent while the first accepted request was still in flight, a response body too large to keep, or an `identity` that is absent.

### monotonic

```yaml
monotonic:
  - name: shipped-never-decreases
    path: '$.shipped'
    key: '$.order_id'
    tag: get-order # optional
```

The numeric value at `path` never decreases across the accepted responses that share a key. A value lower than one acknowledged before the request was sent is a violation. A value lower only than one from an overlapping exchange is inconclusive, as is a value that is present but not a number.

### read_your_writes

```yaml
read_your_writes:
  - write_tag: put-key
    read_tag: get-key
    substitution: 'path:^/kv/([^/]+)$'
    fields:
      - '$.value' # the write's request body and the read's response body
      - { write: 'header:etag', read: '$.etag' } # an explicit pair of sources
```

`substitution` is the value that ties a read to a write, read from both exchanges with the same source. For each accepted read, the rule finds the last accepted write with the same value that was acknowledged before the read was sent, and checks that the read shows each field as written. A field written as a text path reads the write's request body and the read's response body; the `{ write, read }` form names both sources. A missing field in the read is a violation, and the evidence names the read exchange and the write it should have shown.

Inconclusive: a write to the same value that overlapped the read, two last writes that overlapped each other so the winner is unknown, or a write with no value at a field. Writes with other tags, such as a delete, are not considered, so a rule over a key that can be deleted should give deletes a separate rule or a module.

### transitions

```yaml
transitions:
  name: order-status
  path: '$.status'
  key: '$.order_id'
  allowed:
    OPEN: [PARTIALLY_SHIPPED, SHIPPED, CANCELED]
    PARTIALLY_SHIPPED: [SHIPPED, CANCELED]
```

Successive values at `path` for one key move only along `allowed`. A state with no entry is final. Observations are samples, so a move is allowed when the new state is reachable in one or more allowed steps: `OPEN` then `SHIPPED` holds above even without the direct edge, since `PARTIALLY_SHIPPED` may have been missed. Repeating a state is not a move. A disallowed move between two overlapping observations is inconclusive. `transitions` takes one entry or a list.

### conservation

```yaml
conservation:
  - delta_of: { tag: incr, path: 'request:$.by' }
    equals_change_in: { tag: get-counter, path: '$.value', key: 'path:^/counters/([^/]+)' }
```

Between two successive accepted reads of one key, the change in the read value equals the sum of the values at `delta_of.path` over the accepted `delta_of` commands that ran between them. `equals_change_in.key` keys both the reads and the commands, unless `delta_of` names its own `key`. Without a key, every command and every read belong to one series. Rejected commands count zero. Sums are compared within rounding, so `0.1 + 0.2` equals `0.3`.

Inconclusive: two reads that overlapped, a command that overlapped one of the reads, a command between the reads whose key cannot be read, or one with no number at its path.

### A complete file

`examples/invariants/order-lifecycle.yaml` restates four of the demo's rules declaratively and holds on the committed recording:

```sh
rp invariants --recording demo/recording.jsonl --rules examples/invariants/order-lifecycle.yaml
```

## The built in module

`order-lifecycle` is the module for the demo's order service and the default for `rp invariants` and `rp replay --invariants`. Its `parse` maps the demo's routes to commands such as `create`, `shipment`, `quantity`, `cancel`, `adjust`, `read-order`, and `read-ledger`. Its `epochs` hook rebuilds the expected state of every order and every SKU from the system's own accepted commands, so the rules compare what the system showed with what its acknowledgements imply. A command the system rejected is never applied, and a retried command is applied once.

| Rule                          | Statement                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `shipment-applied-once`     | An accepted shipment event changes stock on hand exactly once, including after retries or restart.                                      |
| 2 `shipped-within-quantity`   | Shipped quantity never exceeds the effective total quantity.                                                                            |
| 3 `shipped-monotonic`         | Cumulative shipped quantity never decreases.                                                                                            |
| 4 `remaining-arithmetic`      | Remaining equals total minus shipped for live orders and is zero after cancellation. Unshipped canceled quantity is tracked separately. |
| 5 `stock-on-hand`             | Stock on hand equals initial stock plus accepted adjustments minus unique accepted shipments.                                           |
| 6 `receivables`               | Receivables equal the sum of unique shipment line totals, computed in decimal.                                                          |
| 7 `rejected-no-shipments`     | A rejected order produces no shipments.                                                                                                 |
| 8 `idempotency-key`           | Same idempotency key and payload have one effect; same key with a different payload is rejected.                                        |
| 9 `retry-no-reset`            | A retried command cannot reset state or create a second order.                                                                          |
| 10 `allocation-deterministic` | Allocation decisions are deterministic given the order and the stock snapshot in the recording.                                         |

Its `inconclusive` hook reports `snapshot_before_ack` when a state changing command was still in flight at the final ledger read, and its `snapshots` hook counts ledger, stock, and order reads for the report. The source is in `packages/invariants/src/order-lifecycle/`, and it is the fullest example of the contract: a module with its own epoch model.

## Auditing a reference recording

Invariants need nothing but one recording, so they can check a production recording of the reference without a candidate. Capture traffic as usual, then run the rules on that file alone:

```sh
rp capture --target https://orders.internal --out recordings/prod-2026-11-03.jsonl
rp invariants --recording recordings/prod-2026-11-03.jsonl --rules invariants.yaml \
  --system reference --out audit.json
```

A violation is a defect in the reference itself, found from its own responses, with the exchange that witnessed it. Three things matter for an audit:

- Production traffic is concurrent. Expect some instances to be inconclusive where requests overlapped. The report counts them and names the first few, and the exit code is 3 when nothing was violated but something could not be decided. Treat 2 as the failure and 3 as a prompt to look.
- A recording starts in the middle of the system's life, so the first observation of each key has no history. Rules start from what they first see: a monotonic counter is checked from its first value, a read with no earlier write in the recording is not checked, and a conservation series starts at its first read.
- Responses are stored as received, subject to the capture's body size cap. A body over the cap of `rp capture --max-body-bytes` is stored as a hash, and a declarative rule that needs it counts the instance as inconclusive.
