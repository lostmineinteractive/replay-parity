# ADR 0015: Reduced, not minimal

Status: Accepted

Date: 2026-10-17, the date of commit `3da3a3c`, which introduced it.

## Context

A failing run of hundreds of exchanges is hard to act on. Delta debugging finds a shorter list that still fails, but it does not prove that no shorter list exists.

## Decision

Shrinking removes recorded steps with delta debugging, re-adds what any kept step needs, lowers quantities toward one, and replays every candidate against a reset system, judged by the same rule. The result is shorter and still fails. The report says reduced reproduction and never minimal.

## Consequences

- The label states only what was shown.
- A shrink needs a way to reset the candidate between attempts.
- Later work added value lowering at named paths, parallel targets, an attempt cache, and a latency rule whose result is labeled statistical. Each keeps the same wording rule.
