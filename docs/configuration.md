# Configuration

Every setting of `rp` is a flag, and every flag can also come from a file, a profile in that file, or an environment variable. This page describes the file, the profiles, the variables, the order they are applied in, how secrets are kept out of the file and the run, and the three commands that check a setup before anything is sent: `rp validate`, the preflight inside `rp replay` and `rp shrink`, and `rp doctor`. `examples/rp.yaml` lists every key with a comment, and `demo/rp.yaml` is the file the demo runs with.

## The file

`rp` reads one YAML file, chosen in this order: the path given with `--config <path>`, else the path in `RP_CONFIG`, else `./rp.yaml` in the working directory when it exists. Without any of the three, nothing is read and the command behaves exactly as it did before the file existed. A path given with `--config` or `RP_CONFIG` must exist.

The file has one section per command, named after the command: `capture`, `replay`, `report`, `invariants`, `shrink`, `agent`, `validate`, and `doctor`. Under a section, every long flag of that command is a key, spelled as on the command line without the leading dashes. `--max-gap-ms 30000` becomes `max-gap-ms: 30000`, `--barrier-tag list-ledger` becomes `barrier-tag: [list-ledger]`, and `--header 'x-env: staging'` becomes `header: ['x-env: staging']`. The only flags that cannot be keys are `--config` and `--profile`, because they choose the file.

```yaml
replay:
  recording: recordings/reference.jsonl
  pace: as-recorded
  concurrency: 8
  thresholds: thresholds.yaml
  barrier-tag: [list-ledger]
  invariants: true
report:
  format: markdown
```

Values follow the flag. A flag that takes a value takes a string or a number. A repeatable flag takes a list, and the list replaces whatever a lower layer set, it does not extend it. A switch such as `--invariants` or `--quiet` takes `true` or `false`, and `true` means the flag is given, so `false` leaves the default in place. A negated flag keeps its spelling: `no-append: true` is the same as passing `--no-append`, and `no-preflight: true` skips the preflight. `--explain` takes `true` for every mismatched exchange or an exchange id for one. A value with a choice list or a number parser goes through the same parser the command line uses, so `pace: slow` fails with the allowed choices and `concurrency: lots` fails with `expected a positive integer`.

Quote a list element that holds a colon followed by a space. In a YAML flow list `[a: 1]` is a one key mapping, so a header is written `header: ['authorization: Bearer x']` or as a block list with one quoted line per header.

Relative paths in the file are relative to the working directory, as on the command line, not to the file. The demo runs from the repository root and names `demo/out/recording.jsonl`.

The file is validated when it is read. An unknown section, an unknown key under a section, a value of the wrong type, and a value its flag's parser rejects are each reported with the path of the key, such as `rp.yaml: unknown key "targt" at replay` or `rp.yaml: expected true or false at replay.invariants`, and the command exits 1 before it does anything else. Only the running command's section goes through the flag parsers; `rp validate --config` runs every section through its command's parsers.

## Profiles

`profiles.<name>` holds the same sections as the top level. A profile is applied over the top level when `--profile <name>` names it or, without the flag, when `RP_PROFILE` does. A key in the profile replaces the key at the top level, a key absent from the profile keeps its top level value, and a list in the profile replaces the list at the top level.

```yaml
replay:
  rules: diff-rules.yaml
  thresholds: thresholds.yaml
profiles:
  unordered:
    replay:
      rules: diff-rules-unordered.yaml
  nightly:
    replay:
      pace: fixed-rate
      rps: 200
      limit: 50000
```

Selecting a profile that the file does not define is an error naming the profiles the file has, and selecting a profile when no file was found is an error too.

## Environment variables

Every key can also be set by a variable named `RP_<COMMAND>_<FLAG>` in upper case with dashes turned into underscores: `RP_REPLAY_TARGET`, `RP_REPLAY_MAX_GAP_MS`, `RP_CAPTURE_NO_APPEND`. The variable applies to that one command. A switch takes `true` or `false`. A repeatable flag takes a comma separated list, `RP_REPLAY_BARRIER_TAG=list-ledger,list-inventory`, which replaces the list from the file. A value with a comma in it, such as a header with several values, cannot be given this way and belongs in the file or on the command line.

Two variables choose the configuration itself: `RP_CONFIG` names the file and `RP_PROFILE` names the profile. `rp doctor` lists the variables that applied and any `RP_` variable that matched no flag, which is how a misspelled one is found.

## Precedence

Four layers, lowest to highest:

1. The top level of the file.
2. The selected profile.
3. `RP_<COMMAND>_<FLAG>` variables.
4. Flags on the command line.

A layer that sets a key replaces the value from the layers below it, lists included. A repeated flag on the command line therefore replaces a list from the file rather than adding to it. A required flag such as `--target` is satisfied by any layer. When no file, profile, or variable is present, every command behaves exactly as it did without configuration support.

The layers are merged once and applied to the command's options before the command line is parsed, so the parsers, the choice lists, and the required flag checks of commander see configured values the same way they see typed ones.

## Secrets through interpolation

Any string value from the file, a profile, or a variable may hold `${NAME}`. It is replaced with the value of the environment variable `NAME` when the command runs. `$$` is a literal dollar sign. A missing variable is an error naming the variable and the key it was used in, such as `environment variable TOKEN is not set (used in rp.yaml: replay.header)`, and nothing is sent.

```yaml
replay:
  target: ${CANDIDATE_URL}
  header:
    - 'authorization: Bearer ${TOKEN}'
  query:
    - 'api_key=${API_KEY}'
```

On the command line, the flags that carry secrets are interpolated too: `--header`, `--headers-file`, `--target`, `--reference`, `--reset`, `--bus-url`, and `--query`. The lines of a `--headers-file` are interpolated as well, so the file can hold `authorization: Bearer ${TOKEN}` instead of the token.

The resolved values are used for the request and never stored. A header set this way reaches the candidate, and the run file and the candidate recording hold the redaction marker for a redacted header name and the recorded value otherwise, never the resolved one. The run records the target URL as resolved, because the report has to say what was replayed, so keep secrets in headers and query parameters rather than in the URL. `rp doctor` and the probe lines of `rp validate` print `${NAME}` as written, never the resolved text.

`--query <name=value>`, on `rp replay` and `rp shrink`, sets a query parameter on every request over the recorded value. The capture proxy records query parameters on its redaction list as `<redacted>`, and the engine drops a recorded parameter whose value is the marker before it sends, so a recorded `api_key` is sent only when `--query api_key=${API_KEY}` supplies it.

## rp validate

```sh
rp validate --recording demo/recording.jsonl --rules demo/diff-rules.yaml \
  --thresholds demo/thresholds.yaml --barrier-tag list-ledger \
  --target http://127.0.0.1:3001 --reset http://127.0.0.1:3001/admin/reset
```

The command parses every file given and checks that they agree with the recording. It prints one line per check, each starting with `ok`, `warn`, or `error`, and exits 0 with only `ok` and `warn` lines, 1 with any `error`.

| Check        | Condition                                                                                                               | Level |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ----- |
| `config`     | The config file in effect parses, and every section passes its command's flag parsers.                                  | error |
| `recording`  | The recording parses. The line reports the exchange and tag counts.                                                     | error |
| `thresholds` | The file parses, and every tag named in `latency.by_tag` and `correctness.by_tag` exists in the recording.              | error |
| `rules`      | The file parses.                                                                                                        | error |
| `rules`      | Every substitution's capture tag names at least one exchange whose response has a string or number at the capture path. | error |
| `rules`      | Every control tag names at least one exchange.                                                                          | warn  |
| `rules`      | Every ignore, tolerance, and unordered path matches at least one response body.                                         | warn  |
| `barrier`    | Every `--barrier-tag` exists in the recording.                                                                          | error |
| `target`     | A GET on the URL's path, or on `/healthz` when the path is empty, answers within 5 seconds with any status under 500.   | error |
| `reference`  | The same probe as `target`.                                                                                             | error |
| `reset`      | A POST answers within 5 seconds with a 2xx status.                                                                      | error |

The rules checks catch the two mistakes that otherwise surface late: a thresholds tag that does not exist produces an inconclusive row at the end of a long replay, and a substitution whose producer never answers with the captured value makes every later request mismatch on the id.

## The preflight

`rp replay` and `rp shrink` run the same checks before anything is sent: the thresholds (replay only), the rules, and the barrier tags against the recording. Warnings are printed to stderr with a `preflight:` prefix. An error prints the same way, followed by a line saying nothing was sent, and the command exits 1 without writing a run file. The URL probes are off by default and `--preflight-probe` turns them on: the target for `rp replay`, the target and the reset URL for `rp shrink`. `--no-preflight` skips every check, which is the way to replay a recording that legitimately lacks a tag the thresholds name, in which case the row is reported as inconclusive as before.

## rp doctor

```sh
rp doctor --config demo/rp.yaml --profile strict --target http://127.0.0.1:3001
```

The command prints what a support request needs: the `rp` version, the Node version, the platform, the config file in effect and where it came from, the profile in effect and where it came from, every effective value per command with its source (`file`, `profile <name>`, or the variable's name), the `RP_` variables that applied, any `RP_` variable that matched no flag, and, when `--target`, `--reference`, or `--reset` is given, the probe line for each. Values are printed as written in the file, so `${TOKEN}` stays `${TOKEN}`. The command exits 0, or 1 when the config file could not be read. A `${NAME}` the doctor's own section needs but the environment lacks is printed as an `error config` line and does not change the exit code.
