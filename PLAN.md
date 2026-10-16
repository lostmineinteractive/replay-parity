# Build plan for replay-parity

This plan turns SPEC.md into an ordered sequence of packages. Each step lists what gets built and what its tests cover. Section 4 lists every place where the spec is ambiguous and the resolution I will apply unless told otherwise. Section 5 lists requirements I think should change. Section 6 lists what I cannot verify on this machine.

## 1. Environment facts that shape the plan

| Item                  | Finding                                                                                                        | Consequence                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                  | v26.12.0 installed. Spec says Node 22.                                                                         | `engines.node >=22`. CI runs Node 22. Local development runs Node 26.                                                                                                                                                                                                                                                                 |
| pnpm                  | Not installed. Corepack is absent from Node 26. `npx pnpm@10` works.                                           | I will install pnpm 10 globally with `npm i -g pnpm@10` at the start of the build. Say so if you prefer `npx pnpm` for every command instead.                                                                                                                                                                                         |
| Docker                | Docker 29.4.1 and Compose v5.1.3 present.                                                                      | `make demo` can be verified end to end locally.                                                                                                                                                                                                                                                                                       |
| Make                  | GNU Make 3.81 (macOS default).                                                                                 | The Makefile uses only Make 3.81 syntax. No `.ONESHELL`, no `!=`, no `$(file ...)`.                                                                                                                                                                                                                                                   |
| Redis                 | No local server.                                                                                               | The Redis Streams bus implementation is tested only when `REDIS_URL` is set. CI starts a Redis service container. Locally I will run Redis in Docker for that test.                                                                                                                                                                   |
| Anthropic credentials | The key lives in a gitignored `.env` at the repo root as `ANTHROPIC_API_KEY`. I never read or print its value. | `rp agent` loads `.env` from the working directory with a ten line parser when the variable is not already set, and the `make demo` recipe sources `.env` with `set -a; . ./.env; set +a`. The agent is built against a mock first, then run for real in step 8, and the real transcript goes into `docs/agent-loop.md` in that step. |
| Chrome                | Google Chrome is installed.                                                                                    | Report screenshots are produced with headless Chrome through a small script.                                                                                                                                                                                                                                                          |
| Hardware              | Apple M4 Max, 16 cores, 64 GB.                                                                                 | The README states these numbers next to the measured overhead and throughput.                                                                                                                                                                                                                                                         |
| Git                   | Repo has no commits and no remote.                                                                             | One conventional commit on `main` at the end of each step. No branches, no PR flow, no push. The user adds the remote later.                                                                                                                                                                                                          |

## 2. Repository conventions

- Package names are `@replay-parity/core`, `@replay-parity/capture`, `@replay-parity/replay`, `@replay-parity/report`, `@replay-parity/agent`, `@replay-parity/cli`. Demo services are `@replay-parity/demo-reference` and `@replay-parity/demo-candidate` and live under `demo/`. The workspace globs are `packages/*` and `demo/*`.
- TypeScript 5.x, `module: NodeNext`, `target: ES2022`, `strict: true`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` on. Each package has `tsconfig.json` extending `tsconfig.base.json` with project references. `pnpm build` runs `tsc -b`.
- Vitest runs tests against TypeScript sources. Workspace packages resolve to `src/index.ts` in tests through a vitest alias, so tests never need a prior build. Unit tests sit next to sources as `*.test.ts`. Integration tests live in `test/*.int.test.ts` per package. `pnpm test` runs both. `pnpm test:unit` and `pnpm test:int` run them separately.
- Coverage is v8 through `@vitest/coverage-v8`. The core package enforces 90 percent lines, branches, functions, and statements in its vitest config, so a drop fails the run.
- ESLint flat config with `typescript-eslint` recommended type checked rules. Prettier with `printWidth: 100` and `singleQuote: true`. `pnpm lint` runs both in check mode.
- Dependencies beyond the spec's list, each flagged in section 4: `redis` (node-redis client for the Redis Streams bus), `ajv` as a dev dependency for schema validation tests. ULID generation and glob matching are hand written in core because each is under forty lines.
- `CHANGELOG.md` follows the Keep a Changelog layout with one `Unreleased` section. Each build step appends an entry when its tests pass.
- Every Markdown file passes `scripts/check-prose.sh`, which fails on any em dash (U+2014) and on a short list of banned financial terms. `scripts/check-secrets.sh` fails when any git visible file contains an Anthropic API key prefix and prints only file names and line numbers. CI runs both.

## 3. Build order

Each step ends with `pnpm lint`, `pnpm typecheck`, and the step's tests green before the next step starts.

### Step 0. Workspace scaffold

Builds: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, eslint and prettier config, vitest workspace config, `LICENSE` (MIT), `Makefile` skeleton with `install`, `build`, `lint`, `test`, `demo`, `clean` targets, empty package shells, `CHANGELOG.md`, `scripts/check-prose.sh`, `.gitignore`, `.nvmrc` (22).

Tests: `pnpm install` succeeds, lint and typecheck pass on the empty shells, the prose check passes on SPEC.md and PLAN.md.

### Step 1. `packages/core`

Builds:

- `recording/`: zod schemas for `Exchange`, `RecordedRequest`, `RecordedResponse`. A streaming JSONL reader that reports the line number of any bad line and rejects a decreasing `offset_ms`. An append-only writer with explicit `flush` and `close`. Body encoding helpers (parsed JSON when the content type is JSON, otherwise base64 with `encoding: "base64"`). Header redaction with the default list. A ULID generator.
- `jsonpath/`: a small evaluator for the subset in section 4 item A8. It supports `get(doc, path)`, `select(doc, path)` returning `[path, value]` pairs with concrete paths, and `matches(rulePath, concretePath)` for wildcard rules.
- `rules/`: zod schema and YAML loader for `diff-rules.yaml` including `substitutions`.
- `differ/`: structural JSON diff producing `Diff { verdict, findings[] }` where each finding has `path`, `reference`, `candidate`, `kind`, and `rule` when a rule tolerated it. Implements ignore, absolute and relative tolerance, keyed unordered arrays, status equivalence classes, header compare list, and substitution equivalence. Output ordering is deterministic. A `explain(diff)` function renders plain language.
- `stats/`: latency aggregation on `hdr-histogram-js` producing count, p50, p90, p99, p999, max, mean, error rate, plus fixed log spaced histogram bins for the report. Aggregated per tag and overall for both candidate and reference.
- `thresholds/`: zod schema and YAML loader for `thresholds.yaml`, an evaluator returning one row per threshold with `limit`, `measured`, and `pass`, and the overall verdict.
- `run/`: the `Run` report model (zod), its JSON Schema emitted to `packages/core/schema/run.schema.json` by a build script, and `writeRun` and `readRun` helpers.

Tests:

- Recording: valid file parses, bad JSON on line N is reported with N, decreasing `offset_ms` is rejected, write then read round trips, JSON and non JSON bodies encode as specified, redaction replaces the default headers case insensitively, ULIDs are 26 characters and sort by time.
- JSONPath: each supported token, wildcards over arrays and objects, rule matching with wildcards, a clear error for unsupported syntax.
- Differ: one test per rule type, nested structures, type changes, `null` versus missing, both tolerance kinds including the case where only one is satisfied, unordered arrays with a missing key or duplicate keys, status classes, header compare list, substitution equivalence, verdict logic for all three verdicts, deterministic output when input key order is shuffled, and `explain` text for each finding kind.
- Stats: percentiles on uniform 1 to 1000, a constant distribution, and a two point distribution within hdr precision, mean and max, error rate, per tag aggregation, histogram bins summing to the count.
- Thresholds: pass and fail for every threshold kind, the ratio threshold, a `by_tag` entry whose tag is absent, and the all must pass rule.
- Run model: a generated run validates against the emitted JSON Schema with ajv, and the emitted schema is stable (snapshot).

### Step 2. `demo/reference-service` and `demo/candidate-service`

Builds: two small fastify services sharing the same route set. `POST /v1/orders`, `GET /v1/orders/:id`, `GET /v1/inventory`, `POST /v1/inventory/:sku/adjust`. Prices are stored in integer thousandths so rounding ties are exact. Order ids come from a per process counter. Each service exports `buildApp(options)` so tests and the end to end test run them in process. The candidate reads `DIVERGENCES` (default `on`) and `DIVERGENCE_SEED` (for a deterministic delay pattern) and implements the four planted divergences. Each has a Dockerfile built from the repository root.

Tests:

- Reference: half up rounding on a tie, SKU ordered inventory, 404 on an unknown order, adjust stock never delays.
- Candidate with divergences on: half even rounding differs from the reference on tie cases and matches otherwise, insertion ordered inventory, 200 with an empty body on an unknown order, the delay fires on the seeded 5 percent of adjust calls and adds about 60 ms.
- Candidate with `DIVERGENCES=off`: a scripted scenario produces byte identical response bodies to the reference.

### Step 3. `packages/capture` and the demo load generator

Builds: the reverse proxy on Node `http` with `undici` upstream. It streams the upstream response to the caller unchanged while buffering a copy for the recording, applies tag rules and sampling, redacts headers, enforces `--max-body-bytes` (default 1 MiB) by storing an oversized body as its SHA-256, its size, and `truncated: true`, writes exchanges through the core writer, and flushes on SIGINT and SIGTERM. Also `demo/load/` which sends a few hundred requests across the four tags, including unknown order ids and tie producing orders, and `demo/recording.jsonl` produced by running load through the proxy against the reference. A `scripts/bench-capture.ts` measures p50 latency direct and through the proxy.

Tests:

- Integration against the reference app: status, headers (minus hop by hop), and body bytes through the proxy equal the direct response for JSON, text, and binary bodies and for 404 and 500 responses.
- Recording contents: method, path, query, headers, parsed JSON body, base64 body with `encoding`, `latency_ms`, non decreasing `offset_ms`, tags from rules, redaction of the default headers.
- Sampling with an injected random source records exactly the chosen subset.
- A body over `--max-body-bytes` reaches the caller intact and is recorded as hash, size, and `truncated: true`. A body exactly at the cap is stored normally.
- Upstream unreachable returns 502 to the caller and records nothing.
- Graceful shutdown: in flight requests complete and the file ends with a complete final line.
- Glob matcher unit tests for `*`, `**`, literal, and method prefixed rules.
- The committed recording validates, has a few hundred exchanges, and contains all four tags.

### Step 4. `packages/replay`

Builds: the engine with three pacing modes, a concurrency pool, filter, limit, warmup, substitutions with a dependency barrier, the `Adapter` interface, the `http` adapter, the `bus` adapter over a `MessageBus` interface with `InProcessBus` and `RedisStreamsBus`, and a `Run` writer. Latency is measured per exchange and errors are recorded. Each exchange result records its scheduled send time and actual send time, and the run records schedule slip p50 and max next to the requested and achieved rate. Caller supplied headers from `--header` and `--headers-file` are applied to every outgoing request and override recorded values. A truncated recorded body is never diffed and produces a `body_too_large` finding.

Tests:

- Pacing: `as-recorded` honors gaps within tolerance, `fixed-rate` approximates the requested rate, `max` keeps the pool full and never exceeds the concurrency.
- Filter, limit, and warmup exclusion.
- Substitutions: a value captured from an earlier candidate response replaces the reference value in a later path, body, and query; under `max` pacing the dependent request waits for the capture; the differ reports the mapped id as tolerated.
- HTTP adapter: sends method, path, query, headers, and body, omits headers whose value is `<redacted>`, applies caller supplied headers over recorded ones, measures latency, reports timeouts and connection failures as errors.
- Schedule times: every result carries `scheduled_at` and `sent_at`, and the run's slip p50 and max match the per exchange values.
- Truncated bodies: an exchange whose recorded body is truncated is sent as recorded, is not diffed on the body, and yields one `body_too_large` finding that counts as a mismatch.
- Bus adapter: request and reply through `InProcessBus` with a test responder. The same test runs against `RedisStreamsBus` when `REDIS_URL` is set.
- Integration with the committed recording against the candidate app in process: rounding mismatches appear on a subset of `create-order`, the ordering divergence mismatches under the strict rules file and is tolerated under the unordered rules file, the unknown id case mismatches on status, `adjust-stock` p99 breaches with the seeded delay, and the written run validates against the schema. With `DIVERGENCES=off` the run passes with zero mismatches.

### Step 5. `packages/report`

Builds: the terminal renderer, the HTML renderer with inline CSS and server side SVG histograms, and the JSON passthrough. The HTML includes the header, threshold table, latency section with reference versus candidate overlay per tag, percentile table, a pacing line with requested rate, achieved rate, and schedule slip p50 and max, correctness section with mismatch counts by tag, top mismatching paths, a drill down with side by side field diffs, and the agent section when present.

Tests:

- Terminal output contains the verdict, every threshold row with its measured value, the per tag table, and the pacing line with schedule slip. Snapshot.
- HTML is a single file with no external `src` or `href` to `http`, contains the header fields, one SVG per tag, every threshold row, the drill down for each mismatched exchange, and the agent section only when the run has one. Recorded strings are escaped, verified with a body containing `<script>`.
- JSON output validates against the schema and round trips.
- SVG histogram rendering is deterministic and draws one bar per bin for each series.

### Step 6. `packages/cli`

Builds: the `rp` binary on commander with `capture`, `replay`, `report`, and the `--explain` option. Exit codes follow section 4 item A13. Help text for every flag is written by hand and checked by tests.

Tests:

- `rp --help` and each subcommand's `--help` list every flag from a table in the test, with a description.
- Unknown flag and missing file exit 1 with a message on stderr.
- `replay` exits 2 on a failing run and 0 on a passing run, using the in process candidate.
- `report --explain <id>` prints the explanation for one exchange and `report --explain` prints all mismatches.
- `capture` started as a child process records traffic and exits cleanly on SIGTERM.

### Step 7. Demo packaging

Builds: `demo/docker-compose.yml`, `demo/thresholds.yaml`, `demo/diff-rules.yaml` and `demo/diff-rules-strict.yaml`, the `make demo` target, `demo/README.md` with one screenshot per divergence, `scripts/screenshots.sh`, `scripts/bench-replay.ts`, and `examples/` copies with comments. `make demo` builds and starts both services, runs load through the proxy, replays with `as-recorded` pacing under both rules files, writes `demo/out/report.html` and `demo/out/report-strict.html`, prints the terminal summary, and runs the agent when a key is present.

Tests:

- An in process end to end test with no Docker: both apps, proxy, load, replay, report. Asserts `fail` with divergences on and `pass` with them off.
- Manual verification recorded in the changelog: `make demo` on this machine with Docker, then again with `DIVERGENCES=off`, plus the measured capture overhead and replay throughput with the exact commands.

### Step 8. `packages/agent` and `rp agent`

Builds: a `ModelClient` interface with a real implementation on `@anthropic-ai/sdk` and a mock. Prompt files under `packages/agent/prompts/`. The loop from the spec: summarize, ask, validate, send to both systems, diff, keep by dedupe key, append to `generated-cases.jsonl`, stop on no new cases, budget, or max rounds. A case is a sequence of one to three requests with optional capture and substitution between its steps, and a single request is the common form. Token and dollar accounting from a static pricing table. A transcript file per run with prompt hashes, messages, usage, and cost. The no key path. The `agent` section written into the run file. The `rp agent` subcommand with its help text and the `--header` and `--headers-file` options.

After the mock tests pass, this step runs the agent for real against the demo with the key the user provides, two rounds under a two dollar budget, and writes the real transcript into `docs/agent-loop.md`.

Tests (all on the mock client):

- No key prints the message and exits 0 without constructing a client.
- Malformed cases are dropped: invalid JSON, schema violations, unknown tags, more than three steps, a substitution that names a variable no earlier step captured, a header value that is not `<redacted>` for a redacted header name.
- A two step case runs create then get on both systems with the captured id substituted on each side independently, and the diff compares the final steps.
- Dedupe by mismatching path set, a latency breach keep, stop when a round adds nothing, stop when the budget is exhausted, stop at `max-rounds`.
- Cost totals match the pricing table for given usage numbers.
- The prompt built from a recording with redacted headers never contains a real secret value, checked with a planted sentinel.
- `generated-cases.jsonl` lines validate, the run file gains an `agent` section that the report renders.
- The real client wrapper builds the expected request (model, effort, max tokens) and parses usage, tested through the SDK's `fetch` override with no network.

### Step 9. Docs, README, CI, final checks

Builds: `docs/architecture.md`, `docs/report-format.md`, `docs/writing-adapters.md`, `docs/agent-loop.md`, `README.md` in the spec's order with the Mermaid diagram and screenshots, `.github/workflows/ci.yml`, and a final pass on CHANGELOG.md.

Tests: prose check on every Markdown file, a banned term scan over the whole tree, full `pnpm lint`, `pnpm typecheck`, `pnpm test` with coverage, and `pnpm build`. The CI workflow is checked by reading it against the local commands. It runs for real only after a push.

## 4. Ambiguities and the resolution I will apply

Each item names the default. Reply with the item id to change one.

**A1. Node 22 versus Node 26.** Build targets `>=22`. CI pins 22. I avoid APIs newer than 22.

**A2. pnpm install.** I install pnpm 10 globally with npm. This is the one change to the machine outside the repository.

**A3. `--tag-rule` syntax.** The spec says path glob to tag. I use `--tag-rule '<glob>=<tag>'`, repeatable, with an optional method prefix such as `'POST /v1/orders=create-order'`. The first matching rule wins. Unmatched exchanges get an empty `tags` array. Globs support `*` within a segment and `**` across segments.

**A4. Body representation.** A missing or zero length body omits the `body` field. A JSON content type stores the parsed value. Anything else stores base64 with `encoding: "base64"`. A JSON content type whose body fails to parse is stored as base64 so capture never fails on bad upstream data.

**A5. Latency definitions.** Capture `latency_ms` is the time from forwarding the request upstream to receiving the last upstream body byte, so it excludes proxy work. Replay latency is the time from dispatching the request to receiving the last body byte, measured with `performance.now()` around the undici call. This is the closest practical reading of first byte sent to last byte received without socket level hooks. The first request on a fresh connection includes connection setup, which warmup absorbs.

**A6. Capture overhead measurement.** Overhead is p50 through the proxy minus p50 direct, measured by `scripts/bench-capture.ts` at concurrency 8 over 5000 requests after 500 warmup requests against the reference service in Docker. The README reports both p50 values, the difference, and the command.

**A7. Diff rules are global.** The rules file has no per tag scope. The ordering divergence is shown with two rules files as the spec describes. Per tag scoping is not built.

**A8. JSONPath subset.** Supported: `$`, `.name`, `['name']`, `[n]`, `[*]`, `.*`. Not supported: recursive descent, slices, filters, unions. Unsupported syntax fails at rules load time with the offending path.

**A9. Tolerance semantics.** A numeric pair is tolerated when `|a - b| <= max(abs, rel * max(|a|, |b|))`, which is the usual `isclose` rule. A tolerance on a non numeric value is a mismatch.

**A10. Verdict semantics.** Paths under `ignore` are removed before comparison and produce no finding. A tolerated finding records which rule tolerated it. `match` means no findings. `tolerated` means every finding was tolerated. `mismatch` means at least one finding was not. Headers are compared only when listed under `headers.compare`. The default is no header comparison.

**A11. Substitutions.** The rules file gains a `substitutions` list. Each entry has `name`, `capture: { tag, path }`, and `apply: ["path", "body", "query"]`. When an exchange carrying the capture tag completes, the engine reads the value at `path` from the reference response and from the candidate response and stores the pair. Later requests have any occurrence of a stored reference value replaced with its candidate value in the chosen locations. The engine computes dependencies before sending, so a dependent request waits for its producer under any pacing mode. The differ treats a stored pair as equivalent and records the finding as tolerated by `substitution:<name>`.

**A12. Flags not in the spec's command lines.** `rp replay` takes `--rules` and `--thresholds`. `rp agent` takes `--reference`, `--rules`, `--thresholds`, `--out` (default `generated-cases.jsonl`), `--cases-per-round` (default 8), and `--model` (default `claude-opus-5-5`). `rp replay` takes `--adapter http|bus` and `--bus-url`.

**A13. Exit codes.** `rp replay` exits 2 when thresholds fail. `rp report` exits 0 after a successful render regardless of verdict, since its job is rendering. `make demo` tolerates exit code 2 from replay so the report is still produced and `make demo` itself exits 0 as the acceptance criteria require.

**A14. `--explain`.** It lives on `rp report`. `rp report --run run.json --explain <exchange-id>` explains one exchange. Without an id it explains every mismatched exchange.

**A15. The JSON report is `run.json`.** The replay output is the canonical JSON report. `rp report --format json` validates it and re-emits it pretty printed.

**A16. Warmup.** The first N exchanges after filtering are executed but excluded from latency stats and correctness counts.

**A17. Errors.** An error is a transport failure or timeout with no candidate response. Errors count toward the error rate, are excluded from latency stats, and are not diffed. A candidate 5xx with a body is a response and is diffed like any other.

**A18. Missing tag in `by_tag` thresholds.** The row fails with measured value `n/a`. Silent passing would hide a filter mistake.

**A19. Threshold metric names.** Any of `p50, p90, p99, p999, max, mean` is accepted with the `_ms` suffix for absolute limits and the `_ratio_max` suffix under `relative_to_reference`. The spec shows `p50_ms`, `p99_ms`, and `p99_ratio_max`, and the others follow the same shape.

**A20. Redacted headers on outgoing requests.** Replay and the agent omit any header whose recorded value is `<redacted>`. `rp replay` and `rp agent` accept `--header 'name: value'`, repeatable, and `--headers-file <path>` with one `name: value` per line. Supplied headers are applied to every outgoing request and override recorded values. The docs state that this is the expected way to replay against an authenticated candidate.

**A21. Bus adapter shape.** `MessageBus` has `publish(topic, message)` and `subscribe(topic, handler)`. The adapter publishes a request envelope with a correlation id to a topic derived from the request path and awaits the reply envelope. `RedisStreamsBus` uses `XADD` and `XREAD`. The responder contract is documented in `docs/writing-adapters.md`. The demo does not run the bus. The dependency is `redis`.

**A22. Model and safety handling.** The default model is `claude-sonnet-5-5` with `output_config.effort` set to `medium` and `max_tokens` 8192. `--model` overrides it. A response with `stop_reason: "refusal"` counts as a round with zero cases and is logged in the transcript. The server side fallback parameter is not enabled.

**A23. Model output format.** The model is asked for a JSON object in plain text. The response is parsed and validated with zod. I do not use the structured outputs API, so the `ModelClient` interface stays a plain text contract that the mock can satisfy.

**A24. Agent results location.** `rp agent` writes `generated-cases.jsonl` and updates the file given by `--run` in place with an `agent` section. `rp report` is then run again to include it. The demo does exactly this.

**A25. No key check.** `rp agent` first loads `./.env` with a small parser in the CLI package (no dependency) and sets only variables that are not already set. The check is then the literal presence of `ANTHROPIC_API_KEY`, as the spec states. The SDK also accepts other credential sources, and the README notes that only the environment variable enables the agent in this tool. The `make demo` recipe sources `.env` in the shell before calling the agent.

**A26. Dedupe keys.** A mismatch case keys on the sorted set of untolerated finding paths. A latency case keys on `latency:<scope>:<metric>`.

**A27. Latency breach for a single case.** A case breaches when its candidate latency exceeds the `_ms` limit for its tag or the overall limit. Ratio thresholds are not evaluated for single cases.

**A28. Generated case schema.** A case has `hypothesis`, `tags` (one of the tags present in the recording), and `steps`, a list of one to three entries. Each step is a `RecordedRequest` plus an optional `capture` of `{ name, path }` read from that step's response and an optional `use` list naming earlier captures to substitute into the step's path, query, and body as `{{name}}`. Captures are resolved separately on the reference and the candidate, so a create then get sequence reads each system's own id. The diff and latency come from the final step. A single step case is the common form. Anything outside this shape is discarded.

**A29. Vendor names.** The stack names the spec requires (Node, pnpm, Docker, Redis, GitHub Actions, Anthropic) appear where needed. No other company or product names appear.

**A30. Three item rhetorical lists.** I read this as a ban on triplet phrasing such as "fast, simple, reliable". Lists of facts may have any length.

**A31. Screenshots.** `scripts/screenshots.sh` renders `demo/out/report.html` with headless Chrome to PNGs under `docs/images/`. The PNGs are committed so the README works on GitHub.

**A32. Order ids in the demo.** Both services use a per process counter. With concurrency the replay creation order can differ from capture order, which is what the substitution feature handles. The agent's single request cases can reference ids that exist on one system and not the other, and `docs/agent-loop.md` names this as a noise source.

**A33. Histogram data in `run.json`.** Each tag and the overall entry stores 48 log spaced bins from 0.1 ms to 10 s for candidate and reference, so the HTML renders without the histogram library.

**A34. Capture timestamp.** `ts` is the time the proxy received the request.

**A35. Large bodies.** The proxy streams every body to the caller unchanged. `--max-body-bytes` on `rp capture` defaults to 1 MiB. A body over the cap is recorded as `{ sha256, size, truncated: true }` in place of content. Replay never diffs a truncated body and emits one finding of kind `body_too_large`, which counts as a mismatch so it is visible in the report.

**A36. Schedule slip.** Under `as-recorded` and `fixed-rate` pacing, a saturated pool delays sends. Each exchange result records `scheduled_at` and `sent_at`. The run records slip p50 and max, and the report shows them next to the requested and achieved rate. No correction is applied.

**A37. Docker build context.** Both Dockerfiles build from the repository root so the pnpm lockfile is shared. Images contain only the one service and its production dependencies.

**A38. Headless mode for `make demo` without the agent.** CI runs `make demo` with no key, which takes the no key path and exits 0.

## 5. Requirements I think should change

**R1. The `unordered` rule in the spec is not valid YAML.** A list item string followed by `key:` on the next line does not parse. I will use a list of objects:

```yaml
unordered:
  - path: '$.items'
    key: '$.sku'
```

**R2. `rp report` exit code.** The spec gives one exit code table for the tool. I apply 2 only to `rp replay` (item A13). If you want `rp report` to also exit 2 on a failed run for CI pipelines that gate on the rendered report, say so and I will add it to both.

**R3. Capture overhead under 1 ms p50.** This is a hardware dependent claim. I will measure it as described in A6 and report the number. If the measured value is over 1 ms on this machine I will report that plainly rather than tune the benchmark.

**R4. Agent acceptance criterion.** "At least one kept case per planted divergence that is reachable through request variation" cannot be verified without a key. The rounding and unknown id divergences are reachable from single requests. The ordering divergence is reachable only under the strict rules file. The latency divergence fires on 5 percent of calls, so a kept case depends on chance within the budget. I suggest the criterion read "rounding and unknown id at minimum", which the spec already says in parentheses, and treat the other two as best effort.

**R5. Real transcript in `docs/agent-loop.md`.** Accepted with a change: the user sets `ANTHROPIC_API_KEY` before step 8, the agent runs for real in that step, and the real transcript goes into the document then.

**R6. Agent noise from stateful ids.** Accepted. A generated case may be a sequence of one to three requests with capture and substitution within the case, per A28.

## 6. What I cannot verify here

- The GitHub Actions workflow. There is no remote. I will write it to mirror the local Makefile targets and it runs on the first push.
- The 1 ms overhead claim on "the demo hardware" is measured on this machine and stated as such.

## 7. Process

- After each step: lint, typecheck, the step's tests, then a CHANGELOG.md entry.
- I will not add features outside SPEC.md. Items in section 4 are interpretations of existing requirements, and each names a default so you can veto it.
- All prose in docs and README uses plain declarative sentences and contains no em dash. `scripts/check-prose.sh` enforces the em dash rule mechanically.
- Git workflow: one conventional commit on `main` at the end of each step. No branches, no PR flow, no push. Recorded in project memory.

## 8. Addendum A plan

Addendum A inserts after Step 3. The revised order is 3b, A2, 4, A1, A4, 5, 6, 7 with A3, 8, 9 with A5. This section covers each inserted item in that order and ends with a table of existing tests that change. Decisions that need your approval are numbered D1 to D14. Each names a default.

### 8.1 Step 3b: order lifecycle in the demo services (A0)

**Changes to existing packages.** Both demo services gain the lifecycle routes identically, with the `app.ts` files still differing only at marked lines.

- `POST /v1/orders` reads `Idempotency-Key`. The key maps to a payload hash and the original response. Same key and payload replays the stored response with no effect. Same key and a different payload returns 409 `idempotency_conflict`.
- `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/quantity`, `POST /v1/orders/:id/shipments`, and `GET /v1/ledger` are added as specified.
- Order status values become `OPEN`, `PARTIALLY_SHIPPED`, `SHIPPED`, `CANCELED`, and `REJECTED`. `PENDING` is accepted by the schema and documented as reserved for asynchronous allocation. The demo services allocate synchronously and never produce it.
- Stock on hand changes only on accepted shipments and on `adjust-stock`. Order creation allocates against available stock (on hand minus open allocations) and no longer decrements on hand. Cancellation releases unshipped allocation.
- Each service gets a `store.ts` holding orders, shipment ids, idempotency keys, stock, and receivables. With `STORE_PATH` set, every mutation is written to that JSON file. Without it, the store keeps a separate in memory durable copy. Two admin routes are added to both services: `POST /admin/restart` drops in memory state and reloads from the store, and `POST /admin/reset` returns the service to its initial state. The first makes the restart test possible without orchestration. The second is the reset hook that shrinking needs (8.6).
- The candidate's divergence switch changes from a boolean to a named set in preparation for A3. `DIVERGENCES` accepts `on` (the original four, now named `rounding-half-even`, `inventory-insertion-order`, `adjust-stock-delay`, `unknown-order-200`), `off`, or a comma separated list of names. An unknown name exits 1 at startup.
- The load generator gains the lifecycle scenarios from the A5 table (full shipment, partial shipments, duplicate delivery, cancel before shipment, partial then cancel, partial then quantity change, ship and cancel race, out of order shipments, stock rejection, retry with the same idempotency key, retry of a timed out submit, restart around a ledger read). It reads `GET /v1/ledger` periodically and ends with `GET /v1/ledger` plus `GET /v1/orders/:id` for every order it created, so the recording carries the reference's final observed state. New tags: `cancel-order`, `set-quantity`, `ship-order`, `list-ledger`, `admin-restart`.
- `demo/recording.jsonl` is regenerated. `scripts/check-prose.sh` drops `ledger` from the ban list because the route name is now mandated across code, tests, the recording, and docs.
- Harness control tags. Exchanges tagged `admin-restart` and `admin-reset` are harness controls, not workload. They are excluded from latency statistics and from latency thresholds, and they are diffed on status only. The tags are declared in the rules file under `controls.tags` with that default, the stats collector skips them for latency, and the differ compares only the status for them. The report lists them in the exchange drill down with a control marker and never in the per tag latency tables. This lands with the engine in step 4, since the tags only exist in the recording until then.
- `scripts/check-parallel.sh` asserts that the two `app.ts` files differ only in hunks that carry a `DIVERGENCE` or `DEFECT` marker, and that `store.ts` and `catalog.ts` are identical. The candidate's `app.ts` is derived from the reference's by applying the marked lines, so the guard keeps A0's rule mechanical.

**New.** No new package. New modules in both services (`store.ts`, `lifecycle.ts`) and new scenario kinds in `demo/load`.

**Existing tests that change.** `demo/reference-service/src/app.test.ts` and `demo/candidate-service/src/app.test.ts` (status values, stock semantics, the divergence option shape, the parity scenario extended to every lifecycle route), `demo/load/src/scenario.test.ts` (new kinds and tags). `packages/capture/test/proxy.int.test.ts` keeps passing because `total` and `order_id` keep their meaning.

**Collisions.**

- **D1. The word `total`.** The spec's recording example uses `total` for the amount (29.97) and the rounding divergence depends on it. A0 lists `total` among quantities. Default: `total` stays the amount. Quantities are `quantity` (effective total quantity), `shipped`, `remaining`, and `canceled_unshipped`. A0's "total quantity" maps to `quantity`.
- **D2. Insufficient stock on creation.** Today this is 409 with no order. Invariants 7 and 10 need a rejected order that exists and can be fetched. Default: 201 with `status: "REJECTED"` and nothing allocated.
- **D3. Cancellation acceptance time.** If pre cancel shipment events were judged against server wall time, every recorded event would look pre cancel during replay, since the replay happens later. Default: the cancel request carries its own `originated_at`, the server records it as the acceptance time, and shipment events compare against it. This is deterministic across capture and replay.
- **D4. Quantity increase beyond available stock.** A0 only forbids going below shipped. Default: an increase that exceeds available stock returns 409 `insufficient_stock`.
- **D5. Receivables precision.** Default: receivables are the exact sum of quantity times unit price in thousandths, rendered as a decimal string with three places. No rounding, so both services agree and the rounding divergence stays confined to order `total`.
- **D6. Restart mechanism.** Default: the in process `POST /admin/restart` reload described above, called by the load generator so the recording carries the restart and the replay repeats it against the candidate at the same point. The alternative is a real container restart between two replay invocations, which needs substitution state carried across runs and a reconnect grace period in the adapter. I recommend the default and the integration test still performs a true restart in process by closing the app and rebuilding it on the same `STORE_PATH`.

### 8.2 A2: INCONCLUSIVE in core

**Changes to existing packages (core).**

- `Run.verdict` becomes `pass | fail | inconclusive`. A new `inconclusive` array lists triggering conditions, each with `kind` in `barrier_timeout`, `snapshot_before_ack`, `schedule_not_held`, `insufficient_samples` and a `detail` string. The report names them.
- `ThresholdResult.pass: boolean` becomes `outcome: pass | fail | inconclusive`. The evaluator's verdict becomes tri state.
- Thresholds schema gains `latency.min_samples` (default 1) with an optional per block override inside `overall` and each `by_tag` entry, and a new `pacing` section with `slip_max_ms` (optional). `min_samples` counts successful candidate samples.
- Evaluator semantics change. A latency row with fewer successful samples than its minimum is `inconclusive` with the counts in `detail`. A `by_tag` entry whose tag is absent is `inconclusive` rather than `fail` (this reverses A18, since "could not decide" is the accurate description). A correctness row with zero compared exchanges is `inconclusive`. A ratio row with a zero reference value stays `fail` because that is a measured fact about the data, not a harness limitation.
- `packages/core/schema/run.schema.json` is regenerated. `testing.ts` fixtures gain the new fields.
- The run model gains `pacing.barrier_timeout_ms`, `pacing.barrier_waits`, and per exchange `acked_at_ms`, which step 4 fills and the snapshot check (8.4) reads.
- Exit codes: 0 pass, 2 fail, 3 inconclusive, 1 tool error. Applies to `rp replay` and later to `rp invariants`.

**New.** `packages/core/src/run/verdict.ts` with the precedence rule below. No new package.

**Existing tests that change.** `thresholds/evaluate.test.ts` (no sample rows, missing tag rows, new `min_samples` and `pacing` cases), `thresholds/schema.test.ts`, `run/io.test.ts` (schema sync, the enum, the new section), `testing.ts`.

**Collisions and decisions.**

- **D7. Precedence.** Default: a run level condition (`barrier_timeout`, `snapshot_before_ack`, `schedule_not_held`) makes the run `inconclusive` even when mismatches were observed, because those mismatches may be artifacts. Otherwise any failed threshold or invariant makes it `fail`. Otherwise any `insufficient_samples` row makes it `inconclusive`. Otherwise `pass`. The report shows the observed mismatches in every case.
- **D8. Schedule held.** Default: `pacing.slip_max_ms` in the thresholds file. When set and the run's maximum schedule slip exceeds it, the run is `inconclusive` with `schedule_not_held`. When unset, slip is reported but never triggers. This applies to replay pacing. The capture time load generator is outside the verdict.

### 8.3 Step 4 additions for the addendum

The replay engine plan in section 3 stands, with these additions.

- `--barrier-tag <tag>` (repeatable) and `--barrier-timeout-ms` (default 10000). Before sending an exchange with a barrier tag, the engine waits until every earlier selected exchange has a response or a terminal error. A timeout records `barrier_timeout`. Completion is acknowledged commands, not silence. The demo uses `--barrier-tag list-ledger --barrier-tag admin-restart`.
- `--candidate-recording <path>` writes the requests as sent and the candidate responses as a second JSON Lines recording in the same format. This is the candidate's observed log for A1 and it keeps `run.json` small.
- Each result records `sent_at_ms` and `acked_at_ms`.
- Substitutions already cover the new routes because order ids appear in the path. Shipment ids and idempotency keys are client supplied and are replayed as recorded.

### 8.4 A1: independent invariants

**New.** `packages/invariants`. It depends on core only. Inputs for one system are that system's recording (the reference recording, or the candidate recording from 8.3) and nothing else. It never sees the other system.

- `commands.ts` maps exchanges to commands by method and path: create, cancel, set quantity, shipment, adjust stock, restart, and reads (order, ledger). Expected state is computed from the commands and each system's own acknowledgements.
- `snapshot.ts` selects the observed state: the last `GET /v1/ledger` and the last `GET /v1/orders/:id` per order, plus every intermediate ledger read for interval checks.
- `rules/` holds the ten invariants, one file each, each returning `holds | violated | not_applicable | inconclusive` with evidence (order id, shipment id, expected and observed values). Operationalization: invariant 1 and 5 compare stock deltas between consecutive ledger reads with unique accepted shipments and adjustments in that interval, so a duplicate application is localized to an interval. Invariant 4 uses the quantity from the last accepted quantity command, which is what catches `quantity-as-additional`, and expects pre cancel events to be applied, which is what catches `drop-late-precancel-shipment`. Invariant 8 and 9 compare order counts and effects across retries, including across the restart command. Invariant 10 recomputes the allocation decision from the reconstructed stock at each create.
- Completion check: if any command was acknowledged after the final snapshot read was sent, the snapshot predates it and the result is `inconclusive` with `snapshot_before_ack`. With the barrier in place this cannot happen in a healthy run, and the condition is still checked and named.
- `evaluateInvariants(recording) -> InvariantReport` and `rp invariants --recording <path> [--out <json>]` for one system. `rp replay --invariants` runs it on both recordings after the barrier and writes the `invariants` section of `run.json` with `reference` and `candidate` arrays. The report (step 5) renders that section above the diff.

**Changes to existing packages.** Core gains the `invariants` section in the run model and schema. The thresholds schema gains `invariants: { fail_on_violation: true }` so a violation is a `fail` by default and can be demoted to a reported finding. The replay engine gains the `--invariants` flag.

**Existing tests that change.** `run/io.test.ts` and `testing.ts` for the new section. `thresholds/schema.test.ts` for the new key.

**Collisions.**

- **D9. Candidate response bodies.** `ExchangeResult` stores only status and latency for the candidate. Default: the candidate recording from 8.3 carries the bodies, and `run.json` references it by path. The alternative of embedding bodies in `run.json` roughly doubles its size and mixes the two systems' logs.
- **D10. Invariant 5 and adjust stock.** The existing `adjust-stock` tag changes stock on hand. Default: invariant 5 reads "initial stock plus accepted adjustments minus unique accepted shipments". The docs state this extension.

### 8.5 A4: shrinking

**New.** `packages/shrink`. It depends on core, replay, and invariants.

- Input: a failing run, its recording, the candidate target, a reset hook, and the failing rule (an invariant id or a mismatch path). Default rule: the first violated invariant, else the first mismatching exchange.
- Algorithm: delta debugging (ddmin) over the ordered list of exchanges that the failing rule depends on, followed by a second pass that lowers `quantity` and `qty` values toward 1. Each candidate reduction is replayed against a reset candidate and judged by the same rule. Prerequisites are enforced by construction: an exchange that references an order id is never kept without that order's create, shipment ids are never renamed, relative order is never changed, and the barrier tags stay.
- Bounds: `--max-attempts` (default 64) and `--time-budget-ms` (default 120000). An attempt whose replay is inconclusive counts as not reproduced.
- Output: `reduced-reproduction.jsonl` and a `reproduction` section in `run.json` with `rule`, `original_steps`, `reduced_steps`, `attempts`, `successful`, and the steps. If no attempt reproduces, the original is kept and `successful` is false with the label `reduction unsuccessful`. The report and docs say "reduced reproduction" and never "minimal".
- CLI: `rp shrink --run run.json --recording recording.jsonl --target <url> --reset <url> [--rule <id>]`. `make demo` runs it after the defect run.

**Changes to existing packages.** Core gains the `reproduction` section. The replay engine exposes a library entry point that replays an exchange list against a target and returns a run without writing files, which shrinking calls per attempt.

**Collisions.**

- **D11. Reset between attempts.** Shrinking needs a candidate in its initial state for every attempt. Default: `--reset <url>` posts to the candidate's `POST /admin/reset` from 8.1. The in process tests reset by rebuilding the app. A real system would supply its own reset endpoint or a script, and the docs say so.

### 8.6 A3: seeded defects (in step 7)

**Changes to existing packages.** The candidate gains four named defects, each one marked line in `app.ts` or `store.ts`: `shipment-applied-twice` (a repeated shipment id is applied to stock and shipped quantity again while the original response is returned), `quantity-as-additional` (the quantity command adds instead of sets), `drop-late-precancel-shipment` (a shipment that originated before cancellation but arrives after it is rejected), `idempotency-lost-on-restart` (idempotency keys are not written to the store, so a retried create after the restart makes a second order). The switch mechanism is the named set from 8.1, so nothing else changes.

**New.** `fixtures/defects/<name>/cause.md` for each, naming the mechanism, the marked line, and the invariant or diff rule expected to catch it. A test per defect that runs the lifecycle scenario in process with only that defect enabled and asserts the named invariant reports `violated` on the candidate and `holds` on the reference. A test that the clean pair holds every invariant on both sides.

**`make demo` flow.** Three replays. First the original four divergences, which fails on the four planted differences as before. Then the clean pair with `DIVERGENCES=off`, which passes and shows the invariants holding on both sides. Then one defect, `shipment-applied-twice` by default, which fails on invariants 1 and 5, followed by `rp shrink` and the reduced reproduction in the report. `DEMO_DEFECT` selects a different defect.

**Agent exclusion.** The agent's inputs are explicit files: the run, the recording, the rules, and the thresholds. It never reads the repository tree. A test plants a sentinel in a `cause.md` and asserts the sentinel never appears in any prompt the agent builds.

**Collisions.** The boolean `divergences` option and `DIVERGENCES=on|off` from Step 2 are replaced in 8.1. The existing candidate tests that pass `divergences: false` change to the named set.

### 8.7 A5: docs/oms-mapping.md (in step 9)

**New.** `docs/oms-mapping.md` with the three parts the addendum lists. The README links it in one sentence after the demo section.

**What the guard bans today.** `scripts/check-prose.sh` fails on an em dash in any Markdown file, and on the 24 whole words held in the `banned` variable of the script, case insensitive, in every Markdown, TypeScript, JavaScript, JSON, YAML, HTML, shell, Makefile, and Dockerfile in the tree. The list covers the vocabulary of accounts, markets, and billing, and `ledger` was on it. The script and the lockfile are skipped. The guard currently fails on SPEC.md at two lines of the addendum, both for `ledger`, and it will fail on this plan for the same word until 3b lands.

**How the exemption will work.**

- A `banned_exempt` list in the script, holding `./docs/oms-mapping.md`. The banned term loop skips a file whose path is in that list. The em dash check keeps running on it, and the plain declarative sentence rule still applies to its prose.
- `ledger` leaves the ban list in 3b, since A0 mandates the route name everywhere. Every other word stays banned outside the exempt file.
- A test in step 9 runs the script against a temporary tree with a banned word in the exempt file (passes) and in another file (fails), so the exemption cannot widen silently.
- **D12.** Default: the exemption is by exact path, not by directory, so a second document cannot inherit it.

### 8.8 Existing tests that change, by step

| Step | Test file                                       | Change                                                                                              |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 3b   | `demo/reference-service/src/app.test.ts`        | status values, stock semantics, rejected orders, new routes, store and restart                      |
| 3b   | `demo/candidate-service/src/app.test.ts`        | named divergence set, parity scenario over every lifecycle route, restart parity                    |
| 3b   | `demo/load/src/scenario.test.ts`                | new kinds, new tags, final snapshot reads                                                           |
| A2   | `packages/core/src/thresholds/evaluate.test.ts` | no sample and missing tag rows become inconclusive, `min_samples`, `pacing.slip_max_ms`, precedence |
| A2   | `packages/core/src/thresholds/schema.test.ts`   | new keys                                                                                            |
| A2   | `packages/core/src/run/io.test.ts`              | verdict enum, new sections, regenerated schema                                                      |
| A2   | `packages/core/src/testing.ts`                  | fixture fields                                                                                      |
| A1   | `packages/core/src/run/io.test.ts`              | `invariants` section                                                                                |
| A4   | `packages/core/src/run/io.test.ts`              | `reproduction` section                                                                              |
| A3   | `demo/candidate-service/src/app.test.ts`        | one test per defect                                                                                 |
| A5   | none existing                                   | new guard test                                                                                      |

### 8.9 Approval record

Approved on 2026-10-16 with all defaults D1 to D14 and the harness control rule above. Step 3b runs next and stops for review before A2.

### 8.10 Two more decisions

- **D13. Demo thresholds.** The clean pair must pass. Default: `latency.min_samples: 20` overall and per tag, `pacing.slip_max_ms: 250`, and `invariants.fail_on_violation: true` in `demo/thresholds.yaml`, with the absolute latency limits set after measuring in step 7 so that the clean pair passes with margin in Docker.
- **D14. Ordering of A3 code.** The addendum places the defect catch in step 7. The four marked lines are small and sit in code written in 3b. Default: write the marked lines and their unit tests in 3b, since the lifecycle code is open then, and write the fixtures, the demo flow, and the shrink integration in step 7. Say so if you want the candidate untouched by defects until step 7.
