# Shrinking

`rp shrink` takes a failing run and the recording it replayed and finds a shorter list of recorded steps that still trips the same rule. It replays each candidate subset against a candidate system that has been reset to its initial state, judges the result by the rule, and keeps the smaller list when the rule still trips. The result is a reduced reproduction. It is not a proof of minimality, and the label never says so.

This page covers the rule to reproduce, the reset strategies, value lowering and simplifying, parallel targets, the attempt cache, and shrinking to a latency breach. The fields written to the run are in `docs/report-format.md`.

## Running

```sh
rp shrink --run run.json --recording recording.jsonl \
  --target http://localhost:8080 --reset-url http://localhost:8080/admin/reset
```

The command rewrites `run.json` with a `reproduction` section and writes the reduced recording to `--out` (default `reduced-reproduction.jsonl`). Replaying that file against a reset candidate trips the rule again. The command exits 0 when it finishes, 1 on a configuration error, and 3 when a signal stopped it; a stop keeps the best reduction found so far.

Every flag can also come from `rp.yaml` under `shrink:`.

The search is delta debugging over the steps. The list is cut into chunks, each chunk is tried for removal together with the steps it needs, and a removal that still reproduces is kept. A step needs the earlier steps whose responses it uses, named by the `substitutions` in the rules, and the create of any order it touches. When no chunk can be removed the chunks get smaller, down to single steps. Steps after the exchange that witnessed the failure are dropped first. `--max-attempts` (default 64) and `--time-budget-ms` (default 120000) bound the work.

## The rule

`--rule` names what must keep happening. Without it the first violated invariant is used, candidate before reference, else the first mismatched exchange.

| Rule                              | Reproduces when                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `invariant:<system>:<name>`       | the named invariant is violated on `reference` or `candidate`                                     |
| `mismatch:<exchange id>[:<path>]` | the exchange still differs from its recorded response, at the path when one is given              |
| `latency:<tag>:<metric>`          | the metric of the tag's candidate latency over the subset still exceeds the run's threshold limit |

An attempt that the harness could not complete, such as a barrier timeout or a failed control exchange, never counts as a reproduction.

## Reset strategies

Every attempt starts from a reset candidate. Exactly one strategy is required.

| Flag                    | The reset is                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `--reset-url <url>`     | a `POST` to the URL, which must answer 2xx. `--reset` is the same flag under its earlier name. |
| `--reset-command <cmd>` | a shell command, run with `child_process.spawn` through the shell                              |
| `--reset-module <path>` | an ES module that exports `reset()`, as a named export or on its default export                |

`--reset-url` uses the `--upstream-*` and `--http-proxy` settings, like the requests of the replay.

A reset command that exits nonzero, or runs longer than `--reset-timeout-ms` (default 30000), fails the shrink with an error that names the command and the tail of its stderr. A command past the timeout is killed together with the processes it started.

```sh
rp shrink --run run.json --recording recording.jsonl --target http://localhost:8080 \
  --reset-command 'docker compose restart candidate' \
  --reset-health http://localhost:8080/healthz
```

A reset module exports a function that returns a promise. It receives `{ target }`, the base URL of the candidate it serves, which a module for one target can ignore.

```js
export async function reset({ target }) {
  await fetch(`${target}/admin/reset`, { method: 'POST' });
}
```

`--reset-health <url>` is optional. After any reset the URL is polled with `GET` until it answers 2xx. When `--reset-timeout-ms` passes first, the shrink fails and names the URL and the last answer.

## Lowering and simplifying values

After the steps are reduced, the bodies of the remaining steps are reduced too. The `shrink` key of the rules file (`--rules`, or the rules embedded in the run) says where.

```yaml
shrink:
  lower: ['$.qty', '$.items[*].quantity']
  simplify: ['$.note', '$.tags']
```

- `lower` lists the paths of integers. Each integer above one is lowered toward one: first one is tried, then a binary search between the largest value that failed and the smallest that worked. The lowest value that still reproduces is kept.
- `simplify` lists the paths of values that may be replaced by a minimal value of the same kind: a string becomes `""`, an array `[]`, an object `{}`. The replacement is kept when the rule still reproduces. Numbers, booleans, and null are left alone.

Paths are in the plain JSONPath subset used by `unordered` (`$`, `.name`, `['name']`, `[n]`, `[*]`) and apply to the request body. A path that matches nothing is skipped. A wildcard is handled one match at a time.

When `shrink.lower` is absent the fields `qty` and `quantity` at the top of the body are lowered, and only for a candidate invariant rule, which is what `rp shrink` did before the key existed. With `shrink.lower` present, lowering applies to every rule kind. `simplify` applies to every rule kind whenever it is listed.

Each value that ended up different is recorded on its step as `changed: [{ path, from, to }]`, with the concrete path (`$.items[1].quantity`) and the recorded value as `from`. `quantity_reduced` stays true when a lowered integer was reduced.

## Parallel targets

With several candidate systems the chunks of one removal round run at once.

```sh
rp shrink --run run.json --recording recording.jsonl \
  --targets http://c1:8080,http://c2:8080 \
  --reset-url http://c1:8080/admin/reset,http://c2:8080/admin/reset
```

`--targets` replaces `--target` and lists the base URLs separated by commas. Each target needs its own reset: `--reset-url` with one URL per target in the same order, a `--reset-command` that contains `{target}` (replaced by each target in turn, also in `--reset-health`), or a `--reset-module`, which receives `{ target }`. The targets must be independent copies, because every attempt resets the target it runs on.

A round tries its chunks in windows as wide as the target list. The first chunk in chunk order that reproduces is taken, so the reduction is the one the sequential run finds, and the attempt count is the one the sequential run reports. Replays that ran ahead of the chunk that was taken are not attempts; they are not counted in `attempts`, and they cost wall time on a target that would have been idle. Lowering and simplifying stay sequential, because each step of a binary search depends on the one before it.

The attempt budget is applied to the counted attempts, and a window is narrowed when the budget is nearly spent, so a budget never ends a parallel shrink earlier than a sequential one.

## The attempt cache

An attempt is keyed by a SHA-256 of the exact subset: for each step, its id and its request as it is sent, which includes lowered values. The key also covers the rule, the thresholds limit and `--latency-repeat` of a latency rule, the diff rules, and the headers, query overrides, and barrier tags. A key that was judged before is answered from the cache. The subset is not replayed, no reset runs, and the answer does not count as an attempt. The number answered this way is recorded as `cache_hits`.

The cache lives for one command. `--cache <path>` keeps it between commands as JSON lines, one verdict per line:

```json
{ "key": "9f2c...", "reproduced": true }
```

The file is read when the command starts and appended to as attempts finish, so an interrupted shrink keeps its verdicts. A second `rp shrink` of the same run, recording, and rule finds the same reduction with `attempts: 0`. A line that is not a verdict, such as one cut short by a crash, is skipped.

An attempt that the harness could not complete is not stored. The cache does not know the candidate's version, so use a new cache file after the candidate changes.

## Shrinking to a latency breach

`--rule latency:<tag>:<metric>` reduces a run that failed a latency threshold. The metric is `p50`, `p90`, `p99`, or `max`. The run's thresholds must set the matching limit under `latency.by_tag.<tag>` (`p99_ms` for `p99`, and so on); the shrink fails when they do not, and takes `min_samples` from the same block or from `latency.min_samples`.

```sh
rp shrink --run run.json --recording recording.jsonl --target http://localhost:8080 \
  --reset-url http://localhost:8080/admin/reset \
  --rule latency:get-order:p99 --latency-repeat 20
```

Latency varies from one replay to the next, so a single replay cannot say whether a subset still breaches. Each attempt resets and replays its subset `--latency-repeat` times (default 20), pools the candidate latencies of the successful exchanges that carry the tag, and judges the nearest rank percentile of the pool against the limit. The subset reproduces when the percentile is above the limit and the pool has at least the minimum number of samples. A subset with no exchange of the tag never reproduces.

Because the judgement is over a sample, a different run of the same shrink can keep a different subset. The reproduction is labeled `reduced reproduction (statistical)` and records `repeat`. Treat it as a strong hint about which steps cause the slowdown, and confirm it by replaying the reduced recording. Raise `--latency-repeat` when the result is noisy. Each attempt costs `--latency-repeat` replays of the subset.

## What is not done

- `--preflight-probe` probes the first target and the first reset URL only.
- A module of invariants given to `rp replay` with `--invariants-module` is not passed to `rp shrink`; an invariant rule is judged by the built in rules.
- The cache is not shared between machines and is not versioned against the candidate.
