# ADR 0001: JSON Lines for recordings

Status: Accepted

Date: 2026-10-16, the date of commit `be565e3`, which introduced it.

## Context

A recording is the evidence every later step reads. A capture can die in the middle of a write, and a recording may be larger than memory. People also need to split, sample, filter, and diff recordings in git with the tools they already have.

## Decision

A recording is JSON Lines with one exchange per line. It is append only. It is valid when every line parses and `offset_ms` never decreases. The reader streams the file one line at a time.

## Consequences

- A capture that dies mid write loses one line and nothing else.
- A recording larger than memory still replays, because nothing needs the whole file at once.
- A recording can be split, sampled, filtered, and diffed in git with ordinary tools. `rp recording` filter, sample, and split rebase `offset_ms`, so a cut recording is still valid and replays with its original rhythm.
