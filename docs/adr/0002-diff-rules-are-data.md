# ADR 0002: Diff rules are data

Status: Accepted

Date: 2026-10-16, the date of commit `be565e3`, which introduced it.

## Context

Two systems never agree byte for byte. Some differences are expected, such as an id assigned by each system or an array whose order does not matter, and a reviewer has to be able to see which ones were accepted and why.

## Decision

A rules file names what to ignore, which numbers tolerate how much, which arrays are sets and by which key, which statuses are equivalent, which headers to compare, which values are substituted, and which tags are harness controls. The differ reports the path, both values, and the rule that tolerated a difference, in a deterministic order.

## Consequences

- A reviewer can read the rules and the findings without reading code.
- Two runs with the same rules diff cleanly, because the order of findings is deterministic.
- The rules are embedded in every run, so a run says which rules judged it.
- The rules were global when this was decided. A later change added an optional `when` scope to each entry, so a rule can apply to some tags, methods, or paths and not others.
