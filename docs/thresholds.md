# Thresholds

`rp replay --thresholds thresholds.yaml` turns the run's statistics into rows, and the rows into a verdict. This page lists every key of the file, the row each key produces, when a row is inconclusive, and how baselines, noise, and the inconclusive budget change the verdict. `examples/thresholds.yaml` carries every key with a comment. The run file format, including the row fields, is in docs/report-format.md.

## How a row decides

Each configured limit produces one row with an `id`, a `section`, a `scope` (`overall`, a tag, or a system), a `metric`, the `limit`, the `measured` value or null, and an `outcome`:

- `pass`: the measured value is within the limit.
- `fail`: it is not. A ratio whose denominator is zero while the numerator is not also fails, with the detail `reference value is zero` or `baseline value is zero`, since that is a fact about the data.
- `inconclusive`: the row could not decide. Each inconclusive row adds a condition to the run's `inconclusive` list, named `<row id>: <detail>`, with the kind `insufficient_samples` when the row lacked samples, `not_measured` when the run did not take a measurement the row needs, or `schedule_not_held` for the pacing row.

The verdict follows one precedence rule. A run level condition (a barrier timeout, a snapshot read before an acknowledgement, a schedule that was not held, a failed harness control, an aborted run) makes the run inconclusive. Otherwise a failed row or an invariant violation makes it fail. Otherwise an inconclusive row makes it inconclusive, unless the inconclusive budget tolerated it. Otherwise it passes.

Rows appear in the order of this page: latency, relative to reference, correctness, errors, throughput, status, baseline, pacing, invariants. Within a section the overall row comes first and the per tag rows follow in tag order. A key left out of the file produces no row, and a file that uses none of the newer keys produces exactly the rows it produced before them.

## Every key

| Key                                                               | Row id                                                          | Section       | Measured                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `latency.min_samples`                                             | none                                                            |               | Successful candidate samples a latency row needs. Default 1.                                              |
| `latency.overall.<metric>_ms`                                     | `latency.overall.<metric>_ms`                                   | `latency`     | The candidate's percentile in milliseconds over every counted exchange.                                   |
| `latency.by_tag.<tag>.<metric>_ms`                                | `latency.by_tag.<tag>.<metric>_ms`                              | `latency`     | The same over the tag's exchanges.                                                                        |
| `latency.overall.min_samples`, `latency.by_tag.<tag>.min_samples` | none                                                            |               | Overrides `latency.min_samples` for that block and its ratio rows.                                        |
| `latency.relative_to_reference.<metric>_ratio_max`                | `latency.relative_to_reference.<metric>_ratio_max`              | `latency`     | Candidate percentile over the reference's, from the recording.                                            |
| `latency.relative_to_reference.by_tag.<tag>.<metric>_ratio_max`   | `latency.relative_to_reference.by_tag.<tag>.<metric>_ratio_max` | `latency`     | The same ratio over the tag's exchanges.                                                                  |
| `correctness.mismatch_rate_max`                                   | `correctness.mismatch_rate_max`                                 | `correctness` | Mismatched exchanges over compared exchanges.                                                             |
| `correctness.by_tag.<tag>.mismatch_rate_max`                      | `correctness.by_tag.<tag>.mismatch_rate_max`                    | `correctness` | The same over the tag's exchanges.                                                                        |
| `correctness.noise_rate_max`                                      | `correctness.noise_rate_max`                                    | `correctness` | Noise findings over compared exchanges. See "Noise" below.                                                |
| `errors.rate_max`                                                 | `errors.rate_max`                                               | `errors`      | Exchanges with a transport error over counted exchanges.                                                  |
| `errors.by_tag.<tag>.rate_max`                                    | `errors.by_tag.<tag>.rate_max`                                  | `errors`      | The same over the tag's exchanges.                                                                        |
| `throughput.achieved_rps_min`                                     | `throughput.achieved_rps_min`                                   | `throughput`  | `pacing.achieved_rps`. A lower bound: the row passes at or above the limit.                               |
| `status.by_tag.<tag>.'<code>'.rate_max`                           | `status.by_tag.<tag>.<code>.rate_max`                           | `status`      | The tag's compared exchanges whose candidate answered the code, over all of the tag's compared exchanges. |
| `baseline.latency.overall.<metric>_ratio_max`                     | `baseline.latency.overall.<metric>_ratio_max`                   | `baseline`    | This run's candidate percentile over the baseline's.                                                      |
| `baseline.latency.by_tag.<tag>.<metric>_ratio_max`                | `baseline.latency.by_tag.<tag>.<metric>_ratio_max`              | `baseline`    | The same over the tag's exchanges.                                                                        |
| `baseline.correctness.mismatch_rate_delta_max`                    | `baseline.correctness.mismatch_rate_delta_max`                  | `baseline`    | This run's mismatch rate minus the baseline's.                                                            |
| `baseline.correctness.by_tag.<tag>.mismatch_rate_delta_max`       | `baseline.correctness.by_tag.<tag>.mismatch_rate_delta_max`     | `baseline`    | The same over the tag's exchanges.                                                                        |
| `baseline.errors.rate_delta_max`                                  | `baseline.errors.rate_delta_max`                                | `baseline`    | This run's error rate minus the baseline's.                                                               |
| `pacing.slip_max_ms`                                              | `pacing.slip_max_ms`                                            | `pacing`      | The largest schedule slip. Above the limit the run is inconclusive, not failed.                           |
| `invariants.fail_on_violation`                                    | `invariants.<system>.violations`                                | `invariants`  | Violations per system, with `--invariants`. False reports without gating.                                 |
| `inconclusive.max_rows`                                           | none                                                            |               | The inconclusive budget. See below.                                                                       |

`<metric>` is one of `p50`, `p90`, `p99`, `p999`, `max`, and `mean`. Rates and deltas are fractions from 0 to 1. A status code is quoted in YAML, as in `'404'`, and must lie from 100 to 599. Unknown keys are refused with the path to the key.

## When a row is inconclusive

| Row                            | Inconclusive when                                                                                                   | Kind                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| latency, relative to reference | The tag has no samples, or fewer successful candidate samples than its minimum, or the reference has none.          | `insufficient_samples` |
| correctness mismatch rate      | The tag has no samples, or nothing was compared.                                                                    | `insufficient_samples` |
| `correctness.noise_rate_max`   | Nothing was compared.                                                                                               | `insufficient_samples` |
| `correctness.noise_rate_max`   | The run did not use `--reference-target`, so noise was not measured.                                                | `not_measured`         |
| errors                         | The tag has no samples, or the run counted no exchange.                                                             | `insufficient_samples` |
| `throughput.achieved_rps_min`  | The run counted no exchange.                                                                                        | `insufficient_samples` |
| `throughput.achieved_rps_min`  | The achieved rate was not passed to the evaluation, which only a library caller can cause.                          | `not_measured`         |
| status                         | The tag has no samples, or none of its exchanges was compared.                                                      | `insufficient_samples` |
| status                         | The statistics carry no candidate statuses, as in a run written before they existed.                                | `not_measured`         |
| baseline latency               | This run or the baseline lacks the tag, or either has fewer successful candidate samples than the minimum.          | `insufficient_samples` |
| baseline deltas                | This run or the baseline lacks the tag, or either compared nothing (mismatch rate) or counted nothing (error rate). | `insufficient_samples` |
| `pacing.slip_max_ms`           | The slip exceeded the limit, or was not measured.                                                                   | `schedule_not_held`    |

The detail names which side fell short, as in `the baseline has 4 successful samples, minimum 20` or `the baseline has no samples for tag "get-order"`. This run's shortfall is named before the baseline's.

## Baselines

`rp replay --baseline <run.json>` compares the run with an earlier one, such as last night's run of the same recording. The baseline file may be at any schema version `rp` reads; it is migrated like any other run file. The `baseline` section of the thresholds then gates this run against the baseline's statistics:

```yaml
baseline:
  latency:
    overall: { p99_ratio_max: 1.2 }
    by_tag:
      get-order: { p99_ratio_max: 1.25, p50_ratio_max: 1.25 }
  correctness:
    mismatch_rate_delta_max: 0
    by_tag:
      create-order: { mismatch_rate_delta_max: 0 }
  errors: { rate_delta_max: 0.001 }
```

A latency row divides this run's candidate percentile by the baseline's candidate percentile, so `p99_ratio_max: 1.25` fails when p99 grew by more than a quarter. A delta row subtracts the baseline's rate from this run's, so `mismatch_rate_delta_max: 0` fails when the mismatch rate grew at all, even when it stays under `correctness.mismatch_rate_max`. The baseline latency rows use the same `min_samples` as the plain latency rows, applied to both runs. The row detail gives both values, as in `14.2 ms now, 11.0 ms in the baseline`.

The run records the baseline as `baseline: { path, run_id, recording_sha256 }`, and every report names it.

Recording check. A run records the SHA-256 of the recording it replayed. A baseline whose hash differs from the hash of the recording being replayed now is refused before anything is sent, with an error that names both hashes, because percentiles and rates over different traffic do not compare. `--baseline-any-recording` compares them anyway and logs a warning. A baseline that records no hash cannot be checked; `rp replay` logs a warning and compares.

Without `--baseline`, the `baseline` section produces no rows, and `rp replay` logs a warning that the baseline rows were not evaluated. One thresholds file can therefore serve a nightly job that passes the previous night's run and a pull request job that does not. `--baseline-any-recording` without `--baseline` is a usage error.

`rp compare <run-a.json> <run-b.json>` prints two runs side by side without gating: the threshold rows of both, the top mismatching paths that appeared or disappeared, the candidate p50 and p99 per tag with b minus a, and the compared, mismatch, error, and noise counts. `--format terminal`, `markdown`, or `json`. It exits 0 whatever the verdicts.

## Noise

With `--reference-target`, every exchange is also replayed against the reference, and a path where the reference differs from its own recording is noise (see "Reference re-replay" in docs/report-format.md). A finding at a noise path is tolerated with the rule `noise:reference` and `noise: true`, and the exchange's verdict is computed again without it. The statistics count an exchange as mismatched only when it holds an untolerated finding, so a noise finding never reaches a mismatch rate: an exchange whose only differences are noise is tolerated, and one with noise and a real difference is still a mismatch.

In such a run every mismatch rate row says how much noise it excluded, as in `12 noise findings excluded`, over the row's scope. A run without the re-replay keeps its rows exactly as before.

`correctness.noise_rate_max` gates the noise itself: noise findings per compared exchange, overall. A reference that has become unstable, through a deploy or a clock problem, excuses more and more of the candidate's differences; this row fails the run before that hides a real regression. One exchange can hold several noise findings, so the measured value can exceed 1 and the limit is any number from 0 up. Without `--reference-target` the row is inconclusive with the kind `not_measured`.

## The inconclusive budget

```yaml
inconclusive: { max_rows: 2 }
```

A row that lacks samples makes the whole run inconclusive, which is right for a small demo and too strict for a nightly job over hundreds of tags, where a few rarely used tags never reach their minimum. With a budget, a run where no row failed and at most `max_rows` rows are inconclusive, each for lack of samples, passes.

The tolerated rows keep their `inconclusive` outcome. Their conditions stay in the run's `inconclusive` list with `tolerated: true`, and the reports list them under "Tolerated by the inconclusive budget", apart from any condition that makes the run inconclusive, and mark each row `inconclusive (tolerated)`. In JUnit the row's skipped message starts with `tolerated by the inconclusive budget:`.

The budget does not apply when:

- any row failed, since the run fails anyway and every condition is shown as it is;
- more than `max_rows` rows lack samples, in which case none is tolerated;
- an inconclusive row has any other kind: a row that needs a measurement the run did not take (`not_measured`) or a schedule that was not held is never tolerated, and its presence leaves every condition untolerated.

Run level conditions are never budgeted. A barrier timeout, a snapshot read before an acknowledgement, a schedule that was not held, a failed harness control, and an aborted run keep the run inconclusive whatever the budget, and conditions the invariants report are added outside the budget too. `max_rows: 0` tolerates nothing; leaving the key out means no budget.
