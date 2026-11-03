# ADR 0011: A signal stops the run cleanly

Status: Accepted

Date: 2026-10-27, the date of commit `d4f8a82`, which introduced it.

## Context

Only the capture command observed the first SIGINT. Replay, shrink, and agent ignored it, and the second signal killed the process with no run written.

## Decision

The first SIGINT or SIGTERM aborts one controller that the CLI passes to every command, and a second signal exits at once with 130. The engine sends nothing more, aborts the sends in flight, and finishes the run with the results so far and an `aborted` condition naming how many of the selected exchanges were sent. The shrink cuts the attempt in progress short, keeps the best reduction confirmed so far, and still writes the reduced recording. The agent checks the signal before each round and each case and stops at the next boundary with the stop reason `aborted`.

## Consequences

- A stopped command writes what it has, and the command exits 3.
- A stopped run is inconclusive, never a pass or a fail, because the harness did not see everything.
- A second signal still ends the process at once, with exit code 130 and nothing more written.
