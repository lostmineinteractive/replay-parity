---
'@replay-parity/core': minor
'@replay-parity/capture': minor
'@replay-parity/replay': minor
'@replay-parity/invariants': minor
'@replay-parity/shrink': minor
'@replay-parity/report': minor
'@replay-parity/agent': minor
'@replay-parity/cli': minor
---

The first published release. Every package is public on npm with provenance, and the `rp` command ships as an image on GHCR built from a distroless base.

Since 0.1.0:

- `rp report` renders JUnit and Markdown as well as HTML, JSON, and terminal, caps the HTML drill down, and gates with `--fail-on-verdict`.
- The capture proxy streams request and response bodies through a capped hash, and `--redact-query` redacts query parameters by name in both the recording and the candidate recording.
- The run model records a stop by signal, the gap cap, and dependency exchanges, and older run files are migrated on read.
- Every command stops cleanly on SIGINT or SIGTERM and writes what it has. `rp replay` caps recorded gaps with `--max-gap-ms` and selects the producers a filter needs unless `--no-include-dependencies` is given. `rp shrink` keeps the best reduction so far. `rp agent` stops at the next case boundary.
- The agent dates its price table, lists the current models, and accepts a pricing file.
- `rp --version` reads the version from the package, and `.env` is resolved at the repository root.
