# Troubleshooting

This page answers questions that the demo and `DEFERRED.md` raise. Each section gives the question, the cause, and what to do. The answers come from the engine's documented rules, the code, and the tests, and each section names the page that owns the detail.

## Why does a sequential recording replay one request at a time?

`rp replay --concurrency 8` does not make a sequential recording faster. The engine never introduces an ordering the recording did not have, and it also never drops one. An exchange that began after an earlier exchange's response in the recording is not sent before that earlier exchange is acknowledged. Without `--session-key` the whole recording is one session, so the rule holds across all of it. The demo's recording is sequential, so it is one chain, and `--concurrency` only sets the size of a pool the chain does not fill. The throughput in the README is bounded by the candidate's latency for this reason.

The run records `pacing.sessions`, which is 1 here. To let independent clients overlap, name where a request carries its session:

```sh
rp replay --recording traffic.jsonl --target "$CANDIDATE_URL" --session-key header:x-session-id
```

`--session-key` takes `header:<name>`, `cookie:<name>`, or a JSONPath into the request body. Order is kept within a session, and sessions overlap up to `--concurrency`. Four things still order across sessions: barrier tags, controls, a request that uses a substituted value (it waits for the exchange that produced it, in whichever session that ran), and the exchanges that have no value at the key, which form one session of their own.

Check that the key finds a value. A header or cookie that the capture redacted holds `<redacted>` in the recording, and that is a value, so every exchange lands in one session and the replay is as sequential as before. The default redaction list includes `authorization` and `cookie`. Choose a header that is not redacted, a field in the body, or a body field the capture hashed with `mode: hash`, which keeps equal values equal. `pacing.sessions` in the run shows how many sessions the key found. `docs/architecture.md` under "Sessions run side by side" has the full rule.

## Why does a timestamp fail without a rule?

A field such as `created_at` holds the time the system stamped it. The recording holds the reference's value from the day of the capture, and the candidate stamps its own value on the day of the replay, so the two can never be equal. The demo shows it. With `demo/diff-rules.yaml` minus its `ignore` entry, a replay against a clean candidate fails with `top mismatching paths: $.created_at x152 in 152 exchanges`. Nothing is wrong with the candidate.

There are three answers.

- **An ignore rule.** `ignore: ['$.created_at']` removes the path from both sides, which is what `demo/diff-rules.yaml` does. It is the right choice for a field that records the time of the response, because the gap between the recorded value and the replayed one is the age of the recording. `ignore: ['$..created_at']` covers the path at any depth.
- **A `time` rule.** `time: [{ path: '$..created_at', abs_ms: 5000 }]` tolerates two timestamps within `abs_ms` milliseconds, and `examples/rule-packs/timestamps.yaml` is a pack of them to include. Use it for a timestamp that both systems should agree on to within a tolerance. It still reports a timestamp that is far apart. `rp rules suggest` proposes `time`, `mask`, and `ignore` rules from two captures of the same traffic, but its tolerance describes the gap between those two captures and not the age of your replay, so read it before you copy it.
- **`--reference-target`.** Replay with `--reference-target <url>` and every exchange also goes to the reference. A path where the reference differs from its own recording is noise, and the same difference on the candidate is tolerated as `noise:reference` and counted apart. On the demo this passes with no ignore rule and reports 152 tolerated findings. The reference receives the traffic again, writes included, and a `correctness.noise_rate_max` threshold fails the run if the noise grows.

`docs/diff-rules.md` describes every key, and `docs/thresholds.md` describes how noise is excluded from the mismatch rate.

## Why did a barrier time out?

The run is inconclusive with the kind `barrier_timeout`, and its detail reads like `POST /v1/orders (id) waited 10000 ms for 2 earlier exchanges: id, id`. A barrier tag makes its exchange wait until every earlier exchange of every session has a response or an error, run alone, and be acknowledged before anything later is sent. The wait ends at `--barrier-timeout-ms`, 10000 by default.

The exchanges the detail names were still in flight. Look them up by id in the run file, or in its sidecar. An `error` of kind `timeout`, or a `candidate.latency_ms` near the limit, says the candidate was slow or never answered. The request timeout `--timeout-ms` defaults to 30000, which is longer than the barrier timeout, so a candidate that never answers an earlier exchange trips the barrier first. With `--reference-target` an exchange counts as acknowledged only when both systems answered, so a slow reference can hold a barrier as well.

Fix the cause first. If the earlier exchanges are slow for a legitimate reason, raise `--barrier-timeout-ms`. If the barrier is on a tag that does not need one, remove it from `--barrier-tag`. A barrier belongs on a snapshot read that must see every earlier write, as `list-ledger` does in the demo. `docs/operations.md` lists the other inconclusive kinds.

## Why does a filtered replay still mismatch on reads after a lifecycle command?

`--filter tag=get-order` replays the reads. Because the reads use order ids, the engine also selects the exchanges that produce those ids, the `create-order` exchanges, so no read mismatches on its id or status from a missing create. The run prints `selected 44 dependency exchanges that produce values the filtered exchanges use`.

A read that followed a shipment, a cancel, or a quantity change in the recording still differs, because the engine pulls in producers of substituted values and nothing a read uses is a value those commands produce. The candidate answers the read with the order as it stands after the create alone. On the committed recording `--filter tag=get-order` reports 27 mismatches on `$.remaining`, `$.status`, `$.shipped`, `$.canceled_at`, `$.canceled_unshipped`, and the other fields the lifecycle changes. A lifecycle aware prerequisite rule is on the deferred list.

To replay the reads with the commands that shaped them, cut a recording that keeps every tag in the lifecycle and replay that file:

```sh
rp recording filter demo/recording.jsonl --out lifecycle.jsonl \
  --tag create-order --tag ship-order --tag cancel-order --tag set-quantity --tag get-order
rp replay --recording lifecycle.jsonl --target "$CANDIDATE_URL" --rules demo/diff-rules.yaml
```

`rp recording filter` keeps the exchanges with any of the tags in recording order and rebases the offsets. On the demo this keeps 176 of the 283 exchanges and replays with no mismatch. A candidate that keeps state must be reset first. `--no-include-dependencies` turns the dependency selection off.

## Why does a timing test stall on a loaded machine?

This is about the repository's own test suite and not about `rp replay`. On the macOS machine where it was observed, a vitest worker stalls for about 9 seconds when another suite runs at the same time. A synchronous test of a few hundred milliseconds then takes 7 seconds, and a test with a plain elapsed bound fails. The likely cause is process scheduling or timer throttling of the forked workers, but it is not confirmed. The options listed to try are `pool: threads` or fewer workers in the CI configuration.

The timing policy in `docs/testing.md` makes the suite pass under the stall. A timing test reads the run's own fields, `scheduled_at_ms`, `sent_at_ms`, and `acked_at_ms`, and not a stopwatch. Its absolute bound leaves at least 1500 ms over the quiet figure with a comment saying why. It carries `retry: 2`, and an `onTestFailed` hook prints what the failed attempt saw, so a retry is never silent. A candidate that runs in the test's own process shares the worker's stalls, so a test that expects a `pass` verdict gates on the correctness and error rows and not on latency.

When a test fails only under load, run it alone first. If it passes alone, read the retry output, which names the fields the attempt judged. Fix it by reading the run's own fields and by loosening the absolute bound with a comment. Do not remove the assertion. The check for the policy is `pnpm test` run three times while `pnpm exec vitest run --project unit` runs in another process.

## Why does the preflight warn that a control tag names no exchange?

The demo's rules list the control tags `admin-restart` and `admin-reset`. The committed recording holds one `admin-restart` exchange and no `admin-reset`, so the preflight prints `preflight: warn  rules: control tag admin-reset names no exchange`. A control tag that matches nothing is a warning and not an error, and the replay goes on. `scripts/demo.sh` resets its services with `curl` before the capture starts, so no reset passes through the proxy. `docs/configuration.md` lists the preflight checks and their levels.
