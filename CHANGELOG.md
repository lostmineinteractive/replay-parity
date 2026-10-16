# Changelog

All notable changes to this repository are recorded here. The format follows Keep a Changelog. Entries are grouped by build step while the project is unreleased.

## Unreleased

### Step 1: core package

- Added `@replay-parity/core` with the recording format (zod schemas, a streaming JSON Lines reader that reports line numbers and rejects decreasing `offset_ms`, an append only writer, body encoding with the one MiB truncation rule, header redaction, and a monotonic ULID generator).
- Added a JSONPath subset (`$`, `.name`, `['name']`, `[n]`, `[*]`, `.*`) with concrete path rendering, wildcard rule matching, and keyed segments for unordered arrays.
- Added the diff rules schema with `ignore`, `tolerances`, `unordered` (list of `{path, key}` objects), `status.equivalent`, `headers.compare`, and `substitutions`, plus YAML loading that names the file and the path of any error.
- Added the differ with `match`, `tolerated`, and `mismatch` verdicts, deterministic finding order, substitution equivalences, the `body_too_large` finding for truncated bodies, and plain language explanations.
- Added latency statistics on `hdr-histogram-js` with fixed log spaced bins, per tag and overall aggregation, the thresholds schema and evaluator, and the run model with its JSON Schema emitted to `packages/core/schema/run.schema.json`.
- Added a `testing` module with fixture builders and an ajv based run validator for use by other packages' tests.
- Set Prettier to single quotes.

### Step 0: workspace scaffold

- Added the pnpm workspace with `packages/*` and `demo/*`, a shared strict TypeScript base config with project references, ESLint flat config with type checked rules, Prettier, and a Vitest root config with `unit` and `integration` projects and a 90 percent coverage gate on `packages/core`.
- Added the MIT license, a Makefile compatible with GNU Make 3.81, and empty shells for the six packages and the two demo services.
- Added `scripts/check-prose.sh`, which fails on em dashes in Markdown and on banned vocabulary anywhere in the tree, and `scripts/check-secrets.sh`, which fails when a git visible file contains an Anthropic API key prefix and prints only file names and line numbers.
- Pinned TypeScript 6.0 because typescript-eslint does not yet accept TypeScript 7. Pinned `@types/node` 22 to match the supported Node version.
