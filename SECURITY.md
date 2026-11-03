# Security

## Reporting a vulnerability

Report a vulnerability through GitHub private vulnerability reporting on this repository: open the Security tab, choose Report a vulnerability, and fill in the form. Do not open a public issue or a pull request for it. A report is acknowledged within 72 hours. The acknowledgement names who is handling it and when to expect the next update. A confirmed vulnerability is fixed in the latest minor version, and the advisory is published when the fix is released, with credit to the reporter unless they ask otherwise.

## Supported versions

Security fixes go to the latest minor version only. A report against an older minor is answered with the fix in the latest one. Until the first release, the latest minor is the head of `main`.

## What the tool stores

The tool writes these kinds of files, all to paths named on the command line, and sends none of them anywhere by itself.

- Recordings. `rp capture` writes one JSON Lines file with one exchange per line: the request method, path, query, headers, and body; the response status, headers, and body; and the timing.
- Candidate recordings. `rp replay --candidate-recording <path>` writes the candidate's side of the replay in the same format, with the same header redaction.
- Run files. `rp replay --out <path>` writes the verdict, the statistics, and every finding with its path and both values. A mismatching body field appears in the run file in clear, and the HTML report rendered from it shows the same values.
- Run sidecars. A run that streams its results writes `<out>.exchanges.jsonl` with every exchange result, findings included, so it carries the same body values as the run file, and `<out>.checkpoint.json` with the substitution tables as they stood, which hold the captured ids.
- Agent transcripts. `rp agent` writes every prompt sent to the model and every answer, the generated cases, and why each case was kept or dropped.

## What redaction covers

Header and query parameter redaction by name is the default. The capture proxy replaces the value of each header on its list with `<redacted>`. The default header list is `authorization`, `cookie`, `set-cookie`, and `x-api-key`, and `--redact-header` replaces it. Query parameters are redacted by name from a second list, by default `api_key`, `apikey`, `access_token`, `token`, `key`, `secret`, `signature`, and `password`, which `--redact-query` replaces. A capture rules file given with `--capture-rules` adds entries for bodies, query parameters, and headers. Each entry is `drop`, which writes `<redacted>`, or `hash`, which writes an HMAC-SHA256 keyed by the environment variable `RP_REDACTION_KEY`, so equal values stay equal. `rp capture` and `rp import har` refuse to start with a hash rule and no key, the key is never written to a recording, and `rp recording anonymize` applies a rules file to a recording that already exists. A body path applies to request and response bodies stored as JSON, and a body stored as base64 or as a hash is left as it is. Paths, and every body field, header, or parameter not named by a rule, are stored as received. An id in a URL path is never redacted. `docs/capture.md` describes the format.

A recording therefore contains every body field a rule did not name, with whatever personal data or credentials those bodies held. `rp recording scan` reports what looks like personal data in a recording. Treat it as a copy of that data: store it where the reference system's own data may be stored, share it only with people who may read that data, and delete it when the run that needed it is done. The same holds for a candidate recording and for a run file, because both carry body values.

## What the agent sends

`rp agent` is the only command that sends data off the machine. Each round sends the model provider the run summary (the verdict, the threshold rows that did not pass, the mismatch paths with their counts, a sample of up to eight mismatched exchanges with the first differing values of each, and the latency rows that failed) and the request shapes: for each tag, the method, the path, the body of the first recorded request, the statuses seen, and the keys of the responses. Of the request headers only `content-type` and `idempotency-key` are shown, and a header on the redaction list is shown as `<redacted>` even when the recording was not redacted. Later rounds also send the cases kept so far.

It sends nothing from the repository tree: no source, no rules files, no recording lines, and no run file. The API key is read from `ANTHROPIC_API_KEY` or from a gitignored `.env` at the repository root. Without a key the command prints a message and exits 0 without calling anyone.
