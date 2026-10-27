# The agent loop

`rp agent` turns the differences a replay found into new, sharper test cases without a human writing them. It is a bounded loop around one model call per round. This page explains the loop, shows the transcript of a real run from `make demo`, and says what the agent is good at and where it is noisy.

## The loop

Each round does seven things.

1. Summarize the run: the verdict, the threshold rows that did not pass, mismatches by tag, the mismatching paths with array indices generalized to `[*]`, a sample of mismatched exchanges with the first differing values, and the latency rows that failed.
2. Describe the recording: one request shape per tag with the method, the path, the body of the first recorded request, the statuses seen, and the keys of the responses. Of the request headers only `content-type` and `idempotency-key` are shown. A header on the redaction list is shown as `<redacted>` even when the recording was not redacted, and every other header is left out.
3. Ask the model for up to `--cases-per-round` cases as one JSON object. The answer is schema constrained: the call carries, in `output_config.format`, a JSON Schema derived with zod's `toJSONSchema` from the case schema, so the answer is valid JSON with exactly the keys the harness reads and nothing is dropped for a code fence or a stray sentence. Two parts of a request have no form structured outputs accept, a map with arbitrary keys and a recursive JSON value, so in the constrained shape `query` and `headers` are lists of `{name, value}` pairs and the body is JSON text in `body_json`. The harness decodes them before validation, and a plain answer, the shape the mock client gives, is taken as it is. The same call sends the beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`, so a round the requested model declines is retried inside the same call on the model Anthropic routes that refusal category to; `--no-fallbacks` turns that off, and a refusal that survives the chain stops the loop with `model_refusal`. The transcript records per round whether the answer was schema constrained, which model answered, and whether a fallback ran. The system prompt and the round prompt live in `packages/agent/prompts/` and their content hashes go into the run and the transcript.
4. Validate every case against the schema: a hypothesis, one tag that exists in the recording, one to three steps, each step a recorded style request with an optional capture of `{ name, path }` from its response, and an optional `repeat` from 1 to 50. A later step may use `{{name}}`. A case that is malformed, carries body text that is not JSON, names an unknown tag, has more than three steps, a `repeat` outside the range, uses a placeholder no earlier step captured, or sets a redacted header to a real value is dropped with a reason.
5. Send each valid case to the reference and to the candidate, step by step, resolving `{{name}}` from that system's own captures. The captured pairs feed the differ as equivalences, so a create then get sequence compares each system's own order and the two ids do not count as a difference. A case with `repeat` above 1 runs that many times on each system, one run after another. The final step's responses of the first run are diffed with the run's rules, and the candidate's final step latencies over all runs are summarized by exact nearest rank percentiles and checked against the limits for the case's tag and overall. One run is its own every percentile, so a single sample is checked against every limit, and the model is told to raise `repeat` only for a latency hypothesis. Cases run one at a time. With `--reset-between-cases <url>` the candidate receives a POST before every case, and `--reset-reference <url>` does the same for the reference, so stateful cases start from a known state; a reset that fails stops the loop with `error`. `--case-concurrency <n>` runs that many cases at once, only when neither reset is set, and the results are judged in case order whatever order they finish in. The transcript records the mode under `isolation`.
6. Keep a case when its dedupe key is new. A mismatch keys on the sorted set of untolerated finding paths with array positions folded into `[*]` and a path inside an array cut at the row, so a divergence that reorders rows counts once however many fields or rows it touches, while two top level fields stay two findings. A latency breach keys on `latency:<scope>:<metric>`. Kept cases go to `generated-cases.jsonl` and into the `agent` section of the run, which the report renders. With `--export-recording <path>` every kept case is also written as recording exchanges, one per step in case order: the request as sent to the reference with captures resolved, the redaction marker kept for redacted headers and caller supplied headers left out, the reference's response, `offset_ms` growing by each step's reference latency with `ts` counted from the run's creation time, and the case's tags plus `agent:<case id>`. Every step of a case carries the case's tags, so a substitution rule keyed on a tag captures from each step. The file validates like a capture, so the next `rp replay` can take it and a divergence the agent found is checked from then on.
7. Stop when a round keeps nothing, when the next call could cross `--budget-usd`, when `--max-rounds` is reached, when every case in a round was invalid, when the model declines, or when a call fails. Before each call its cost is estimated: the exact input count from `messages.countTokens` on the system prompt, the round prompt, and the schema when the client has the endpoint, else three characters per token, plus every output token the call may produce. The transcript names the estimator per round and the log line says which one ran. Each call's tokens are priced from a dated table by the model that answered, `--pricing <path>` applies a JSON table of model id to prices on top of it, and the command prints a warning once at the start when the table is older than ninety days. The totals are printed at the end.

Without `ANTHROPIC_API_KEY`, in the environment or in a `.env` file at the repository root, the command prints a message and exits 0 without building a client.

## Prompt caching

The round prompt puts the run summary, the request shapes, and the redacted header names first, and everything that changes between rounds, the kept cases and the round line, under the `## Cases already kept` heading. The system prompt and that stable prefix carry cache breakpoints. Rounds after the first read the stable part from the cache at one tenth of the input price, once the stable part is long enough for the model's cache minimum, and the transcript records the tokens read from and written to the cache per round.

## A real transcript

From `make demo` on 2026-10-20, against the classic candidate with the four planted divergences, after the first replay. Model `claude-sonnet-5-5`, effort `medium`, two rounds, eight cases per round, two dollar budget. Prompt versions `system.md a67c9bf802c2` and `round.md 6be6f15093c7`. The full file is `demo/out/agent-transcript.json` after a run.

### Round 1

The round prompt was 4269 characters. Its summary began like this.

```
## Run summary

Verdict: fail.
Threshold rows that did not pass: latency.by_tag.adjust-stock.p99_ms (fail, limit 40, measured 66.879); correctness.mismatch_rate_max (fail, limit 0, measured 0.322695); ...
Mismatches by tag: create-order: 7 of 48 mismatch, 0 errors; get-order: 31 of 109 mismatch, 0 errors; list-inventory: 53 of 53 mismatch, 0 errors.
Mismatching paths: $.items[*].name (530), $.items[*].sku (530), $.items[*].unit_price (530), $.items[*].on_hand (499), $.total (30), status (8), $ (8).
Sample of mismatched exchanges:
- POST /v1/orders [create-order] status 201 vs 201: $.total 29.99 vs 29.98
- GET /v1/orders/o-1 [get-order] status 200 vs 200: $.total 29.99 vs 29.98
- GET /v1/inventory [list-inventory] status 200 vs 200: $.items[0].name "Hex bolt M8" vs "Bracket L"; $.items[0].on_hand 497 vs 500; $.items[0].sku "A-100" vs "C-300"
```

The model answered with eight cases. 54 fresh input tokens, 2823 tokens written to the cache, 1130 output tokens, $0.0185.

| Case | Tag            | Hypothesis                                                                                                                           | Steps                                                                    | Result                                                       |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1-1  | create-order   | Total is off by one cent on the candidate, likely a rounding or float truncation difference; a fractional cent total will expose it. | `POST /v1/orders {"sku":"A-100","qty":3}`                                | kept: `$.total` 29.99 against 29.98                          |
| 1-2  | create-order   | Total rounding differs on larger quantities, so qty 7 of a different sku shows a different cent error pattern.                       | `POST /v1/orders {"sku":"C-300","qty":7}`                                | no difference                                                |
| 1-3  | get-order      | Reading back a created order returns a total that differs by a cent, showing the rounding is also applied on read or stored.         | create A-100 x1, capture `oid`, then `GET /v1/orders/{{oid}}`            | no difference                                                |
| 1-4  | get-order      | A nonexistent order id returns 404 on the reference but the candidate returns 200, suggesting a differing existence check.           | `GET /v1/orders/o-999999`                                                | kept: status 404 against 200, body missing                   |
| 1-5  | list-inventory | The inventory listing is ordered differently and on_hand differs, so the sort order or stock state diverges.                         | `GET /v1/inventory`                                                      | kept: every row differs by position, key `$.items[*]`        |
| 1-6  | list-inventory | After a stock adjustment the listing's on_hand differs because the candidate applies adjustments differently or reads stale stock.   | `POST /v1/inventory/C-300/adjust {"delta":-5}`, then `GET /v1/inventory` | same key as 1-5                                              |
| 1-7  | adjust-stock   | The adjust-stock endpoint has a latency tail on the candidate (p99 66 ms against a 40 ms limit), visible only over many repeats.     | `POST /v1/inventory/C-300/adjust {"delta":1}`, `repeat` 50               | kept: candidate p99 over 50 runs 71.49 ms, reference 0.98 ms |
| 1-8  | create-order   | An unknown sku or an oversized quantity yields a different status or error body because validation differs.                          | `POST /v1/orders {"sku":"Z-999","qty":100000}`                           | no difference                                                |

### Round 2

The round prompt grew to 5023 characters because it now listed the four kept cases below the cache boundary. The model answered with eight cases. 347 fresh input tokens, 2823 tokens read from the cache, 1494 output tokens, $0.0162. None of the eight revealed anything new, so the loop stopped with `no_new_cases`.

| Case | Tag          | Hypothesis                                                                                                                     | Steps                                                   | Result          |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------- |
| 2-1  | cancel-order | Cancel may differ in total, remaining, or canceled fields, since totals already differ by a cent and cancel returns the order. | create A-100 x3, capture, cancel                        | same key as 1-1 |
| 2-2  | ship-order   | Shipping more than the ordered quantity is validated differently or yields different remaining values.                         | create A-100 x2, capture, ship 5                        | no difference   |
| 2-3  | set-quantity | Setting an order quantity to zero or a lower value is handled differently between systems.                                     | create B-200 x5, capture, set quantity 0                | no difference   |
| 2-4  | create-order | Creating an order for a nonexistent SKU or with qty 0 returns a different status or error body.                                | `POST /v1/orders {"sku":"ZZ-999","qty":0}`              | no difference   |
| 2-5  | list-ledger  | Ledger receivables likely reflect the rounding difference and stock_on_hand differs after an order is created.                 | create C-300 x7, then `GET /v1/ledger`                  | no difference   |
| 2-6  | adjust-stock | Adjusting stock with a large negative delta or on an unknown SKU is validated differently.                                     | `POST /v1/inventory/C-300/adjust {"delta":-100000}`     | no difference   |
| 2-7  | get-order    | Shipping a created order partially then reading it shows differing shipped, remaining, or status values.                       | create A-100 x4, capture, ship 1, then `GET /v1/orders` | no difference   |
| 2-8  | create-order | A large quantity order produces a different total due to float rounding at scale.                                              | `POST /v1/orders {"sku":"B-200","qty":999}`             | no difference   |

Totals: 16 proposed, 16 valid, 16 executed, 4 kept, 401 fresh input tokens, 2823 tokens written to the cache and 2823 read back, 2624 output tokens, $0.0347 of $2.00.

## What the agent is good at

- It turns a mismatching path into a one request reproduction. The three divergences that a single request can reach, the half cent rounding, the unknown id, and the inventory ordering, were each reproduced in the first round by a case the model wrote from the summary alone.
- It uses `repeat` where it belongs. Told that latency limits are judged on the percentiles of a sample, it set `repeat` to 50 on the one tag whose p99 row had failed, left it at 1 everywhere else, and the case caught a p99 of 71.49 ms against the 40 ms limit, which no single run could show.
- It writes multi step cases correctly. Every create then act sequence captured the order id and reused it, and the per system resolution of captures kept the two ids out of the diff.
- It explores validation edges that the recording never exercised: zero quantity, unknown SKU, over shipment, an oversize negative adjustment. In this demo the two systems agree on all of them, which is itself information.
- It is cheap. Two rounds cost three and a half cents and took a few seconds beyond the model's own latency.

## Where it is noisy

- Volume costs time and stops at 50. The 50 run case sent fifty requests to each system one after another. A tail that fires on one call in a thousand needs more runs than the cap allows, and the replay, with hundreds of recorded calls per tag, remains the better instrument for that.
- The dedupe key folds array positions and cuts a path inside an array at the row. Case 1-6, a stock adjustment followed by a listing, was dropped as the same finding as 1-5 for that reason, where the first real run, before the fold, kept both. The other side of that coin is that a divergence on one field of the rows, such as a per row price, would merge with an ordering divergence on the same array.
- The agent's own cases mutate both systems. A stock adjustment or a create in one case changes what the next case sees, and the two systems drift apart when a case lands differently on them. In this run cases 1-6 and 1-7 adjusted the stock of C-300 fifty one times on each system before case 2-5 read the ledger, and the ledger still matched only because every case had landed the same way on both systems. Stateful side effects are the price of exploring mutations, and the report labels every kept case with the round it ran in. When the systems expose a reset endpoint, `--reset-between-cases` and `--reset-reference` return both to a known state before every case, at the cost of running cases one at a time.
- Hypotheses are plausible but not grounded. The model wrote that the candidate might have a "float truncation difference" and might "read stale stock". Neither is what the candidate does. The harness keeps only what actually differed, so a wrong hypothesis costs one request and nothing else.
- The schema is strict on purpose. A case with an extra key is dropped rather than repaired, and the drop and its reason are in the transcript.
- Order ids line up here because both systems took the same traffic first. Against two systems in different states a single step create differs on `$.order_id` as well, and the mismatch key carries that path. The substitution rules handle this for replays and the capture mechanism handles it inside multi step cases, but a single step case has nothing to substitute.

## Reproducibility

The transcript records the model asked, the model that answered each round and whether a fallback ran, whether the answer was schema constrained, the prompt versions, every prompt and every answer, the estimator and the estimate before each call, the usage and cost per call, the isolation mode, the dropped cases with reasons, and why each executed case was or was not kept. The prompts are plain files, so a change to them changes the version written into every later run. The price table is dated and the transcript carries that date under `pricing_as_of`, the path of an override table under `pricing_path`, and `pricing_assumed` when a model was priced by assumption.
