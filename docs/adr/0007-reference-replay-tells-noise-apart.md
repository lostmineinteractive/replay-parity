# ADR 0007: The reference is replayed too, to tell noise apart

Status: Accepted

Date: 2026-11-03, the date of commit `ee882a3`, which introduced it.

## Context

Without it a timestamp failed every candidate until someone wrote an ignore rule. The comparison set the proxy's view of the reference on the day of the capture against the candidate on the day of the replay.

## Decision

With `--reference-target` every exchange goes to the reference as well as the candidate, at the same moment and in the same order, with the reference's own substitution table built from its own answers. A path where the reference differs from its own recording moved by itself, as a timestamp or a fresh id does. The same difference on the candidate is tolerated as `noise:reference` and marked `noise: true` instead of failing the run. A reference that answered another status, a body of another format, or no answer names no noise. An exchange is acknowledged once both systems answered, so every ordering rule holds for the reference too.

## Consequences

- A broken reference cannot excuse a candidate that is broken the same way.
- The reference receives the traffic again, writes included, so it must be a system that may take it.
- A reference that has become unstable could excuse too much, so a threshold on the noise rate can fail the run.
