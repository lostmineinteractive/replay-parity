# Recording tools

`rp recording` holds the tools that work on a recording file without replaying it: validate, stats, filter, sample, split, merge, scan, migrate, and anonymize. Every subcommand reads its input one line at a time through the same streaming reader the replay engine uses, so a recording larger than memory is handled, and no subcommand alters its input. The one exception to streaming is `filter --include-dependencies`, which is explained below. Every subcommand has `--help`.

A recording is JSON Lines, one exchange per line, valid when every line parses and `offset_ms` never decreases. The first line may be a manifest that says which tool, target, tag rules, redaction, and sampling produced the file; every subcommand skips it when reading exchanges. `docs/capture.md` describes the manifest, lossless numbers, and the capture options, and `docs/report-format.md` describes the exchange shape under "Exchange results" and the body rules.

## Gzip

Every subcommand reads a path ending in `.gz` as gzip, a file of several gzip members included, so the parts `rp capture --gzip` writes work as they are. An output path ending in `.gz` is written as gzip, and `split` of a gzip input writes gzip parts named `recording-0001.jsonl.gz`. Nothing else about a subcommand changes. The recording hash of a gzip file is the hash of its compressed bytes on disk.

## The recording hash

`rp replay` hashes the recording file while it reads it and writes the SHA-256 of the file's bytes, newlines included, into the run as `recording.recording_sha256`. The hash is taken in a second streaming pass over the file alongside the read, in constant memory, so it costs one more read of the file and nothing else. It ties the run to the exact file it replayed: an edited, appended, filtered, or reordered file has a different hash.

`rp shrink` hashes the file given as `--recording` and refuses to run when the run has a hash and it differs, naming both hashes:

```
rp: other.jsonl is not the recording the run replayed: the run recorded sha256 7cda0686... and the file has 3f1a9c2e.... Pass --allow-recording-mismatch to shrink it anyway.
```

`--allow-recording-mismatch` turns the refusal into a warning on stderr and shrinks anyway, for the case where the file was moved through a tool that changed its bytes but not its content. A run with no hash is accepted with any file: the field is null when the engine was given exchanges in memory, and absent in a run written before the field existed.

`hashRecordingFile(path)` in `@replay-parity/core` returns the hash, the size in bytes, and the number of lines, and is what both commands use.

## validate

```sh
rp recording validate demo/recording.jsonl
```

Parses every line against the exchange schema, checks that `offset_ms` never decreases and that no id repeats, and prints the count of exchanges, the span of offsets, the manifest when the file has one, and the count per tag. A manifest anywhere but the first line, or one that does not match the manifest schema, is a problem with its line number. Exits 0 when the file is valid and 1 with the line number and the message of the first problem, along with how many exchanges were parsed before it.

```
demo/recording.jsonl: valid, 283 exchanges, offsets 0 to 12849 ms
  tags
    get-order        109
    list-inventory    53
    ...
```

## stats

```sh
rp recording stats demo/recording.jsonl --rules demo/diff-rules.yaml
rp recording stats demo/recording.jsonl --json
```

Prints the exchanges by tag, by method, and by status class, the body size percentiles (p50, p90, p99, max) of the stored request and response bodies over the exchanges that have one, the span of offsets, the largest gap between two consecutive exchanges with the id it follows, and, with `--rules`, one row per substitution rule saying how many exchanges produce a value for it and how many distinct values they produce. Body sizes are the stored sizes: a JSON body as serialized, a base64 body decoded, a truncated body by its recorded size. `--json` prints the same as one JSON object.

```
demo/recording.jsonl: 283 exchanges, 2026-10-16T20:50:45.469Z to 2026-10-16T20:50:58.318Z, offsets 0 to 12849 ms (span 12849 ms)
  largest gap 66 ms after 01M537PVVS6DRZBCTMCX7TKFJ0 (11546 to 11612 ms)
by tag
  get-order       109
  ...
substitution producers
  rule      tag           path        producers  distinct values
  order_id  create-order  $.order_id         47               44
```

## filter

```sh
rp recording filter demo/recording.jsonl --out orders.jsonl --tag create-order --tag get-order
rp recording filter demo/recording.jsonl --out slow.jsonl --method GET --path '/v1/orders/*' --status 2xx --from 1000 --to 9000
rp recording filter demo/recording.jsonl --out reads.jsonl --tag get-order --include-dependencies --rules demo/diff-rules.yaml
```

Keeps the matching exchanges in recording order. Each flag may repeat and matches any of its values: `--tag` by tag, `--method` by method without regard to case, `--path` by a glob over the path (`*` within one segment, `**` across segments, `?` one character), `--status` by a class such as `2xx` or a code such as `404`, and `--from` and `--to` by `offset_ms`, both inclusive. Different flags combine with and. The output has `offset_ms` rebased so the first kept exchange is at 0 and every gap between kept exchanges is kept, so `as-recorded` pacing replays it with its original rhythm. `ts` is left as recorded.

`--include-dependencies` also keeps the exchanges that produce the substituted values the kept exchanges use, transitively, using the substitution rules in `--rules`, in the same way `rp replay --filter` does. The producer of a value can sit anywhere before the exchange that uses it, so this flag reads the whole file into memory and builds the dependency index over it; without the flag the filter streams. The output line says how many exchanges were pulled in as producers.

## sample

```sh
rp recording sample demo/recording.jsonl --out tenth.jsonl --fraction 0.1 --seed 7
rp recording sample traffic.jsonl --out tenth.jsonl --fraction 0.1 --by-session x-session-id
rp recording sample traffic.jsonl --out tenth.jsonl --fraction 0.1 --by-session '$.user.id'
```

Keeps a random fraction of the exchanges. The same seed gives the same output; without `--seed` a seed is drawn and printed so the sample can be repeated. With `--by-session` the decision is made per session rather than per exchange: the selector is a request header name, or a JSONPath into the request body when it starts with `$`, and every exchange sharing the value is kept or dropped together, so a stateful sequence survives whole. The decision for a session is a hash of the seed and the value, so it is the same across runs and across files. An exchange without a session value is kept, so controls and health checks stay in the sample; the output line says how many sessions were seen and how many exchanges had no key. Offsets are rebased like `filter`.

## split and merge

```sh
rp recording split demo/recording.jsonl --out-dir parts --every 100
rp recording split demo/recording.jsonl --out-dir windows --every-ms 5000
rp recording merge --out merged.jsonl parts/recording-0001.jsonl parts/recording-0002.jsonl parts/recording-0003.jsonl
```

`split` writes consecutive parts into a directory, created when missing, named after the input with a four digit index: `recording-0001.jsonl`, `recording-0002.jsonl`, and so on. `--every <n>` puts that many exchanges in each part but the last. `--every-ms <n>` puts the exchanges of each window of that many milliseconds of recorded time, counted from the first exchange, in one part; a window with no exchange gets no file, and parts are still numbered in order. Each part is rebased to start at 0. One line per part on stderr says how many exchanges it holds and which recorded offsets they span.

`merge` reads any number of recordings and writes one, ordered by `ts`, with `offset_ms` recomputed from the first merged exchange. Two exchanges with the same `ts` keep the order of the inputs on the command line. Each input must be ordered by `ts`, which a capture always is, and no id may appear in two inputs; both are checked in a first pass over the inputs, so nothing is written when a check fails. The merge itself holds one exchange per input in memory plus the set of ids. Merging the parts of a split gives back the original file byte for byte.

## scan

```sh
rp recording scan demo/recording.jsonl
rp recording scan demo/recording.jsonl --json
```

Reports what in a recording looks like personal data, so an operator sees what a file holds before sharing it. It always exits 0; it is a report, not a gate. Values are never printed whole: each finding carries one example with the first and last two characters kept and the rest masked.

Patterns are checked on every leaf of the request and response bodies and on every query value:

| Kind            | Matches                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `email`         | An address such as `name@example.com` anywhere in the value.                                 |
| `phone`         | The whole value is an E.164 number: `+` and 7 to 15 digits.                                  |
| `luhn-number`   | A run of 13 to 19 digits, spaces or dashes allowed between them, that passes the Luhn check. |
| `ipv4`          | A dotted address with four octets of 0 to 255, not part of a longer dotted run.              |
| `date-of-birth` | An ISO date under a key matching `birth` or `dob`, without regard to case.                   |

Header and query values are also checked by shape:

| Kind           | Matches                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `high-entropy` | The longest run without whitespace is longer than 20 characters and has a Shannon entropy of at least 4 bits per character, which is where random tokens, keys, and signatures sit and where words, dates, and content types do not. |
| `hex-token`    | The longest run without whitespace is 32 or more hex digits, which entropy alone cannot reach.                                                                                                                                       |

Values equal to `<redacted>` are counted under "redacted" rather than reported, and transport headers whose values are never a secret (`content-type`, `date`, `user-agent`, `etag`, and the like) are skipped. A base64 body is bytes rather than fields and is not scanned.

Findings are grouped by location: `request.body:` or `response.body:` followed by the JSONPath with array indices generalized to `[*]`, `request.query:` followed by the parameter name, or `request.headers:` or `response.headers:` followed by the header name. Each group has a count and one masked example. On the committed demo recording the scan reports the redacted `authorization` header on all 283 exchanges and nothing else.

```
traffic.jsonl: scanned 1200 exchanges
  redacted: request.headers:authorization (1200)
  location                       kind          count  example
  request.body:$.customer.email  email           412  al*************om
  request.body:$.items[*].ip     ipv4            806  10****.1
  request.headers:x-api-key      high-entropy   1200  k3****************************Eu
```

## migrate

```sh
rp recording migrate demo/recording.jsonl --out demo-with-manifest.jsonl \
  --target http://reference:3000 \
  --tag-rule 'POST /v1/orders=create-order' --tag-rule 'GET /v1/orders/*=get-order' \
  --created-at 2026-10-16T20:50:45.469Z
```

Writes a copy of a recording that starts with a manifest built from the flags, followed by every byte of the input unchanged: each exchange line, its line ending, and a missing final newline are kept. The output minus its first line is the input byte for byte. The flags describe how the recording was made: `--target`, `--tag-rule` (repeatable), `--redact-header` and `--redact-query` (repeatable, defaulting to the capture's default lists), `--sample`, `--sample-seed`, `--session-key`, and `--created-at` (default: now). `tool_version` is the running version.

The input is validated first, and nothing is written when it is invalid, when it already has a manifest, or when `--out` names the input. A `.gz` input is copied decompressed and a `.gz` output is written compressed, and the byte for byte guarantee holds for the decompressed bytes. The output has a different recording hash from the input, as any edit gives.

## anonymize

```sh
RP_REDACTION_KEY=... rp recording anonymize traffic.jsonl --capture-rules capture-rules.yaml --out shareable.jsonl
```

Applies the redaction of a capture rules file to every exchange and writes the result, keeping ids, order, and offsets. The rules file and its `drop` and `hash` modes are described in `docs/capture.md` under "Body redaction"; body paths apply to request and response bodies stored as JSON, and header and query entries to those names. Without `--redact-header` and `--redact-query`, only the rules file applies; with them, those names are dropped as well. A rule in `hash` mode needs `RP_REDACTION_KEY`, and the command refuses to run without it. A manifest on the input is kept with its redaction lists and rules extended; an input without a manifest gives an output without one. `--out` may not be the input.
