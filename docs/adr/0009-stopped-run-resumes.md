# ADR 0009: A stopped run resumes

Status: Accepted

Date: 2026-11-03, the date of commit `f457b33`, which introduced it.

## Context

A signal stops a run and writes a partial run, as ADR 0011 describes. Without more, continuing it means sending everything again.

## Decision

A run that uses the sidecar writes a checkpoint every 1000 acknowledgements and when a signal stops it. The checkpoint holds the end of the acknowledged prefix, the sidecar bytes that hold it, the substitution tables as that prefix left them, and the conditions it produced. A send the stop cut short is not part of the prefix. `--resume` refuses a different recording or any option that shapes the results, truncates the sidecar to the prefix, rebuilds the statistics from it, and sends the rest.

## Consequences

- The resumed run ends with the verdict, counts, and findings of a run that was never stopped.
- The exchanges after the prefix are sent again, which a stateful candidate sees twice unless it is reset first.
- A resumed run cannot write a candidate recording or judge the invariants, because the prefix was not sent by the resumed process.
