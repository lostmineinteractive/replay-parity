# Operations

This page is a runbook for running `rp` against a real system. It covers capturing in front of a reference, running the replay in CI and on a schedule, reading each inconclusive condition, the exit codes a scheduler should expect, and what to attach to a ticket. It links to the page that owns each flag and does not repeat them. `docs/real-system.md` walks through a first setup from the start, and `docs/troubleshooting.md` answers the questions the demo raises.

## Capturing in front of a real reference

`rp capture` is a reverse proxy. Clients send their requests to the proxy, the proxy forwards each one to the reference, streams the response back unchanged, and appends one exchange per request to the recording.

```sh
rp capture --listen :8080 --target https://orders.internal --out recordings/ref.jsonl \
  --tag-rule 'POST /v1/orders=create-order' --tag-rule 'GET /v1/orders/*=get-order' \
  --capture-rules capture-rules.yaml --max-exchanges 50000
```

### TLS

`--tls-cert` and `--tls-key` make the proxy listen over HTTPS. For an https reference, `--upstream-ca` names the PEM file of the authorities that sign its certificate, `--upstream-cert` and `--upstream-key` present a client certificate, `--upstream-servername` sets the SNI name the certificate is checked against, and `--upstream-insecure` accepts any certificate. Use `--upstream-insecure` only for a throwaway environment. `rp replay`, `rp shrink`, and `rp agent` take the same `--upstream-*` flags for the candidate, and `rp replay` and `rp shrink` add `--http-proxy`. `docs/writing-adapters.md` describes them.

### Tag rules

A tag rule is `[METHOD ]<glob>=<tag>`. The first rule that matches wins, and a request that matches no rule is recorded with no tags. Thresholds, substitutions, barriers, and the filter all work on tags, so write the rules before the first capture. The tag rules are written into the manifest line at the top of the recording, so a recording says which rules produced it.

### Redaction and the key

The proxy replaces the value of `authorization`, `cookie`, `set-cookie`, and `x-api-key` with `<redacted>`, and the query parameters `api_key`, `apikey`, `access_token`, `token`, `key`, `secret`, `signature`, and `password`. `--redact-header` and `--redact-query` replace those lists. Bodies are stored as received unless a capture rules file says otherwise.

`--capture-rules` reads `redact.body`, `redact.query`, and `redact.headers`. Each entry is `drop`, which writes `<redacted>`, or `hash`, which writes `hmac-sha256:<hex>` keyed by the environment variable `RP_REDACTION_KEY`. Equal values give equal hashes, so a hashed id still lets a substitution match. The capture refuses to start when a rule hashes and the key is unset or empty. The key never reaches the recording or the manifest, and recordings hashed with different keys do not share hashes, so keep one key for the recordings that are compared with each other. Take the key from your secret store at job start and do not write it into `rp.yaml`. Ids in URL paths are not covered by body rules. `docs/capture.md` has the file format.

`rp recording scan` reports what looks like personal data in a finished recording, and `rp recording anonymize` applies a capture rules file to a recording that already exists.

### Session sampling

A request sampled on its own can keep a create and drop the read that uses its id. `--sample 0.1 --sample-by header:x-session-id` keeps whole sessions instead. The selector is `header:<name>`, `cookie:<name>`, or a JSONPath into the request body. A request with no session value is sampled on its own draw. `--sample-seed` fixes the seed, and without it a seed is drawn, logged, and written in the manifest. `--sample` below 1 without `--sample-by` prints a warning that substitution chains may break.

### Rotation, gzip, and limits

`--rotate-bytes`, `--rotate-interval`, and `--gzip` make the capture write numbered parts next to `--out`, such as `ref.0001.jsonl.gz`. Each part is a whole recording with its own manifest, and `offset_ms` continues across parts. A part replays on its own, but a read in one part that uses an id created in another has no producer in that file. To replay a whole capture, merge the parts first with `rp recording merge --out all.jsonl ref.0001.jsonl.gz ref.0002.jsonl.gz`, which reads gzip.

`--max-exchanges` and `--duration` end a capture the same way a signal does: the proxy stops accepting connections, lets requests in flight finish, flushes the file, and exits 0. Use one of them for a capture a scheduler starts.

### Sizing a recording

The demo recording holds 283 exchanges in 240,956 bytes, with a median stored response body of 222 bytes. Run `rp recording stats` on a short capture to see the exchange count, the body size percentiles, the span of offsets, and the largest gap, and scale from those.

- A body above `--max-body-bytes` (default 1048576) is stored as its hash and size. A capture holds at most that many bytes of a body in memory, so the cap bounds capture memory per body. A rule that needs a truncated body cannot read it. A declarative invariant that needs it counts the instance as inconclusive.
- Replay reads the recording through a window of `--window` exchanges (default 10000) and does not load it whole. With `--exchanges-sidecar`, which is on by default above 50000 results, the run file stays small and the results stream to a file beside it. The candidate recording and the invariants read whole recordings, so a very large replay is run without `--candidate-recording` and `--invariants`, or on a filtered or sampled file.
- `rp recording sample`, `filter`, and `split` cut an existing recording down. Each rebases `offset_ms` so the result replays with its original rhythm.

### Retention

`SECURITY.md` states the rule. A recording is a copy of the data its bodies carried, so store it where the reference's own data may be stored, share it only with people who may read that data, and delete it when the run that needed it is done. The same holds for a candidate recording and a run file, because both carry body values, and the HTML report shows the same values. Redaction rules reduce what is stored and do not remove the need for this. One more reason to keep a recording is a baseline. A run records the SHA-256 of the recording it replayed, and `--baseline` refuses a baseline from a different recording, so keep the recording for as long as you keep the baseline run.

## Running the replay in CI and on a schedule

### Settings in rp.yaml

Put the settings that do not change between jobs in `rp.yaml` and the ones that do in a profile.

```yaml
replay:
  recording: recordings/ref.jsonl
  rules: diff-rules.yaml
  thresholds: thresholds.yaml
  barrier-tag: [list-ledger]
  header:
    - 'authorization: Bearer ${CANDIDATE_TOKEN}'
profiles:
  pr:
    replay:
      limit: 2000
      pace: max
  nightly:
    replay:
      reference-target: ${REFERENCE_URL}
      baseline: previous/run.json
      exchanges-sidecar: true
```

`rp replay --profile nightly --target "$CANDIDATE_URL"` applies the profile. `${NAME}` is read from the environment when the command runs and is not written to the run. `docs/configuration.md` describes the layers and `rp doctor`.

### Preflight and reset

Run `rp validate` first in a pipeline. `rp replay` also runs the same checks before it sends anything and exits 1 without a run file on an error, so a misspelled tag fails at the start. `--preflight-probe` adds a probe of the target. The replay does not reset the candidate. If the candidate keeps state, reset it before every run. `scripts/demo.sh` resets every service before each replay, and a stateful candidate needs the same.

### Sessions and noise

Without `--session-key` the whole recording is one session and a sequential recording replays one request at a time. `--session-key header:<name>`, `cookie:<name>`, or a body JSONPath lets sessions overlap up to `--concurrency`.

`--reference-target <url>` sends every exchange to the reference as well, at the same moment, so a value that moves by itself on the reference, such as a timestamp, is marked as noise and cannot fail the candidate. The reference receives every exchange again, writes included, so point it at a copy that may take the traffic. `correctness.noise_rate_max` in the thresholds fails the run when the noise grows. `docs/thresholds.md` has the details.

### Baselines

`--baseline run.json` compares the run with an earlier one and applies the `baseline` section of the thresholds. A scheduled job keeps the last good run as an artifact and passes it the next night. A baseline from a different recording is refused unless `--baseline-any-recording` is given. `rp compare a.json b.json` prints two runs side by side and exits 0 whatever the verdicts.

### Long runs

A run that streams to the sidecar writes `<out>.checkpoint.json` every 1000 acknowledgements and when a signal stops it, and removes it when it finishes. `--resume` with the same recording and options continues from it. It refuses a different recording or any option that shapes the results, and it cannot write a candidate recording or judge the invariants. The exchanges after the checkpoint are sent again, so a stateful candidate sees them twice unless it is reset first. Use `--exchanges-sidecar` explicitly for a job you may need to resume, because below 50000 results the sidecar is off by default.

`--progress` prints a progress line to standard error. `--heartbeat-ms` (default 60000) repeats the line when nothing completed, so a CI log shows that the job is alive. `--log-format json` writes one object per line, and `--metrics-port` serves Prometheus metrics for the length of the run. `docs/observability.md` describes them.

### Output and gating

```sh
rp replay --profile nightly --target "$CANDIDATE_URL" --out out/run.json
code=$?
rp report --run out/run.json --format junit --out out/junit.xml
rp report --run out/run.json --format markdown --out out/summary.md
rp report --run out/run.json --out out/report.html
exit $code
```

`rp report` exits 0 after a render whatever the verdict. With `--fail-on-verdict` it exits with the run's own code after the output is written, 0 for pass, 2 for fail, and 3 for inconclusive. Write the Markdown to `$GITHUB_STEP_SUMMARY` for a job summary. `docs/ci.md` describes this repository's own pipeline.

## Reading an inconclusive run

An inconclusive run means the harness could not decide. The report lists each condition with its kind and detail, and `docs/report-format.md` gives the precedence rule. A run level condition makes the run inconclusive even when mismatches were seen, because those may be artifacts. The seven kinds are in `packages/core/src/run/verdict.ts`.

| Kind                   | Run level | What to change                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `barrier_timeout`      | yes       | The detail names the barrier exchange and the earlier exchanges it waited for. Find out why those were slow, then raise `--barrier-timeout-ms` (default 10000) if the wait is legitimate. The request timeout `--timeout-ms` (default 30000) is longer than the barrier timeout, so a candidate that never answers an earlier exchange trips the barrier first. |
| `snapshot_before_ack`  | yes       | The invariants found a snapshot read sent while an accepted command was still in flight. Add the snapshot read's tag to `--barrier-tag` so it waits for every earlier acknowledgement, as the demo does for `list-ledger`.                                                                                                                                      |
| `schedule_not_held`    | yes       | The largest schedule slip passed `pacing.slip_max_ms`. A slip is the actual send time minus the scheduled one. Raise `--concurrency`, lower the rate with `--rps` or a `--speed` below 1, check the load on the machine running `rp`, or raise the limit.                                                                                                       |
| `control_failed`       | yes       | A harness control, such as a restart, errored or answered another status than the recording. Check that the candidate serves the control. If it cannot, remove the tag from `controls.tags` in the rules.                                                                                                                                                       |
| `aborted`              | yes       | A SIGINT or SIGTERM stopped the run. The detail says how many of the selected exchanges were sent. If the run used the sidecar, `--resume` continues it. Otherwise raise the scheduler's time limit and run again.                                                                                                                                              |
| `insufficient_samples` | no        | A row had fewer successful samples than `min_samples`, or a tag had none, in this run or in the baseline. Lower `min_samples` for that tag, capture more traffic for it, drop the row, or set `inconclusive.max_rows` so a few rare tags do not stop the run. The budget tolerates only this kind and does not apply when any row failed.                       |
| `not_measured`         | no        | A row needs a measurement the run did not take. The common case is `correctness.noise_rate_max` without `--reference-target`: add the flag or remove the key. A `status` row on a run written before candidate statuses were recorded is the other case. The budget never tolerates this kind.                                                                  |

A condition with `tolerated: true` is listed for information and does not change the verdict. `docs/thresholds.md` lists when each row is inconclusive.

## Exit codes a scheduler should expect

| Command                                                                          | 0                                                              | 1                                                             | 2                                                                        | 3                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `rp replay`                                                                      | pass                                                           | tool error, including a failed preflight                      | fail                                                                     | inconclusive, including a stop by signal                                  |
| `rp invariants`                                                                  | every rule holds or has nothing to check                       | tool error                                                    | a rule is violated, unless the module reported an inconclusive condition | a rule could not decide, or the module reported an inconclusive condition |
| `rp report`                                                                      | a successful render, or with `--fail-on-verdict` a pass        | tool error                                                    | with the flag, fail                                                      | with the flag, inconclusive                                               |
| `rp shrink`                                                                      | finished                                                       | tool error                                                    | not used                                                                 | stopped by a signal, with the best reduction so far written               |
| `rp agent`                                                                       | finished, or no `ANTHROPIC_API_KEY`                            | tool error                                                    | not used                                                                 | stopped by a signal                                                       |
| `rp capture`                                                                     | stopped by a signal or by `--max-exchanges` or `--duration`    | tool error                                                    | not used                                                                 | not used                                                                  |
| `rp validate`                                                                    | every check is `ok` or `warn`                                  | any `error` check                                             | not used                                                                 | not used                                                                  |
| `rp doctor`                                                                      | printed                                                        | the config file could not be read                             | not used                                                                 | not used                                                                  |
| `rp compare`                                                                     | compared, whatever the verdicts                                | tool error                                                    | not used                                                                 | not used                                                                  |
| `rp recording` subcommands, `rp rules lint`, `rp rules suggest`, `rp import har` | done; `recording scan` always; `rules lint` also with warnings | an invalid recording, an unloadable rules file, or a bad flag | not used                                                                 | not used                                                                  |

A second SIGINT or SIGTERM exits at once with 130 and writes nothing more. A scheduler can treat 2 as a regression to look at, 3 as a run to read before it decides, and 1 as a broken job. Exit code 1 carries no verdict.

## What to attach to a ticket

- The output of `rp doctor` run with the same `--config`, `--profile`, and URLs as the job. It prints the version, Node version, platform, the layers in effect with their sources, and a probe of each URL. `${TOKEN}` prints as written, never resolved.
- The run file. If the run used the sidecar, attach `<out>.exchanges.jsonl` as well, and the checkpoint if the run was stopped. The run names its recording by hash in `recording.recording_sha256`, so the ticket does not need the recording to say which one it was.
- The HTML report, rendered with `rp report --run run.json --out report.html`. It is one file with no script and no external resource.
- The log of the job. With `--log-format json` it is one object per line, and header values never reach it.

Check the run file and the report before sharing them. They carry the body values of every mismatching field. `SECURITY.md` says how to treat them.
