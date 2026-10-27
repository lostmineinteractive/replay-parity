# Enhancements, round two

This document proposes the work that turns replay-parity from a complete portfolio build into a tool an engineering organization can run against production systems, on a schedule, with confidence in the verdict. It was written after reading every package, the demo, the scripts, the CI workflow, the docs, `PLAN.md`, `CHANGELOG.md`, and `DEFERRED.md` at commit `62046e5`. Every "today" statement below names the file it comes from so it can be checked.

The proposals keep the decisions that make the tool what it is: JSON Lines recordings, diff rules as data, three verdicts with distinct exit codes, independent invariants shown above the diff, a reduced reproduction that is never called minimal, and an HTML report with no script and no external resource. Nothing here asks for a rewrite. Each item extends an existing seam.

## Where the repository stands

| Area       | Today                                                                                                                                                  | Source                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Packages   | Eight workspace packages, all `private: true`, version `0.1.0`, no publish step, no `rp` image                                                         | `packages/*/package.json`, `.github/workflows/ci.yml`                       |
| Tests      | 49 test files, about 390 tests, 95 percent line coverage overall, a 90 percent gate on `core` only, Node 22 only, Linux only                           | `vitest.config.ts`, `coverage/coverage-summary.json`, `ci.yml`              |
| Capture    | HTTP/1.1 reverse proxy, header redaction, per request random sampling, one output file, whole request body buffered before forwarding                  | `packages/capture/src/proxy.ts`                                             |
| Replay     | Whole recording read into memory, every exchange result kept in memory and written into `run.json`, one candidate per run, one `tag=` filter           | `packages/replay/src/engine.ts`, `packages/cli/src/commands/replay.ts`      |
| Rules      | Global rules, numeric tolerances only, a six form JSONPath subset, substitutions captured from bodies only                                             | `packages/core/src/rules/schema.ts`, `packages/replay/src/substitutions.ts` |
| Thresholds | Latency per tag, ratio to reference overall only, error rate overall only, no baseline comparison                                                      | `packages/core/src/thresholds/evaluate.ts`                                  |
| Invariants | Ten rules hard wired to the demo's order lifecycle                                                                                                     | `packages/invariants/src/rules/*`                                           |
| Agent      | One provider, free text JSON parsed from the answer, a static price table with three entries, kept cases written in a format `rp replay` cannot read   | `packages/agent/src/*`                                                      |
| CLI        | Flags only, no config file, no preflight, version string hard coded apart from `package.json`, `rp report` always exits 0                              | `packages/cli/src/*`                                                        |
| Security   | Header redaction, a secrets guard that matches one prefix, no SBOM, no dependency audit, no `permissions` block in CI, actions pinned by major version | `scripts/check-secrets.sh`, `ci.yml`                                        |
| Docs       | Architecture, report format, adapters, agent loop, OMS mapping, demo walkthrough; no operations guide, no security policy, no contributing guide       | `docs/`, repository root                                                    |

## What enterprise grade means for this tool

The word is used here to mean nine concrete properties. Each enhancement below names the property it serves.

1. **Runs against real traffic.** Recordings of millions of exchanges, sessions that interleave, bodies that carry personal data, TLS in both directions.
2. **Attributable verdicts.** A FAIL names a difference that is the candidate's and not the harness's. Noise is measured, not assumed away.
3. **Fits a pipeline.** Config in files, secrets from the environment, machine readable output in formats CI already understands, exit codes that mean one thing.
4. **Observable while it runs.** Progress, structured logs, traces, and a way to stop cleanly with a partial result.
5. **Extensible without a fork.** Adapters, invariants, and matchers load from outside the repository.
6. **Secure by default.** Redaction that covers bodies and query strings, supply chain checks, signed artifacts, a stated threat model.
7. **Supported.** Published packages, versioned releases, migration paths for the formats, a support matrix.
8. **Proven.** Property based tests on the differ and the parser, fuzzing, performance gates, a wider platform matrix.
9. **Documented for operators.** How to run it, what can go wrong, what the numbers mean, who to call.

## Enhancements

Sizes are for one engineer: S is up to three days, M is one to two weeks, L is three weeks or more. Dependencies between items are named where they exist.

### E1. Capture for production traffic

**Today.** `packages/capture/src/proxy.ts` reads the whole request body before forwarding, keeps every response chunk of a sampled exchange in memory before the size cap is applied, samples each request independently with `this.random() < this.sample`, listens on plain HTTP, redacts headers only, and writes one file that grows until the process stops. The recording has no header line, so nothing in the file says which tag rules, redaction list, target, or tool version produced it.

**Proposal.**

- Session aware sampling. `--sample-by <header|cookie|jsonpath>` hashes a session key and keeps or drops whole sessions, so a sampled recording still contains the create before the get. Random per request sampling stays as the fallback and the CLI warns when substitution rules are present and per request sampling is in use.
- Streaming bodies. Forward request bodies as they arrive and tee them into the recorder. Hash and count response bytes as they stream and stop buffering once the cap is passed, so a large response costs the cap and not its size.
- Body and query redaction. `redact.body: ['$.card.number', '$.customer.email']` and `redact.query: [api_key, token]` in a capture rules file. Two modes per path: `drop`, which replaces the value with the marker, and `hash`, which replaces it with a keyed HMAC so equality across exchanges survives and substitutions still work. The key comes from `RP_REDACTION_KEY` and is never written to the recording.
- TLS. `--tls-cert` and `--tls-key` for the listener, `--upstream-ca`, `--upstream-cert`, `--upstream-key`, and `--upstream-insecure` for the target. The HTTP adapter gets the same upstream flags (E7).
- Rotation and compression. `--rotate-bytes`, `--rotate-interval`, and `--gzip`, producing `recording.0001.jsonl.gz` files that the reader opens transparently. `--max-exchanges` and `--duration` end a capture on their own.
- A manifest line. The first line of a recording is `{"manifest": 1, "tool_version", "created_at", "target", "tag_rules", "redaction", "sample", "session_key"}`. The reader accepts files without one and `rp recording migrate` adds one.
- Importers. `rp import --from har`, `--from envoy-tap`, and `--from otel-spans` produce recordings from sources an organization already has when it cannot put a proxy in front of the reference. HAR is the first because browser tooling and most API gateways export it.
- Library form. Export the recorder as a Fastify and an Express plugin so a team that owns the reference can record in process without a proxy hop.

**Acceptance.** A 10 GB capture with a 1 MiB cap runs in under 512 MB of resident memory. A sampled recording at 10 percent replays with zero substitution misses on the demo load. A recording with a manifest and one without both replay. The redaction tests show that a hashed order id substitutes correctly.

**Size.** L. Session sampling, streaming, and redaction are the first three to land.

### E2. Recording format v2 and recording tools

**Today.** `packages/core/src/recording/types.ts` stores JSON bodies parsed, so `1.0` becomes `1` and integers above 2^53 lose precision. `run.json` records the recording path and count but not a hash, so a run cannot be tied to the exact file it replayed. There is no command that validates, filters, samples, splits, merges, or inspects a recording.

**Proposal.**

- Lossless numbers. Parse bodies with a lossless JSON parser that keeps the source text of numbers, store numbers whose round trip would change as `{"$num": "1.0"}`, and teach the differ to compare them by value with the tolerance rules. The demo ledger already uses decimal strings for this reason; the format should not force every system to.
- A `recording_sha256` field on `run.json` and the manifest. `rp report` shows it and `rp shrink` refuses to run against a recording whose hash differs from the run's.
- `rp recording` subcommands: `validate`, `stats` (exchanges by tag, status, method, body size, gaps), `filter` (by tag, method, path glob, status, time window, with `--include-dependencies` so producers of substituted values come along), `sample --by-session`, `split` and `merge` (by time or by session, keeping `offset_ms` non decreasing), `anonymize` (applies E1 redaction rules to an existing file), and `diff` (two recordings compared exchange by exchange under the rules).
- Schema versioning with migration. `schema_version` on the run and `manifest` on the recording each get a `migrate` path so a run written by version N opens in version N+1. Today `RunSchema` is strict on `schema_version: 1` and will reject every future file.

**Acceptance.** The committed demo recording round trips through `rp recording migrate` byte for byte apart from the manifest line. A body with `12345678901234567890` compares equal to itself after a replay.

**Size.** M. Depends on E1 for the manifest and redaction rules.

### E3. Replay at scale

**Today.** `replay()` in `packages/replay/src/engine.ts` calls `readRecording`, which materializes the file. `results` holds every exchange result and `run.json` embeds them all, so a run over a million exchanges writes a file of several gigabytes and the HTML report renders every mismatched exchange with no cap. A sequential recording replays one request at a time, which the README states. There is no speed factor, no cap on recorded gaps, no retry policy, no resume, and the CLI does not wire the engine's `onProgress`. The first SIGINT is consumed by the handler in `packages/cli/src/main.ts` that only the capture command observes, so a replay ignores it and a second signal ends the process without writing a run.

**Proposal.**

- Streaming replay. The engine consumes the recording through `iterateRecording` with a bounded look ahead window for dependency and happens before computation. Exchange results stream to `exchanges.jsonl` next to the run and `run.json` holds the summary plus the first N mismatches per path. `rp report` reads both. The current single file shape stays available with `--inline-exchanges` for small runs.
- Session parallelism. `--session-key <header|cookie|jsonpath>` partitions the recording into sessions. Order is kept inside a session and sessions run concurrently up to `--concurrency`. This is how a recording of one load generator becomes a load test without inventing an ordering the recording did not have between requests of one session. Cross session happens before is kept for barrier tags and controls.
- Pacing controls. `--speed 2.0` scales recorded gaps, `--max-gap-ms` caps idle time, `--duration` and `--loop N` repeat the recording, `--ramp 30s` for fixed rate. Each is recorded in `pacing`.
- Reference re-replay. `--reference-target` sends every exchange to the reference as well as the candidate, diffs recorded against reference now and recorded against candidate now, and reports the first as noise. A path that differs on the reference re-replay cannot fail the candidate. This is the single most important change for attributable verdicts: today a timestamp or a nondeterministic id fails the candidate until someone writes an ignore rule, and `relative_to_reference` compares the proxy's view of the reference against the adapter's view of the candidate on different days.
- Retry policy. `--retry <n>` with `--retry-on timeout,connection` and jittered backoff. A retried exchange records `attempts` and the first error, so a FAIL on errors is not hidden by a PASS on retries. Default stays zero.
- Checkpoint and resume. Every 1000 acknowledgements the engine writes `run.checkpoint.json`. `--resume` continues from it. A SIGINT writes the partial run with an `aborted` inconclusive condition and exits 3.
- Progress. `--progress` prints a line every N exchanges or every second with completed, errors, mismatches, achieved rps, and ETA, to stderr. A TTY gets a single updating line.
- Distributed workers. A coordinator splits by session and hands shards to `rp replay --worker` processes on other hosts over a small HTTP protocol. The runs merge into one. This is the last item in this group and depends on every other.

**Acceptance.** A synthetic 2 million exchange recording replays in a fixed 300 MB of memory. A recording with ten independent sessions reaches ten times the sequential throughput at `--concurrency 10` with zero mismatches against the clean candidate. The reference re-replay on the demo marks `$.created_at` as noise without an ignore rule.

**Size.** L. Streaming and session parallelism first, then re-replay.

### E4. Diff rules v2

**Today.** Rules are global, which the README lists as a limitation. `tolerances` cover numbers only. There is no way to say that the candidate may add fields, that `null` and absent are the same, that `"1"` and `1` are the same, that two timestamps within a second are the same, or that `"29.90"` and `"29.9"` are the same decimal. Substitutions capture from response bodies only, so an id returned in a `Location` header cannot be captured. The JSONPath subset has no filters, so a rule cannot say "the row whose `type` is `fee`".

**Proposal.**

- Scope. Every rule accepts `when: { tags: [...], methods: [...], paths: [glob] }`. A rule without `when` is global. The demo's two rules files become one.
- New rule kinds in `diff-rules.yaml`:
  - `extra_fields: allow | deny` globally and per scope, for a candidate that adds fields.
  - `equivalences: { null_absent: true, empty_absent: false, numeric_strings: true }`.
  - `decimal: [{ path, scale: 2 }]` comparing decimal strings by value at a scale.
  - `time: [{ path, abs_ms: 1000, format: iso8601 | epoch_ms }]`.
  - `mask: [{ path, pattern: '^req-[0-9a-f]+$' }]` tolerating any value that matches on both sides.
  - `headers.ignore` beside `headers.compare`, and `headers.tolerances` with `mask`.
- Substitutions from headers and from the request. `capture: { tag, header: location, pattern: '/v1/orders/(.+)$' }` and `capture: { tag, from: request, path: '$.client_ref' }`.
- JSONPath filters and recursive descent in rule paths: `$.items[?(@.type=='fee')].amount` and `$..request_id`. Concrete finding paths stay as they are.
- Rule packs. `include: [./packs/timestamps.yaml]` so a platform team ships rules and a service team adds its own.
- `rp rules lint`, which parses a rules file, checks every path against a recording so a rule that matches nothing is reported, and prints the effective rule per tag.
- `rp rules suggest`, which takes two runs of the same recording against the reference (E3) and proposes `ignore`, `mask`, and `time` rules for every path that differed between them, with the evidence. The output is a rules file for review, never applied on its own.
- Custom matchers as a last resort. `--matchers ./matchers.js` loads a module exporting `{ name, match(path, reference, candidate) }` functions that a rule can name with `matcher: name`. The run records the module's hash. This is the escape hatch for a shape the data rules cannot express and it is documented as such.

**Acceptance.** The demo runs under one rules file with the ordering rule scoped to `list-inventory`. `rp rules suggest` on two reference replays of the demo proposes exactly the `created_at` ignore. Every new rule kind has a determinism test, so two runs produce byte identical findings.

**Size.** L. Scope and the new rule kinds are M on their own and land first.

### E5. Thresholds, baselines, and gating

**Today.** `evaluate.ts` gates latency per tag, ratio to reference overall only, error rate overall only, and mismatch rate per tag. There is no comparison with an earlier run, so a candidate that regresses from 0 to 0.05 percent mismatches passes a 0.1 percent gate without anyone noticing the trend. `rp report` exits 0 regardless of the verdict, which `PLAN.md` records as a deliberate open question.

**Proposal.**

- Complete the matrix. `relative_to_reference` and `errors` accept `by_tag`. Add `throughput: { achieved_rps_min }` and `status: { by_tag: { get-order: { '404': { rate_max } } } }`.
- Baselines. `--baseline run-previous.json` adds rows of the form `baseline.<tag>.p99_ratio_max` and `baseline.<tag>.mismatch_rate_delta_max`, computed against the earlier run's statistics. A baseline from a different recording hash is refused unless `--baseline-any-recording` is given.
- Noise aware gating. With E3's reference re-replay, a path marked as noise is excluded from mismatch rates before the correctness rows are computed, and the report shows the excluded count.
- Budgets for inconclusive rows. `inconclusive: { max_rows: 2 }` lets a run pass when a small number of low volume tags could not decide, and the report lists them. Today one tag with nineteen samples against `min_samples: 20` makes the whole run inconclusive, which is correct for a demo and too strict for a nightly job over hundreds of tags.
- `rp report --fail-on-verdict` exits with the run's own code, for pipelines that render first and gate second.
- `rp compare run-a.json run-b.json` prints the threshold rows side by side, the paths that appeared or disappeared, and the latency deltas per tag, as terminal text, Markdown, or JSON.

**Acceptance.** A run with a baseline from the previous night fails when p99 on any tag grows by more than the configured ratio. Every new row has a schema entry and appears in the HTML threshold table.

**Size.** M. Noise aware gating depends on E3.

### E6. Invariants as a platform

**Today.** `packages/invariants` parses the demo's routes with regular expressions in `commands.ts` and ships ten rules written against the demo's order lifecycle. The README says another domain needs its own rules and the package shows the shape. It does, but only by editing the package.

**Proposal.**

- A rule module interface. `--invariants-module ./invariants.js` loads a module that exports `parse(exchange)` into a command stream and an array of rules with `check(epoch)`, the same contract the built in rules use. The run records the module's name, version, and hash. The demo's rules move behind this interface and become the first example.
- A declarative subset. A `invariants.yaml` for the rules that need no code: idempotency by header name and payload hash, monotonic counters at a path, read your writes between a tagged command and a tagged read keyed by a substitution, a set of status transitions, and a conservation check (the sum of a field over tagged commands equals the delta of a field at a tagged read). Most lifecycle rules in a service fit one of these shapes.
- Evidence links. Every evidence entry already names an exchange id. The HTML report links it to the drill down entry and the drill down shows the invariant findings beside the diff.
- Per system invariants over any recording. `rp invariants` already runs on one file. Add `--module` and `--rules` to it so a team can check a production recording of the reference alone, without a candidate, as a correctness audit.

**Acceptance.** The ten demo rules run unchanged through the module interface and produce the same reports on `demo/recording.jsonl`. A second example module for a generic key value service ships under `examples/invariants/`.

**Size.** M.

### E7. Transports

**Today.** `http` speaks HTTP/1.1 without TLS options, client certificates, or a proxy setting. `bus` ships an in process bus and Redis Streams. The Redis subscriber starts at `$` and has no consumer group, so a reply published before the blocking read is in place is lost and a second replay process cannot share the stream. There is no way to load an adapter from outside the repository.

**Proposal.**

- HTTP options. `--upstream-ca`, `--upstream-cert`, `--upstream-key`, `--upstream-insecure`, `--http-proxy`, `--http2`, and `--sni`. The undici `Pool` accepts every one of these through its `connect` options.
- Adapter plugins. `--adapter-module ./my-adapter.js` loads a module exporting `create(options): Adapter`. The run records the module's name and hash. The contract in `docs/writing-adapters.md` becomes the plugin contract.
- gRPC adapter. Unary calls first, with proto descriptors from `--proto` or server reflection, bodies stored as JSON through the descriptor so the differ works unchanged, and metadata as headers. Streaming calls are recorded as a sequence of frames in a later step.
- Kafka adapter with consumer groups and an explicit correlation header, plus consumer groups on the Redis bus so delivery is at least once and several replayers can share one stream.
- Streaming responses over HTTP. Server sent events and chunked bodies are recorded as frames with offsets, compared frame by frame, and latency carries first byte and last byte.
- WebSocket capture and replay as a frame sequence, in the same shape as SSE.

**Acceptance.** The engine integration tests run through a gRPC stand in with the same assertions as the HTTP tests. A third party adapter in `examples/adapters/` runs the demo recording.

**Size.** L. HTTP options and the plugin loader are S and land first.

### E8. Shrinking

**Today.** `rp shrink` resets the candidate through one `POST` URL, runs attempts one at a time, and lowers only `qty` and `quantity` fields in request bodies. A latency breach cannot be shrunk.

**Proposal.**

- Reset strategies. `--reset-url`, `--reset-command 'docker compose restart candidate'`, and `--reset-module` through the adapter plugin. The reset is verified by a configurable health request before each attempt.
- Generic value lowering. `shrink.lower: ['$.qty', '$.items[*].quantity']` in the rules file replaces the hard coded field names, and a `shrink.simplify` list of paths whose values may be replaced with a minimal valid value.
- Parallel attempts against several reset candidates when `--targets` lists more than one, which cuts the wall time of the remove phase by the number of targets.
- Attempt memoization keyed by the subset hash, so a retried shrink does not replay a subset it has already judged.
- Shrink to a latency breach: the rule `latency:<tag>:<metric>` is reproduced when the subset's percentile still breaches, with a `repeat` so the judgement is over a sample. The report labels it as a statistical reproduction.

**Acceptance.** The demo defect shrinks to the same four steps through `--reset-command`. A second shrink of the same run makes zero new attempts.

**Size.** M.

### E9. The agent

**Today.** `packages/agent/src/anthropic.ts` asks for JSON in the system prompt and `validate.ts` scrapes it from free text, including code fences. A refusal stops the loop. The budget estimate divides characters by three. `pricing.ts` holds three entries, one of them a dated id, and goes stale on the next price change. Kept cases are written to `generated-cases.jsonl` in the case schema, which `rp replay` cannot read, so a finding the agent made cannot join the regression corpus without a human rewriting it.

**Proposal.**

- Structured output. Ask for the cases through `output_config.format` with the JSON Schema derived from `GeneratedCaseSchema`, through the SDK's `messages.parse()` helper, so the answer is schema valid by construction. Keep `validateCases` as the second check for tags, placeholders, and redaction.
- Server side refusal fallback. Send `betas: ['server-side-fallback-2026-07-01']` with `fallbacks: 'default'` on the Claude API so a declined round is retried on a fallback model inside the same call. The transcript records which model answered. On other platforms the SDK's client side fallback middleware does the same.
- Exact budget estimates through `messages.countTokens` before each call, in place of the character heuristic, with the heuristic as the offline fallback.
- A pricing table with a date, entries for every current model including `claude-haiku-5-5` and `claude-fable-5-1`, a warning when the table is older than ninety days, and `--pricing ./prices.json` to override it. The transcript already notes when a price is assumed.
- Provider choice. `--provider anthropic | bedrock | vertex | foundry` builds the matching official client (`AnthropicBedrockMantle`, `AnthropicVertex`, `AnthropicFoundry`) behind the existing `ModelClient` interface. Organizations that must stay inside one cloud need this before they can run the agent at all.
- Export kept cases as a recording. `rp agent --export-recording agent-cases.jsonl` writes every kept case's reference responses in the recording format with tags, so the next `rp replay` includes them and a divergence the agent found is checked forever. This closes the loop the README describes.
- Isolation for stateful cases. `docs/agent-loop.md` says the agent's own cases mutate both systems. Add `--reset-between-cases <url>` and `--case-concurrency` so cases run in a clean state or in parallel when the systems are stateless, with the mode recorded in the run.
- Observability. One OpenTelemetry span per model call and per case through the SDK's instrumentation, with token counts as attributes (E12).
- A prompt evaluation set under `packages/agent/eval/`, built from the demo runs, that scores a prompt change by kept cases per dollar across the four divergences, so a prompt edit is measured and not eyeballed.

**Acceptance.** On the demo the agent keeps the same four findings with structured output and zero dropped cases for malformed JSON. The exported recording replays against the classic candidate and fails on the same paths.

**Size.** M.

### E10. Reports and pipeline output

**Today.** `rp report` renders HTML, JSON, and terminal text. The HTML drill down has no cap on mismatched exchanges, so a bad run produces a report a browser cannot open. There is no JUnit, no Markdown summary, no annotation format, and no view across runs.

**Proposal.**

- `--format junit` with one test case per threshold row and per invariant, so every CI system shows the rows as tests. `--format markdown` for a pull request comment or a GitHub job summary, with the threshold table and the top paths. `--format sarif` for the mismatch findings, which GitHub renders as annotations.
- Caps and paging in HTML. At most 200 mismatched exchanges inline, grouped by top path, with a link to `exchanges.jsonl` (E3) for the rest. The errors table gets the same treatment.
- Report features that keep the no script rule: a table of contents, print CSS, a dark color scheme through `prefers-color-scheme`, anchors per exchange, and a "reproduce" line per mismatched exchange that shows the request as a `curl` command with redacted headers as placeholders.
- A trend view. `rp report --runs run-*.json --out trend.html` renders p99 per tag and mismatch rate per tag across runs as inline SVG, which is where a nightly job's history becomes visible without a server.
- A status badge. `rp report --format badge` writes an SVG with the verdict for a README.

**Acceptance.** The JUnit output loads in a GitHub Actions test summary and in Jenkins. The HTML for a run with 50,000 mismatches opens in under two seconds.

**Size.** M.

### E11. Configuration and the CLI

**Today.** Every setting is a flag. The demo passes a dozen on each invocation in `scripts/demo.sh`. Secrets for `--headers-file` sit in a plain text file. `CLI_VERSION` in `packages/cli/src/cli.ts` is a second copy of the package version. A thresholds file that names a tag absent from the recording yields an inconclusive row at the end of a long replay instead of an error at the start.

**Proposal.**

- `rp.yaml` with profiles. Any flag can be a key, `profiles.nightly` overrides the top level, `--profile nightly` selects it, and a flag on the command line wins. `RP_<FLAG>` environment variables sit between the file and the flags. The run records the effective configuration.
- Secrets. Header values and URLs accept `${ENV_NAME}` interpolation, resolved at run time and never written to the run or the candidate recording.
- `rp validate --recording --rules --thresholds --config`, a preflight that parses everything, checks that every tag named in thresholds and rules exists in the recording, that every substitution capture tag has at least one producer, that the targets answer a health request, and that the reset URL answers. `rp replay` runs the same checks first and fails with exit 1 before sending anything, unless `--no-preflight`.
- `rp doctor` prints the versions, the resolved configuration, the platform, and the connectivity checks, for a support ticket.
- Version from `package.json` at build time, shell completion through commander's completion support, `--log-format json` for every command, and a global `--quiet`.

**Acceptance.** `make demo` passes its settings through `demo/rp.yaml` and the shell script shrinks to the orchestration. A misspelled tag in thresholds fails the preflight in under a second.

**Size.** S to M.

### E12. Observability

**Today.** Commands print a handful of lines to stderr. There is no progress during a replay, no structured log, no trace, and no metric.

**Proposal.**

- Structured logging through a small logger with levels, `--log-level`, and JSON output, used by every package through an injected interface so library users can route it.
- OpenTelemetry traces. One span per run, one per exchange sampled at a configurable rate, and one per model call, exported through OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The exchange span carries the tag, the verdict, and both latencies. A trace id in the run lets an operator open the candidate's own traces for a mismatched exchange when both sides propagate `traceparent`, which the HTTP adapter sends when tracing is on.
- Metrics. `--metrics-port` exposes Prometheus counters for sent, acknowledged, errors, and mismatches and a histogram for candidate latency, for replays that run for hours.
- Progress as described in E3, and a heartbeat line every minute in non TTY mode so a CI log shows the job is alive.

**Acceptance.** A replay against the demo with tracing on shows a span per exchange in a local collector, and the candidate's Fastify logs carry the same trace id.

**Size.** M.

### E13. Security and compliance

**Today.** Redaction covers headers only, so an `api_key` query parameter or a body field is recorded in clear. `scripts/check-secrets.sh` matches one key prefix. The CI workflow has no `permissions` block, pins actions by major version, and runs no dependency audit. There is no `SECURITY.md`, no threat model, and no statement about what a recording contains and how long it should be kept.

**Proposal.**

- Body and query redaction (E1) with the keyed hash mode, and `rp recording scan`, which reports fields that look like personal data by pattern (email, phone, card number, national id formats) and by entropy, so an operator sees what a recording holds before it is shared.
- Encryption at rest. `--encrypt age:<recipient>` writes recordings and candidate recordings through an age stream, and the reader decrypts with `RP_AGE_IDENTITY`. A KMS envelope mode follows for the clouds.
- Supply chain in CI. `permissions: { contents: read }` at the top of the workflow, actions pinned by commit SHA, a CycloneDX SBOM attached to every release, OSV scanning of the lockfile, gitleaks over the tree in place of the prefix grep, CodeQL for TypeScript, and Dependabot or Renovate with grouped weekly updates.
- Signed releases. npm provenance through GitHub OIDC for the packages and cosign signatures for the image (E14).
- Documents. `SECURITY.md` with the disclosure path and the support window, `docs/threat-model.md` describing what the tool holds (recordings, candidate recordings, run files, transcripts), who can read them, what redaction does and does not cover, and the recommended retention, and `docs/data-handling.md` for the agent, stating exactly what leaves the machine when a model is called.
- Least privilege in the demo images. Read only root filesystem and a dropped capability set in the compose file, as the example teams will copy.

**Acceptance.** `rp recording scan demo/out/recording.jsonl` reports the `authorization` header as redacted and no other finding. The release workflow produces a signed image and an SBOM and the README documents verification.

**Size.** M.

### E14. Packaging, release, and support matrix

**Today.** Every package is private. The only way to run `rp` is to clone and build. There is no release workflow, no changelog automation, and no image. CI runs on Node 22 on Linux only.

**Proposal.**

- Publish `@replay-parity/cli` and the libraries to npm with provenance, so `npx @replay-parity/cli replay ...` works. Keep `core`, `replay`, and `report` as public libraries with documented entry points and typedoc output.
- An `rp` container image built from a distroless base, published to GHCR with the version tag and a digest, and used by the demo compose file for the capture step so the demo exercises the image.
- A release workflow driven by changesets: version bumps from the changeset files, the changelog generated into `CHANGELOG.md` under a version heading, a tag, a GitHub release with the SBOM, the image, and the report of the demo run on the release commit.
- A support matrix in the README: Node 22 and 24, Linux, macOS, and Windows, with CI running the unit tests on all three and the demo on Linux. The limitation that nothing was tried on Windows is removed by trying it.
- Semantic versioning with a stated policy: the recording format, the run schema, the rules schema, the adapter contract, and the exit codes are the public interface, and a breaking change to any of them is a major version with a migration command.

**Acceptance.** A clean machine with Node runs `npx @replay-parity/cli replay --recording demo/recording.jsonl --target ...` against a running candidate. The Windows unit job passes.

**Size.** M.

### E15. Quality engineering

**Today.** The suite is thorough for example based tests. There is no property based testing, no fuzzing of the recording parser, no mutation testing, and no performance gate. The coverage threshold applies to `core` only.

**Proposal.**

- Property based tests with `fast-check`: the differ is reflexive and reports no finding for `diff(x, x)`; findings are deterministic across key order and array order under an unordered rule; `canonicalJson` is a total order; JSONPath `renderPath(parsePath(p))` round trips; substitutions never rewrite a value that was not captured; `OrderedSink` emits in reservation order under any completion order.
- Fuzzing. A nightly job runs the recording parser, the rules parser, and the agent answer parser against mutated inputs for ten minutes and files a failing input as a fixture.
- Mutation testing with Stryker on `core` and `invariants`, with a score gate, so a test that asserts nothing is found.
- Performance gates. `make bench-capture` and `make bench-replay` run in CI on a fixed runner class with a 20 percent regression threshold against the last release's numbers, stored in the repository.
- Chaos tests. A candidate stand in that closes the connection mid body, answers after the timeout, returns a truncated gzip, and returns 5xx on a seeded fraction, with assertions on the error classification and the verdict.
- Coverage thresholds for every package at 85 percent and `core` at 90, and a flaky test quarantine list with an owner and a date.

**Acceptance.** The property tests run in under thirty seconds in the unit project. The mutation score on `core` is above 80 percent.

**Size.** M.

### E16. Documentation and governance

**Today.** The docs explain the design well. They do not tell an operator how to run the tool against a real system, what to do when a run is inconclusive at three in the morning, or how to contribute.

**Proposal.**

- `docs/operations.md`: a runbook for capture in front of a real reference, sizing, retention, running the replay in CI and on a schedule, reading each inconclusive condition and what to change, and the exit codes a scheduler should expect.
- `docs/real-system.md`: a walkthrough that starts from an existing service with authentication, writes the tag rules, the redaction rules, the substitutions, and the thresholds, and ends with a nightly job. The demo is the example; this document is the template.
- `docs/troubleshooting.md` and a FAQ, with the questions the demo raises: why a sequential recording replays sequentially, why a timestamp fails without a rule, why a barrier timed out.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`, issue and pull request templates, and an `docs/adr/` directory that holds the decisions now listed in `docs/architecture.md`, one file each with the date and the status.
- A versioned docs site built from `docs/` with typedoc for the public packages, published from the release workflow.

**Acceptance.** A new engineer follows `docs/real-system.md` against a service of their own and reaches a passing nightly run without reading source.

**Size.** M.

### E17. A run store and a dashboard, later

**Today.** Every result is a file. That is right for the CLI and it is what makes the tool fit a pipeline.

**Proposal.** When the file based trend view (E10) is not enough, `rp serve` keeps runs in SQLite or Postgres, shows the trend per recording and per tag, marks paths as known noise with an owner and an expiry, and exposes the baseline for E5 through an HTTP endpoint. It is the last item on the roadmap, it is optional, and the CLI stays the product. It is listed so that E3, E5, and E10 are shaped with it in mind: run files carry the recording hash, the effective configuration, and the tool version, which is what a store needs to index them.

**Size.** L. Not before phase three.

## Hardening items found while reading

These are small and concrete. Each is a day or less. They belong in the first phase because every one of them can surface in a real run.

| Where                                      | Issue                                                                                                                                                                                    | Fix                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/replay/src/bus/adapter.ts`       | When `publish` throws, the reply timer is not cleared. It fires after the timeout and rejects a promise nobody awaits, which Node treats as an unhandled rejection and ends the process. | Clear the timer and remove the abort listener in the catch path. Add a test that fails publish.                            |
| `packages/capture/src/proxy.ts`            | A sampled response is buffered in full before the cap is applied. A 2 GB response costs 2 GB of memory and is then stored as a hash.                                                     | Count and hash while streaming and stop appending chunks past the cap.                                                     |
| `packages/capture/src/proxy.ts`            | The request body is read in full before forwarding, which changes the timing the reference sees for large uploads and holds the body in memory.                                          | Tee the request stream into the upstream request and the recorder.                                                         |
| `packages/capture/src/proxy.ts`            | Query string parameters are recorded in clear. `?api_key=` is as common as the header.                                                                                                   | Apply the redaction list to query keys as well, until E1 lands.                                                            |
| `packages/cli/src/main.ts`                 | The first SIGINT only aborts a signal that the capture command observes. Replay, shrink, and agent ignore it, and the second signal kills the process with no run written.               | Pass the signal to every command. On abort, write the partial run with an `aborted` condition and exit 3.                  |
| `packages/cli/src/cli.ts`                  | `CLI_VERSION` is a second copy of the version in `package.json`.                                                                                                                         | Read the version from the package at build time.                                                                           |
| `packages/report/src/html.ts`              | Mismatched exchanges render without a cap.                                                                                                                                               | Cap at 200 and say so, until E10.                                                                                          |
| `packages/replay/src/engine.ts`            | `as-recorded` honors every recorded gap, so a recording with a ten minute idle period replays with a ten minute sleep and no output.                                                     | `--max-gap-ms` with a default of 30 seconds and a log line when a gap is capped.                                           |
| `packages/replay/src/engine.ts`            | `--filter` drops the producers of substituted values, so a filtered replay of `get-order` mismatches on every id.                                                                        | `--include-dependencies`, on by default when substitution rules exist.                                                     |
| `packages/replay/src/substitutions.ts`     | Every rule's table is applied to every path segment, so a captured value that happens to equal a SKU or a literal segment is rewritten.                                                  | Let a rule restrict `apply` to path globs and body paths, and warn when a captured value collides with a recorded literal. |
| `packages/core/src/thresholds/evaluate.ts` | A tag named in thresholds that has no samples produces an inconclusive row at the end of the run.                                                                                        | Fail the preflight (E11) and keep the row for recordings that legitimately lack the tag under `--no-preflight`.            |
| `packages/replay/src/http-adapter.ts`      | No TLS options, so a candidate behind a private CA cannot be replayed without `NODE_EXTRA_CA_CERTS`.                                                                                     | The upstream flags from E7, which are a thin pass through to undici's connect options.                                     |
| `packages/agent/src/pricing.ts`            | The haiku entry uses a dated model id and the table has no date.                                                                                                                         | Use the plain ids, add the two missing current models, and add the date and the staleness warning from E9.                 |
| `.github/workflows/ci.yml`                 | No `permissions` block, no pnpm store cache, no `concurrency` group, actions pinned by major version.                                                                                    | Add all four. The cache alone removes a minute from every run.                                                             |
| `packages/core/src/run/io.ts`              | `RunSchema` is strict on `schema_version: 1`, so the first schema change makes every existing run file unreadable.                                                                       | A `migrateRun` step before parsing, with one migration per version.                                                        |
| `packages/cli/src/env.ts`                  | `.env` is read from the working directory, so running `rp agent` from another directory silently finds no key.                                                                           | Resolve relative to the repository root when inside one, and print the path that was tried in the no key message.          |

## Roadmap

**Phase one, make it safe and runnable in a pipeline (about six weeks).** The hardening table. E11 configuration and preflight. E13 supply chain and redaction of query strings and bodies. E10 JUnit and Markdown output and the HTML cap. E14 publishing and the image. E15 property tests and chaos tests. At the end of this phase a team can install `rp`, run it nightly from a config file, and read the result in their CI system.

**Phase two, make the verdict attributable at scale (about ten weeks).** E3 streaming replay, session parallelism, and reference re-replay. E4 scoped rules, the new rule kinds, and `rp rules suggest`. E5 baselines and noise aware gating. E1 session sampling, streaming bodies, and the manifest. E2 lossless numbers, the recording hash, and the recording tools. E12 logging, tracing, and progress. At the end of this phase a run over production scale traffic produces a FAIL that names the candidate's difference and nothing else.

**Phase three, make it a platform (about ten weeks).** E6 invariant modules and the declarative rules. E7 adapter plugins, gRPC, Kafka, and streaming responses. E8 reset strategies and parallel shrinking. E9 structured output, providers, and the exported recording. E16 the operations documents and the docs site. E17 the run store if the trend view proves insufficient.

The order inside each phase follows the dependencies named in the items. The estimate assumes one engineer; two engineers halve the calendar time of phases two and three because the items there are independent.

## What stays as it is

- JSON Lines for recordings, one exchange per line, with the manifest as an addition and not a replacement.
- Rules as data, with the custom matcher module as a documented exception.
- The three verdicts and the four exit codes. New conditions are new inconclusive kinds, not new verdicts.
- Invariants per system, shown above the diff.
- Reduced reproduction, never minimal.
- One HTML file with no script and no external resource. Every report feature above fits inside that rule.
- The adapter contract. Plugins implement it, they do not extend it.
- The prose rules in `scripts/check-prose.sh`. This document passes them.
