# ADR 0008: The recording and the results stream

Status: Accepted

Date: 2026-11-03, the date of commit `c61cea3`, which introduced it.

## Context

The engine read the whole recording into memory, and kept every exchange result in memory and in the run file. A replay of millions of exchanges cannot do that.

## Decision

The engine never holds the whole recording. A first pass over the file validates every line, counts the exchanges, and chooses the selection, so a file that does not parse still sends nothing. Each replay pass reads the file again through a window of at most `--window` exchanges (10000 by default) past the oldest one not yet acknowledged. The dependency index and the happens-before checks are answered from what the window holds. Above 50000 results, or with `--exchanges-sidecar`, results stream to a JSON Lines sidecar next to the run, and the run file keeps the summary and a sample of the mismatches.

## Consequences

- A run of millions of exchanges writes a run file of kilobytes, and `rp report` reads the sidecar back.
- A window that is too small costs overlap and not correctness.
- What still grows with the run is small and named: one number per exchange for the schedule slip, the substitution tables, and the producers of each dependent exchange in the first pass of a filtered replay.
- The preflight of `rp replay`, the candidate recording, and the invariants read whole recordings and are the exceptions.
