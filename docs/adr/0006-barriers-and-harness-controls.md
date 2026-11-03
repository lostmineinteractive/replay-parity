# ADR 0006: Barriers and harness controls

Status: Accepted

Date: 2026-10-17, the date of commit `1b1fc3d`, which introduced it.

## Context

Some reads, such as a snapshot of a ledger, are only meaningful when every earlier write has been acknowledged. Some exchanges, such as a restart, are part of the traffic but are not behavior to compare or time.

## Decision

A barrier tag makes an exchange wait until every earlier exchange of every session has a response or an error, run alone, and be acknowledged before anything later in any session is sent. A wait past the timeout makes the run inconclusive. A harness control, such as a restart, is a barrier that is diffed on status only, excluded from statistics and thresholds, and shown in the report in sequence without a score.

## Consequences

- A snapshot read sees every earlier acknowledged write.
- A barrier that cannot be satisfied is reported as an inconclusive run and not as a candidate defect.
- A control is visible in the report and does not move a latency percentile or a mismatch rate.
