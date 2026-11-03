# ADR 0012: The run names its recording

Status: Accepted

Date: 2026-10-27, the date of commit `436f4d6`, which introduced it.

## Context

A run is only meaningful with the recording it replayed. An edited, appended, filtered, or reordered file would give a different result, and a reduced reproduction built from the wrong file would mislead.

## Decision

`rp replay` hashes the recording file in a streaming pass alongside the read and writes the SHA-256 of its bytes into the run as `recording.recording_sha256`. `rp shrink` hashes the file it is given and refuses one whose hash differs from the run's, naming both hashes, unless `--allow-recording-mismatch` turns the refusal into a warning.

## Consequences

- A reduced reproduction is built from the file the run replayed.
- A run built from exchanges in memory carries null and accepts any file. A run written before the field existed still parses, because the field is optional and older run files are migrated on read.
- The hash later became the check behind `--baseline`, which refuses a baseline from a different recording.
