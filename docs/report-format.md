# The run file

`rp replay` writes `run.json`. It is the canonical report. `rp report` renders HTML and the terminal summary from it, `rp shrink` and `rp agent` add their sections to it in place, and `rp report --format json` validates it and prints it again. The JSON Schema, draft 2020-12, is generated from the zod definitions in `packages/core/src/run/schema.ts` and committed at `packages/core/schema/run.schema.json`. A test fails when the two drift apart.

## Top level

| Field                 | Type                           | Meaning                                                                                    |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `schema_version`      | `1`                            | Bumped on an incompatible change.                                                          |
| `run_id`              | ULID                           | Unique per run.                                                                            |
| `created_at`          | ISO 8601                       | When the run was written.                                                                  |
| `verdict`             | `pass`, `fail`, `inconclusive` | The outcome, by the precedence rule below.                                                 |
| `inconclusive`        | array                          | Why the run is inconclusive. Empty otherwise. Each entry has `kind` and `detail`.          |
| `recording`           | object                         | `path`, `exchanges` in the file, `selected` after filter and limit, `first_ts`, `last_ts`. |
| `target`              | string                         | The candidate's base URL.                                                                  |
| `adapter`             | string                         | `http` or `bus`.                                                                           |
| `pacing`              | object                         | See below.                                                                                 |
| `warmup`              | integer                        | Leading exchanges that ran but did not count.                                              |
| `filter`              | object                         | `tag` or null.                                                                             |
| `limit`               | integer or null                | The cap applied after filtering.                                                           |
| `duration_ms`         | number                         | From the first send to the last acknowledgement.                                           |
| `rules`               | object                         | The diff rules that were applied, in full.                                                 |
| `thresholds`          | object                         | The thresholds that were applied, in full.                                                 |
| `threshold_results`   | array                          | One row per configured limit. See below.                                                   |
| `stats`               | object                         | Latency and correctness statistics overall and per tag. See below.                         |
| `exchanges`           | array                          | One result per selected exchange. See below.                                               |
| `candidate_recording` | string or null                 | Path of the candidate's observed log when `--candidate-recording` was given.               |
| `invariants`          | object                         | `reference` and `candidate`, each an invariant report or null.                             |
| `reproduction`        | object or null                 | Filled by `rp shrink`.                                                                     |
| `agent`               | object                         | Present after `rp agent`.                                                                  |

## Verdict and inconclusive kinds

The precedence rule: a run level condition makes the run inconclusive even when mismatches were observed. Otherwise any failed threshold row makes it fail. Otherwise any insufficient sample row makes it inconclusive. Otherwise it passes.

| Kind                   | Run level | Set when                                                                                                                                      |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `barrier_timeout`      | yes       | An exchange with a barrier tag waited longer than `--barrier-timeout-ms` for earlier exchanges.                                               |
| `snapshot_before_ack`  | yes       | The final ledger read was sent while an accepted state changing command was still in flight. Reported by the invariants.                      |
| `schedule_not_held`    | yes       | The largest schedule slip exceeded `pacing.slip_max_ms`.                                                                                      |
| `control_failed`       | yes       | A harness control errored or answered a different status.                                                                                     |
| `insufficient_samples` | no        | A threshold row could not decide: fewer successful samples than `min_samples`, a tag with no samples, nothing compared, or no samples at all. |

## Pacing

| Field                        | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mode`                       | `as-recorded`, `fixed-rate`, or `max`.                                                                                     |
| `rps`                        | The requested rate under `fixed-rate`, else null.                                                                          |
| `concurrency`                | Most exchanges in flight at once.                                                                                          |
| `requested_rps`              | The rate the schedule asked for: the recording's own rate under `as-recorded`, `rps` under `fixed-rate`, null under `max`. |
| `achieved_rps`               | Selected exchanges divided by the duration.                                                                                |
| `slip_p50_ms`, `slip_max_ms` | Median and largest of actual send time minus scheduled send time, over non control exchanges.                              |
| `barrier_tags`               | The barrier tags in effect.                                                                                                |
| `barrier_timeout_ms`         | The timeout in effect.                                                                                                     |
| `barrier_waits`              | How many times a barrier found earlier exchanges still in flight.                                                          |

## Threshold rows

Each row has `id` (such as `latency.by_tag.create-order.p99_ms`), `section` (`latency`, `correctness`, `errors`, `pacing`, `invariants`), `scope` (`overall`, a tag, or a system), `metric`, `limit`, `measured` (a number or null), `outcome` (`pass`, `fail`, `inconclusive`), and an optional `detail` such as `3 successful samples, minimum 20`.

## Statistics

`stats.overall` and `stats.by_tag.<tag>` have the same shape: `count`, `errors`, `error_rate`, `compared`, `matches`, `tolerated`, `mismatches`, `mismatch_rate`, `candidate` and `reference` latency summaries (`count`, `p50_ms`, `p90_ms`, `p99_ms`, `p999_ms`, `max_ms`, `mean_ms`), and `histogram` with `candidate` and `reference` bin counts. `stats.histogram_edges_ms` holds the 49 edges of the 48 log spaced bins from 0.1 ms to 10 s, so the HTML renders the histograms without a library. Warmup and control exchanges are excluded. Reference latencies come from the recording.

## Exchange results

| Field                                          | Meaning                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`, `tags`, `method`, `path`                 | From the recording. The path is the recorded one, before substitution.                                             |
| `warmup`                                       | True for the leading warmup exchanges.                                                                             |
| `control`                                      | True for a harness control.                                                                                        |
| `scheduled_at_ms`, `sent_at_ms`, `acked_at_ms` | Milliseconds since the run started. `acked_at_ms` is null on an error.                                             |
| `reference`                                    | `status` and `latency_ms` from the recording.                                                                      |
| `candidate`                                    | `status` and `latency_ms` from the replay, or null on an error.                                                    |
| `error`                                        | `kind: message` on a transport failure, else null. Kinds: `timeout`, `connection`, `aborted`, `protocol`, `other`. |
| `diff`                                         | `verdict` (`match`, `tolerated`, `mismatch`) and `findings`, or null when not compared.                            |

A finding has `path` (a concrete JSONPath, `status`, or `header:<name>`), `kind` (`status`, `header`, `value`, `type`, `missing`, `unexpected`, `body_too_large`, `body_format`), `tolerated`, and optional `reference`, `candidate`, `rule`, and `detail`.

## Invariant reports

Each report has `system`, `recording`, `exchanges`, `commands`, `snapshots` (`ledger_reads`, `stock_reads`, `order_reads`), `results`, `violations`, and `inconclusive`. Each result has `id` (1 to 10), `name`, `statement`, `status` (`holds`, `violated`, `not_applicable`, `inconclusive`), `checks`, `evidence`, and an optional `detail`. Evidence entries have `subject`, `expected`, `observed`, `detail`, and `exchange_id`.

## Reproduction

`rule`, `original_steps`, `reduced_steps`, `attempts`, `successful`, `label` (`reduced reproduction` or `reduction unsuccessful`), `duration_ms`, `recording` (the reduced file or null), and `steps`, each with `id`, `method`, `path`, `tags`, optional `body`, and `quantity_reduced`.

## Agent

`model`, `rounds`, `max_rounds`, `budget_usd`, `cost_usd`, token counts (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`), `proposed`, `valid`, `executed`, `kept`, `stop_reason` (`no_new_cases`, `budget`, `max_rounds`, `no_valid_cases`, `model_refusal`, `error`), `prompt_versions`, `transcript_path`, `cases_path`, and `cases`. Each kept case has `id`, `round`, `hypothesis`, `tags`, `steps`, `dedupe_key`, `reference` and `candidate` (status and latency of the final step, or null), `error`, `diff`, `latency_breach`, and `revealed`.

## Exit codes

| Code | Meaning                                                 | Commands                     |
| ---- | ------------------------------------------------------- | ---------------------------- |
| 0    | pass, or a render, or the agent without a key           | all                          |
| 2    | fail                                                    | `rp replay`, `rp invariants` |
| 3    | inconclusive                                            | `rp replay`, `rp invariants` |
| 1    | tool error: bad flags, a missing file, a bad rules file | all                          |
