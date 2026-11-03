# ADR 0014: Independent invariants

Status: Accepted

Date: 2026-10-17, the date of commit `31f2a3e`, which introduced it.

## Context

Agreement between two systems is not evidence that either is right. A candidate that copies a defect of the reference would pass a diff.

## Decision

Each system's recording is checked on its own against rules written from the domain's definitions, using only that system's acknowledgements to rebuild the expected state. The report shows the result per system above the diff.

## Consequences

- A defect can be found in the candidate, or in the reference, from the system's own log alone.
- The rules are specific to a domain. The first set encoded the demo's order lifecycle, and another domain needs its own. Rules now load through an invariant module interface and from declarative files, as `docs/invariants.md` describes.
