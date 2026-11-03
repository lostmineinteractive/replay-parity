# ADR 0003: Stateful sequences

Status: Accepted

Date: 2026-10-17, the date of commit `1b1fc3d`, which introduced it.

## Context

A system assigns its own identifiers. An order id in the recording belongs to the reference, and the candidate will assign another one. A later request that uses the recorded id would address nothing on the candidate.

## Decision

A substitution rule captures a value, such as an order id, from the response of every exchange carrying a tag. On the reference side the value comes from the recording, and on the candidate side from the replay. Later requests have the reference value replaced with the candidate value in the path, the query, and the body, and the differ treats the pair as equivalent. The engine computes the dependencies before anything is sent and waits for the producer under every pacing mode. The first exchange to produce a reference value wins.

## Consequences

- A retry that yields a different candidate id is a mismatch and not a silent remap.
- A request waits for the exchange that produced its value, so the producer must be part of the replay. A filtered replay selects the producers a filtered exchange needs.
- A substitution applies to the path, the query, and the body. It does not rewrite headers.
