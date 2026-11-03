# ADR 0016: The agent is bounded

Status: Accepted

Date: 2026-10-17, the date of commit `b881dde`, which introduced it.

## Context

A model that proposes test cases can spend without limit, return malformed output, and see data it should not.

## Decision

The agent makes one model call per round. A schema drops anything malformed. Each call has a cost from a static table, and the loop stops before a call that could cross the budget. A transcript records the prompt versions. The model sees redacted headers and nothing from the repository tree.

## Consequences

- A run costs at most its budget, and the transcript shows what was spent.
- Malformed cases are dropped with a reason and not executed.
- Without an API key the command prints a message and exits 0, so a pipeline without a key does not fail.
