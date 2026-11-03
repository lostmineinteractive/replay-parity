# ADR 0017: Reports open offline

Status: Accepted

Date: 2026-10-17, the date of commit `a852f4f`, which introduced it.

## Context

A report has to open from the file alone, on any machine, with no network.

## Decision

The HTML report is one file with inline CSS and SVG, no script, and no external resource. The drill down shows at most 200 mismatched exchanges, taken round robin across the top paths so every path is represented. The JSON run is the canonical form, and the HTML, terminal, JUnit, and Markdown views are rendered from it.

## Consequences

- The same run always produces the same bytes in every format.
- A very bad run still produces a file a browser can open, and the full list stays in the run file or its sidecar.
- A new view is a new renderer over the run and needs no change to the run.
