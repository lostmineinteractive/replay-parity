# Capture and the recording format

`rp capture` is a reverse proxy in front of the reference system. It forwards every request, streams the response back unchanged, and appends one exchange per request to a recording. This page covers what the recording holds besides exchanges, and the capture options that shape it: the manifest line, session aware sampling, rotation and compression, the limits that end a capture, body redaction, lossless numbers, and importing a HAR file instead of capturing. `docs/recording-tools.md` covers the tools that work on a recording once it exists.

## The manifest line

A recording may start with one line that is a manifest rather than an exchange:

```json
{
  "manifest": 1,
  "tool_version": "0.1.0",
  "created_at": "2026-11-01T10:00:00.000Z",
  "target": "http://reference:3000",
  "tag_rules": ["POST /v1/orders=create-order", "GET /v1/orders/*=get-order"],
  "redaction": {
    "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
    "query": [
      "api_key",
      "apikey",
      "access_token",
      "token",
      "key",
      "secret",
      "signature",
      "password"
    ],
    "rules": {
      "headers": [],
      "query": [],
      "body": [{ "path": "$..order_id", "mode": "hash" }]
    }
  },
  "sample": { "fraction": 0.1, "seed": 1234 },
  "session_key": "header:x-session-id"
}
```

On disk it is one line like every other. The fields:

| Field          | Meaning                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `manifest`     | The manifest version. Always `1` today; a reader refuses a version it does not know.                                       |
| `tool_version` | The version of `rp` that wrote the file.                                                                                   |
| `created_at`   | When the file, or the part, was started.                                                                                   |
| `target`       | The reference system the traffic went to, or `null` when unknown.                                                          |
| `tag_rules`    | The tag rules in their text form, in order.                                                                                |
| `redaction`    | The header and query names replaced by the marker, and under `rules` the entries of a capture rules file with their modes. |
| `sample`       | The fraction recorded and the seed of the session hash, `null` without `--sample-by`.                                      |
| `session_key`  | The `--sample-by` selector, or `null` when each request was sampled on its own.                                            |
| `part`         | Present on a rotated part: its number, from 1.                                                                             |
| `source`       | Present on an imported recording: where the exchanges came from, such as `har:session.har`.                                |

The manifest never holds a secret. A hash rule names its path and its mode; the HMAC key is never written.

Reading. The reader skips the manifest, so the exchanges of a file with a manifest and of the same file without one are identical, and a file without a manifest reads exactly as before. A manifest is allowed only on the first line that is not blank; anywhere else it is an error with its line number. Line numbers in errors are line numbers in the file, manifest included. `offset_ms` means the same with or without a manifest. The recording hash is the hash of every byte of the file, so adding a manifest changes the hash, as any edit does. In code, `readRecordingManifest(path)` returns the manifest or `null`, and the iterator `iterateRecording(path)` returns has a `manifest` property that is `undefined` until the first line is read and the manifest or `null` after; the exchanges it yields are unchanged.

Writing. `rp capture` writes a manifest when it starts a new file: a file that does not exist, an empty one, or any file with `--no-append`. When it appends to a file that already has content it writes none, so an existing recording without a manifest stays without one. `rp recording migrate` adds one to an existing file, and `rp recording validate` prints it.

## Session aware sampling

```sh
rp capture --target http://reference:3000 --out traffic.jsonl --sample 0.1 --sample-by header:x-session-id
rp capture --target http://reference:3000 --out traffic.jsonl --sample 0.1 --sample-by cookie:sid --sample-seed 7
rp capture --target http://reference:3000 --out traffic.jsonl --sample 0.1 --sample-by '$.session.id'
```

`--sample` alone records each request on its own draw, which can keep a create and drop the read that uses its id, so the substitution that ties them never fires. The capture prints a one line warning when `--sample` is below 1 without `--sample-by`.

`--sample-by` keeps or drops whole sessions. The selector names where a request carries its session: `header:<name>`, `cookie:<name>` (read from the `cookie` request header before it is redacted), or a JSONPath into the request body made of keys and indexes only. The value found there is hashed with the seed, the same hash `rp recording sample --by-session` uses, and the session is kept when the hash falls below the fraction. Every request of a session gets the same answer, so a sampled recording keeps a create together with its later reads. For a header or body selector, a capture at a fraction and seed keeps the same sessions as `rp recording sample --by-session` at the same fraction and seed on a full capture.

A request with no session value, such as a health check, falls back to a draw of its own at the same fraction. With a body selector the decision waits for the request body, so both bodies of every request are kept up to the cap until the request body is in; a header or cookie selector decides when the request arrives and costs nothing for a dropped session.

`--sample-seed <n>` fixes the seed for a repeatable sample. Without it a seed is drawn, logged at start, and written in the manifest.

## Rotation and compression

```sh
rp capture --target http://reference:3000 --out traffic.jsonl --rotate-bytes 104857600 --gzip
rp capture --target http://reference:3000 --out traffic.jsonl --rotate-interval 3600000
```

Any of `--rotate-bytes`, `--rotate-interval`, and `--gzip` makes the capture write numbered parts instead of one file. The parts sit next to the `--out` path and take its name without `.jsonl` and `.gz` as their stem: `traffic.0001.jsonl`, `traffic.0002.jsonl`, or with `--gzip` `traffic.0001.jsonl.gz`. A new capture starts after the highest part number already in the directory, so it never writes over an earlier part; `--no-append` has no effect on parts.

- `--rotate-bytes <n>` starts a new part once the current one holds `n` bytes of JSON Lines. The count is before compression, because the compressed size is not known until the compressor flushes.
- `--rotate-interval <ms>` starts a new part when an exchange arrives `ms` or more after the first exchange of the current part, measured on the capture's clock at arrival. A quiet period produces no empty part.
- `--gzip` compresses each part.

Rotation happens just before an exchange is written, so no part is ever empty and a part closes only when the next exchange is due elsewhere or the capture ends.

Each part is a whole recording: it starts with its own manifest carrying its `part` number and the time it was started, and every `rp recording` subcommand and `rp replay` read it on its own. `offset_ms` continues across parts and is not reset at a boundary: the first exchange of part 2 has the offset it would have had in one long file. This keeps one timeline for the whole capture, so `rp recording merge` of the parts, which recomputes offsets from `ts`, gives the same offsets the parts already carry, and a part can be placed on the capture's timeline without its neighbors. `rp replay` schedules relative to the first exchange it reads, so a part replays on its own without waiting out its first offset.

The reader opens a path ending in `.gz` as gzip, including a file of several gzip members, which is what appending to a gzip file produces. A path ending in `.gz` given as an output to `rp recording` subcommands is written as gzip, and `split` of a gzip input writes gzip parts. The recording hash of a gzip file is the hash of the compressed bytes on disk.

## Limits that end a capture

```sh
rp capture --target http://reference:3000 --out smoke.jsonl --max-exchanges 500
rp capture --target http://reference:3000 --out hour.jsonl --duration 3600000
```

`--max-exchanges <n>` ends the capture once `n` exchanges are recorded; sampled out requests do not count. A request already in flight when the limit is reached is still answered and is not recorded, so the file holds exactly `n`. `--duration <ms>` ends the capture that long after it starts listening. Either one closes the capture the same way SIGINT and SIGTERM do: it stops accepting connections, lets requests in flight finish, flushes and closes the file, and exits 0 with the usual summary line, preceded by a line naming the limit that was reached.

## Body redaction

```sh
export RP_REDACTION_KEY=...   # from your secret store
rp capture --target http://reference:3000 --out traffic.jsonl --capture-rules capture-rules.yaml
rp recording anonymize old.jsonl --capture-rules capture-rules.yaml --out shareable.jsonl
```

A capture rules file says what to redact beyond the header and query name lists:

```yaml
redact:
  body:
    - { path: '$.card.number', mode: drop }
    - { path: '$.customer.email', mode: hash }
    - { path: '$..order_id', mode: hash }
    - { path: '$.items[*].owner', mode: hash }
  query:
    - session_token
    - { name: user, mode: hash }
  headers:
    - { name: x-user-id, mode: hash }
```

Every entry has a mode, `drop` when not given:

- `drop` replaces the value with the redaction marker `<redacted>`, as the header and query lists do.
- `hash` replaces it with `hmac-sha256:<hex>`, the HMAC-SHA256 of the value keyed by the `RP_REDACTION_KEY` environment variable. A string is hashed as its text, a lossless number as its text, and any other value as its canonical JSON. Equal values give equal hashes, so an order id hashed in the create's response and in a later request's body is still the same value, and a substitution that captures it finds the same hash where it is used and rewrites it to the candidate's id. A value that is already the marker stays the marker.

`rp capture` and `rp import har` refuse to start, and `rp recording anonymize` refuses to run, when a rule hashes and `RP_REDACTION_KEY` is unset or empty; nothing is written. The key never reaches the recording or the manifest. Recordings hashed with different keys do not share hashes, so keep one key for the recordings that are compared with each other.

Body paths are JSONPath and may use `[*]` and recursive descent `..`. They apply to the request body and the response body of every exchange when the body is stored as JSON; a base64 or truncated body is left as it is. Header and query entries are added to the `--redact-header` and `--redact-query` lists (or the defaults when those flags are not given), and an entry in the file sets the mode for its name, so `{ name: authorization, mode: hash }` hashes a header the default list would drop. Redaction is applied after sampling, so `--sample-by` reads the value before it is hashed.

Values in the URL path are not covered by body rules. A substitution through a hashed id works when the id travels in bodies or query parameters; an id that also appears in a path segment stays in clear there, and the hashed value captured from a body will not match it.

`rp recording anonymize <in> --capture-rules <path> --out <path>` applies the same rules to an existing recording, keeping ids, order, and offsets. Without `--redact-header` and `--redact-query` it applies only the rules file. A manifest on the input is kept with the redaction lists and rules extended; an input without a manifest gives an output without one.

## Lossless numbers

JavaScript reads every JSON number as a double, so `1.10` becomes `1.1`, `1e2` becomes `100`, and `12345678901234567891` becomes `12345678901234567000`. A recording stores a JSON body parsed, so without care the recorded body would differ from what the system sent.

A number in a JSON body whose text would change through a JavaScript round trip, which is any number where `JSON.stringify(Number(text))` is not `text`, is stored as an object holding its original text:

```json
{ "price": { "$num": "1.10" }, "id": { "$num": "12345678901234567891" }, "qty": 3 }
```

A body with no such number is stored exactly as before, so an existing recording and its hash do not change, and most bodies never contain the form. When a recorded body is sent again, as a request body in a replay, the number is written back as its original text, so the wire bytes keep `1.10`.

The differ compares a `$num` value with another `$num` value or with a plain number by exact decimal value, using integer arithmetic on the text and never a double: `1.10` equals `1.1` and `11e-1`, and `12345678901234567890` does not equal `12345678901234567891`. A `tolerances` rule on the path applies with the same exact arithmetic, and a `decimal` rule applies to the text. A `$num` value against a string or an object is a type finding that names the side as a number.

The shape `{"$num": "<number text>"}` is reserved. A JSON body that itself contains an object whose only member is `$num` holding a number text is stored as base64 rather than parsed, so the shape in a stored body always means a lossless number.

Values captured by substitutions are strings and plain numbers, so an id that is a lossless number is not captured; ids that do not fit a double are best sent as strings.

## Importing a HAR file

```sh
rp import har session.har --out session.jsonl --tag-rule 'POST /v1/orders=create-order'
rp import har session.har --out session.jsonl.gz --capture-rules capture-rules.yaml
```

When a proxy cannot be put in front of the reference, a HAR 1.2 export from a browser or a gateway can stand in for a capture. Each entry becomes one exchange:

- the method, the path and query of the URL, and the headers, with names lower cased, repeated headers joined with a comma, and HTTP/2 pseudo headers and hop by hop headers left out;
- the request body from `postData.text` and the response body from `content.text`, decoding `content.encoding: base64`, stored by the same rules as a capture, so JSON is parsed with lossless numbers, other content is base64, and a body over `--max-body-bytes` is stored as its hash and size;
- a HAR body is already decoded, so a body that arrived with a `content-encoding` is stored decoded with the coding noted in `content_encoding`, as the capture does;
- `ts` from `startedDateTime`, `offset_ms` as the time since the earliest entry, and `latency_ms` from `time`, with a negative time read as 0;
- tags from `--tag-rule`, and redaction from `--redact-header`, `--redact-query`, and `--capture-rules`, with the same defaults as `rp capture`.

Exchanges are written in order of `startedDateTime`, with entries that started in the same millisecond kept in file order. An entry with no response, which browsers write with status 0, an unreadable date, or an unparseable URL is skipped and named on stderr. Ids are ULIDs on the entry's time with the random part derived from the file name and the entry's position, so importing the same file twice gives the same bytes when `--created-at` is fixed. The output starts with a manifest whose `target` is the origin of the earliest entry and whose `source` is `har:<file name>`.
