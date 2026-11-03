# Observability

This page covers what `rp` writes while it runs: the structured log, the progress line and its heartbeat, the trace header sent to the candidate, and the Prometheus endpoint. None of it changes a run file or an exit code.

## The logger

Every line `rp` writes to standard error goes through one logger. The report, the verdict table, and other command output stay on standard output and are not logged.

Two global options choose how it writes, and both come before or after the command name:

| Option             | Variable        | Values                           | Default |
| ------------------ | --------------- | -------------------------------- | ------- |
| `--log-level <l>`  | `RP_LOG_LEVEL`  | `debug`, `info`, `warn`, `error` | `info`  |
| `--log-format <f>` | `RP_LOG_FORMAT` | `text`, `json`                   | `text`  |

A flag wins over the variable. A bad value exits 1 before anything runs. The two options are global, so they are not keys in `rp.yaml`; set the variables instead.

The `text` format writes the message alone, which is the line the commands printed before the logger existed. At `info` the output is byte for byte what it was.

The `json` format writes one object per line:

```json
{
  "ts": "2026-10-27T12:00:00.000Z",
  "level": "info",
  "msg": "wrote run.json: FAIL",
  "command": "replay",
  "out": "run.json",
  "verdict": "fail",
  "run_id": "01J..."
}
```

`ts`, `level`, and `msg` come first, then `command`, then the fields of the line. A field can never replace the first three. An `Error` is written as `{name, message}`, so a stack never reaches a log. Usage errors from the argument parser are written as `error` records too, so a collector never sees a bare line.

Header values never reach a log line. A line can name a header, never its value.

In code, `createLogger({ level, format, sink })` from `@replay-parity/core` builds a logger. The `Logger` interface has `level`, `format`, `enabled(level)`, `debug`, `info`, `warn`, `error` (each `(msg, fields?)`), and `child(fields)`, which returns a logger with the fields bound to every line. `noopLogger` writes nothing and is the default wherever a logger is optional.

## Where each command logs

| Command   | What it logs                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `capture` | the listen address, each proxy error at `error` with its `context` field, and the closing counts (`seen`, `recorded`, `failed`)         |
| `replay`  | preflight findings, the trace id, the metrics address, dependency exchanges selected, capped gaps, an aborted run, and the verdict line |
| `shrink`  | a hash mismatch warning, preflight findings, each attempt (`attempt`, `phase`, `steps`, `reproduced`), and the result                   |
| `agent`   | its own log lines through the agent's `log` hook, at `info`                                                                             |

`ReplayOptions.log` and `ReplayContext.log` carry the logger into the engine and the adapter. Every line a command writes carries a `command` field.

## Progress and heartbeat

`rp replay`, `rp capture`, and `rp shrink` take three options, and each is also a key in `rp.yaml`:

- `--progress` prints a progress line to standard error.
- `--progress-every <n>` sets the units between lines, default 100. A line is also printed at the next update after one second without one.
- `--heartbeat-ms <n>` prints the line again after this long without one, default 60000, `0` disables.

The line reads:

```text
replay 1200/5000 errors 3 mismatches 11 inflight 8 412.0 rps elapsed 2s eta 9s
capture seen 120 recorded 118 failed 2 elapsed 40s
shrink 14 attempts, best 6 steps, elapsed 1m2s
```

On a TTY the line is redrawn in place with a carriage return, and a log line ends it first. Off a TTY every print is a new line, and the heartbeat repeats the line when nothing completed, so a CI log shows the job is alive during a long wait. With `--log-format json` every print is an `info` record with `progress: true` and the counters as fields.

The replay estimate is the later of two times: what the recorded schedule still holds, and what the achieved rate predicts for the exchanges left.

## The trace header

`rp replay --trace`, or `RP_TRACE=1`, generates one 32 hex character trace id for the run and logs it once at `info`. The HTTP adapter then sends

```text
traceparent: 00-<trace id>-<span id>-01
```

on every request, replacing a recorded `traceparent`. The span id is 16 hex characters derived from the exchange id (the start of its SHA-256), so a rerun of the same recording gives every exchange the same span id under a new trace id. With the JSON format every record of the run carries `trace_id`. Only the HTTP adapter sends the header.

This is W3C trace context without an OpenTelemetry dependency. Exporting spans over OTLP is the next step; today the header lets the candidate's own tracing join its spans to the run.

## The metrics endpoint

`rp replay --metrics-port <n>` serves `GET /metrics` in the Prometheus text format on every interface until the run ends, then closes. Port `0` picks a free one and the chosen address is logged. Any other path answers 404.

| Metric                          | Type      | Meaning                                              |
| ------------------------------- | --------- | ---------------------------------------------------- |
| `rp_exchanges_sent_total`       | counter   | exchanges completed against the candidate            |
| `rp_exchanges_acked_total`      | counter   | exchanges the candidate answered                     |
| `rp_exchanges_errors_total`     | counter   | exchanges that failed to send, timed out, or aborted |
| `rp_exchanges_mismatches_total` | counter   | exchanges whose response differed under the rules    |
| `rp_inflight`                   | gauge     | exchanges sent and not yet acknowledged              |
| `rp_candidate_latency_ms`       | histogram | candidate latency, in the log spaced bins of the run |

The histogram buckets use the same edges as the run file's latency histograms. A Prometheus job scrapes it like any other target:

```yaml
scrape_configs:
  - job_name: rp-replay
    static_configs:
      - targets: ['ci-runner:9464']
```

## Piping JSON logs to a collector

Standard error carries the logs and standard output carries results, so the log stream can go straight to a shipper:

```sh
rp --log-format json replay --recording r.jsonl --target "$URL" --progress 2> >(vector --config vector.toml)
```

Every line is one JSON object, so a shipper that reads newline delimited JSON needs no parsing rules. Filter on `command`, `level`, or `progress`. Set `RP_LOG_FORMAT=json` in a CI job to get the same without editing each command line.
