# ADR 0004: The recorded order is kept

Status: Accepted

Date: 2026-10-17, the date of commit `af47b08`, which introduced it.

## Context

With a slow candidate, a read could be sent before the write it followed in the recording had been answered. The read then returned stale data, and the stale read looked like a defect in the candidate.

## Decision

An exchange that began after an earlier exchange's response in the recording is never sent before that exchange is acknowledged. Exchanges that overlapped in the recording may overlap again.

## Consequences

- A mismatch is no longer an artifact of the replay overtaking itself.
- The engine never introduces an ordering the recording did not have, and it never drops one the recording had. A sequential recording therefore replays one request at a time whatever `--concurrency` says.
- Sessions, described in ADR 0005, narrow the rule to the exchanges of one session.
