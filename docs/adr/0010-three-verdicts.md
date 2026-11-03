# ADR 0010: Three verdicts

Status: Accepted

Date: 2026-10-17, the date of commit `cd1fbad`, which introduced it.

## Context

A harness can fail to decide without the candidate being wrong. A barrier can time out, a snapshot can be read while a command is in flight, or a latency row can have too few samples. Reporting those as a pass or a fail would be a guess.

## Decision

A run passes, fails, or is inconclusive. Fail means a verified difference, a breached threshold, or an invariant violation. Inconclusive means the harness could not decide: a barrier timed out, a snapshot was read while a command was in flight, the schedule was not held, a control failed, the run was stopped by a signal, or a latency row had fewer successful samples than its minimum. A run level condition wins over observed mismatches, because those may be artifacts. The exit codes are 0, 2, 3, and 1 for a tool error.

## Consequences

- A scheduler can tell a regression, a run it must read, and a broken job apart by the exit code.
- The report shows the observed mismatches in every case, including an inconclusive run.
- The kinds of inconclusive condition have grown since, and `docs/report-format.md` lists them with the precedence rule.
