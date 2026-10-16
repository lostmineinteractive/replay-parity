# Changelog

All notable changes to this repository are recorded here. The format follows Keep a Changelog. Entries are grouped by build step while the project is unreleased.

## Unreleased

### Step 3b: order lifecycle in the demo services (Addendum A0)

- Both demo services gain `Idempotency-Key` on `POST /v1/orders`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/quantity`, `POST /v1/orders/:id/shipments`, `GET /v1/ledger` with decimal strings, and the admin controls `POST /admin/restart` and `POST /admin/reset`. Orders carry `status` (`OPEN`, `PARTIALLY_SHIPPED`, `SHIPPED`, `CANCELED`, `REJECTED`), `quantity`, `shipped`, `remaining`, and `canceled_unshipped` next to the amount in `total`. Stock on hand changes only on accepted shipments and adjustments. Creation allocates against available stock and a shortfall yields a `REJECTED` order. Cancellation acceptance is the cancel request's own `originated_at`.
- A `Store` keeps the working state in memory and commits every mutation to a durable copy, a JSON file when `STORE_PATH` is set. `restart` reloads the durable copy, which is what a process restart does.
- The candidate's `DIVERGENCES` switch is now a named set. `on` enables the original four (`rounding-half-even`, `inventory-insertion-order`, `adjust-stock-delay`, `unknown-order-200`), `off` enables none, and a comma separated list enables exactly the named ones. The four seeded defects of Addendum A3 are present as marked lines: `shipment-applied-twice`, `quantity-as-additional`, `drop-late-precancel-shipment`, `idempotency-lost-on-restart`.
- The candidate `app.ts` is derived from the reference `app.ts`. `scripts/check-parallel.sh` fails when the two differ outside hunks marked `DIVERGENCE` or `DEFECT`, or when `store.ts` or `catalog.ts` differ at all.
- The load generator now runs a seeded plan of twelve lifecycle scenarios with background traffic between them, a ledger read after each, and a final read of every order and the ledger. New tags: `cancel-order`, `set-quantity`, `ship-order`, `list-ledger`, `admin-restart`, `admin-reset`.
- `demo/recording.jsonl` regenerated: 283 exchanges over 12.8 seconds, 44 orders, nine tags, seven retried idempotency keys, one restart.
- `scripts/check-prose.sh` no longer bans `ledger`, since the route name is mandated by the addendum.
- Tests: 42 across the two services and the load package cover every lifecycle route, idempotency, cancellation by `originated_at`, duplicate shipments, allocation, the store across an in memory restart and a real rebuild, each seeded defect alone, byte identical parity with divergences off over every route, and the plan's shape.
- PLAN.md gains section 8, the Addendum A plan, with the approval record.

### Step 3: capture proxy, demo load, committed recording

- Added `@replay-parity/capture`: a reverse proxy on Node `http` and `undici` that streams every response back unchanged, records the exchange with arrival order preserved under concurrency, applies `--tag-rule` style rules (`[METHOD ]<glob>=<tag>`), samples with an injectable random source, redacts headers, enforces `--max-body-bytes` (default 1 MiB) by storing an oversized body as hash and size, answers 502 or 504 when the upstream fails, and flushes the recording on close after in flight requests finish.
- Added `@replay-parity/demo-load`, a seeded traffic generator for the four demo tags that looks up ids returned by earlier order creations and uses an unknown id on a share of lookups.
- Added the `@replay-parity/scripts` workspace with `make-recording.ts` (produces `demo/recording.jsonl` in process, no Docker) and `bench-capture.ts` (measures proxy overhead against a running reference), plus `make recording` and `make bench-capture` targets.
- Committed `demo/recording.jsonl`: 300 exchanges over 13 seconds across `create-order`, `get-order`, `list-inventory`, and `adjust-stock`, with the demo authorization header redacted.
- Integration tests cover byte identical pass through for JSON, text, binary, chunked, cookie, error, and empty responses, the recorded fields from the spec, arrival order under concurrency, the body size cap, sampling, upstream failure and timeout, and graceful shutdown with requests in flight.

### Step 2: demo services

- Added `@replay-parity/demo-reference`, a fastify inventory and fulfillment service with `GET /v1/inventory`, `POST /v1/orders`, `GET /v1/orders/:id`, `POST /v1/inventory/:sku/adjust`, and `/healthz`. Prices are stored in thousandths so order totals can land on exact half cents.
- Added `@replay-parity/demo-candidate`, the same service with four planted divergences behind the `DIVERGENCES` environment variable: half even rounding, insertion ordered inventory, a 60 ms delay on a seeded 5 percent of adjust calls, and 200 with an empty body for an unknown order. The two `app.ts` files differ only at the four marked lines.
- Tests cover each divergence, the delay plan's reproducibility for a seed, and byte identical responses to the reference over a scripted scenario when divergences are off.

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
