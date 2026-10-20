# The agent loop

`rp agent` turns the differences a replay found into new, sharper test cases without a human writing them. It is a bounded loop around one model call per round. This page explains the loop, shows the transcript of a real run from `make demo`, and says what the agent is good at and where it is noisy.

## The loop

Each round does seven things.

1. Summarize the run: the verdict, the threshold rows that did not pass, mismatches by tag, the mismatching paths with array indices generalized to `[*]`, a sample of mismatched exchanges with the first differing values, and the latency rows that failed.
2. Describe the recording: one request shape per tag with the method, the path, the body of the first recorded request, the statuses seen, and the keys of the responses. Of the request headers only `content-type` and `idempotency-key` are shown. A header on the redaction list is shown as `<redacted>` even when the recording was not redacted, and every other header is left out.
3. Ask the model for up to `--cases-per-round` cases as one JSON object. The system prompt and the round prompt live in `packages/agent/prompts/` and their content hashes go into the run and the transcript.
4. Validate every case against the schema: a hypothesis, one tag that exists in the recording, one to three steps, each step a recorded style request with an optional capture of `{ name, path }` from its response. A later step may use `{{name}}`. A case that is malformed, names an unknown tag, has more than three steps, uses a placeholder no earlier step captured, or sets a redacted header to a real value is dropped with a reason.
5. Send each valid case to the reference and to the candidate, step by step, resolving `{{name}}` from that system's own captures. The captured pairs feed the differ as equivalences, so a create then get sequence compares each system's own order and the two ids do not count as a difference. The final step's responses are diffed with the run's rules, and the candidate's latency is checked against the absolute limits for the case's tag and overall.
6. Keep a case when its dedupe key is new. A mismatch keys on the sorted set of untolerated finding paths with array positions folded into `[*]` and a path inside an array cut at the row, so a divergence that reorders rows counts once however many fields or rows it touches, while two top level fields stay two findings. A latency breach keys on `latency:<scope>:<metric>`. Kept cases go to `generated-cases.jsonl` and into the `agent` section of the run, which the report renders.
7. Stop when a round keeps nothing, when the next call could cross `--budget-usd`, when `--max-rounds` is reached, when every case in a round was invalid, when the model declines, or when a call fails. Each call's tokens are priced from a static table and the totals are printed at the end.

Without `ANTHROPIC_API_KEY`, in the environment or in a `.env` file at the repository root, the command prints a message and exits 0 without building a client.

## A real transcript

From `make demo` on 2026-10-17, against the classic candidate with the four planted divergences, after the first replay. Model `claude-sonnet-5-5`, effort `medium`, two rounds, eight cases per round, two dollar budget. Prompt versions `system.md e08fe4717b9d` and `round.md adcf42890db5`. The full file is `demo/out/agent-transcript.json` after a run.

### Round 1

The round prompt was 4270 characters. Its summary began like this.

```
Verdict: fail.
Threshold rows that did not pass: latency.by_tag.adjust-stock.p99_ms (fail, limit 40, measured 73.343); correctness.mismatch_rate_max (fail, limit 0, measured 0.321555); ...
Mismatches by tag: create-order: 7 of 48 mismatch, 0 errors; get-order: 31 of 109 mismatch, 0 errors; list-inventory: 53 of 53 mismatch, 0 errors.
Mismatching paths: $.items[*].name (530), $.items[*].sku (530), $.items[*].unit_price (530), $.items[*].on_hand (499), $.total (30), status (8), $ (8).
Sample of mismatched exchanges:
- POST /v1/orders [create-order] status 201 vs 201: $.total 29.99 vs 29.98
- GET /v1/inventory [list-inventory] status 200 vs 200: $.items[0].name "Hex bolt M8" vs "Bracket L"; $.items[0].on_hand 497 vs 500; $.items[0].sku "A-100" vs "C-300"
- GET /v1/orders/o-9185 [get-order] status 404 vs 200: status 404 vs 200; $ {"error":"not_found"} vs absent
```

The model answered with eight cases. 2710 input tokens, 1037 output tokens, $0.0158.

| Case | Tag            | Hypothesis                                                                                                                                | Steps                                                                    | Result                                     |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| 1-1  | create-order   | Order total differs by a cent due to rounding; a quantity of 3 of A-100 likely exposes a different rounding or price calculation.         | `POST /v1/orders {"sku":"A-100","qty":3}`                                | kept: `$.total` 29.99 against 29.98        |
| 1-2  | create-order   | Quantity 1 gives the unit price total directly, showing whether the mismatch comes from the price itself or from multiplication rounding. | `POST /v1/orders {"sku":"A-100","qty":1}`                                | no difference                              |
| 1-3  | create-order   | A large quantity amplifies the rounding or float multiplication difference in total.                                                      | `POST /v1/orders {"sku":"A-100","qty":1000}`                             | no difference                              |
| 1-4  | get-order      | Fetching a just-created order shows whether the total differs at read time or only at creation.                                           | create B-200 x7, capture `oid`, then `GET /v1/orders/{{oid}}`            | no difference                              |
| 1-5  | get-order      | A nonexistent order id returns 404 on one system and 200 on the other, as seen with o-9185.                                               | `GET /v1/orders/o-9185`                                                  | kept: status 404 against 200, body missing |
| 1-6  | get-order      | A malformed order id may be handled differently.                                                                                          | `GET /v1/orders/does-not-exist`                                          | same key as 1-5                            |
| 1-7  | list-inventory | Inventory listing order differs, so a plain list exposes different sort order and stock levels.                                           | `GET /v1/inventory`                                                      | kept: every row differs by position        |
| 1-8  | list-inventory | Adjusting stock then listing inventory shows whether on_hand updates diverge after a mutation.                                            | `POST /v1/inventory/C-300/adjust {"delta":-5}`, then `GET /v1/inventory` | kept: the same rows plus `on_hand`         |

### Round 2

The round prompt grew to 6305 characters because it now listed the four kept cases. The model answered with eight cases. 3716 input tokens, 1094 output tokens, $0.0184. One case was dropped before execution because it carried an extra key, `note`, that the schema does not allow. None of the other seven revealed anything new, so the loop stopped with `no_new_cases`.

| Case | Tag          | Hypothesis                                                                                         | Steps                                               | Result                         |
| ---- | ------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| 2-1  | cancel-order | Cancelling an existing order exposes differences in canceled_at, remaining and total fields.       | create, capture, cancel                             | no difference                  |
| 2-2  | ship-order   | Shipping more than ordered quantity may be validated differently.                                  | create x2, capture, ship 5                          | no difference, both answer 409 |
| 2-3  | create-order | Ordering a quantity of 1 of a different SKU may reveal price calculation differences beyond A-100. | `POST /v1/orders {"sku":"C-300","qty":7}`           | no difference                  |
| 2-4  | create-order | Ordering an unknown SKU may return different error status or body.                                 | `POST /v1/orders {"sku":"Z-999","qty":1}`           | no difference, both answer 404 |
| 2-5  | create-order | Zero or negative quantity validation may differ between systems.                                   | `POST /v1/orders {"sku":"A-100","qty":0}`           | no difference, both answer 400 |
| 2-6  | set-quantity | Setting an order quantity to a large value may produce different 409 handling and totals.          | create, capture, set quantity 1000                  | no difference                  |
| 2-7  | adjust-stock | Adjusting stock by a large negative delta may be allowed on one system and rejected on the other.  | `POST /v1/inventory/C-300/adjust {"delta":-100000}` | no difference, both answer 409 |

Totals: 16 proposed, 15 valid, 15 executed, 4 kept, 6426 input tokens, 2131 output tokens, $0.0342 of $2.00.

## What the agent is good at

- It turns a mismatching path into a one request reproduction. The three divergences that a single request can reach, the half cent rounding, the unknown id, and the inventory ordering, were each reproduced in the first round by a case the model wrote from the summary alone.
- It writes multi step cases correctly. Every create then act sequence captured the order id and reused it, and the per system resolution of captures kept the two ids out of the diff.
- It explores validation edges that the recording never exercised: zero quantity, unknown SKU, over shipment, an oversize negative adjustment. In this demo the two systems agree on all of them, which is itself information.
- It is cheap. Two rounds cost three and a half cents and took a few seconds beyond the model's own latency.

## Where it is noisy

- It cannot reach the latency divergence. The candidate delays five percent of `adjust-stock` calls, so a single request has one chance in twenty to breach, and the model's adjust cases were about validation rather than timing. A latency case needs volume, which the replay provides and the agent does not.
- The dedupe key was once the exact set of paths, so cases 1-7 and 1-8 in the run above, which both show the inventory ordering divergence on different fields of the same rows, were both kept. The key now folds array positions and cuts a path inside an array at the row, so the second of two such cases is dropped as the same finding.
- The agent's own cases mutate both systems. A stock adjustment or a create in one case changes what the next case sees, and the two systems drift apart when a case lands differently on them. In this run the inventory read in case 1-8 showed `on_hand` 508 against 503 for the SKU an earlier case had adjusted. Stateful side effects are the price of exploring mutations, and the report labels every kept case with the round it ran in.
- Hypotheses are plausible but not grounded. The model wrote that the candidate "truncates rather than rounds" and that the two systems might "go negative" on stock. Neither is true. The harness keeps only what actually differed, so a wrong hypothesis costs one request and nothing else.
- The schema is strict on purpose. A case with an extra key is dropped rather than repaired, and the drop and its reason are in the transcript.
- Order ids line up here because both systems took the same traffic first. Against two systems in different states a single step create differs on `$.order_id` as well, and the mismatch key carries that path. The substitution rules handle this for replays and the capture mechanism handles it inside multi step cases, but a single step case has nothing to substitute.

## Reproducibility

The transcript records the model, the prompt versions, every prompt and every answer, the usage and cost per call, the dropped cases with reasons, and why each executed case was or was not kept. The prompts are plain files, so a change to them changes the version written into every later run. The pricing table is static and the transcript says when a model is priced by assumption.
