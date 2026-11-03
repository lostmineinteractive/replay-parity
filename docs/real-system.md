# Running against a real system

This page is a walkthrough. It starts from an existing HTTP service that requires authentication and ends with a nightly job that replays recorded traffic against a new build and gates on the result. Each step says what to do, which command does it, and what to look at. The steps build on each other, so read them in order the first time.

The demo supplies every concrete file. The demo's reference is the service in `demo/reference-service`, and its load generator sends an `authorization` header, which the committed recording holds as `<redacted>`. Where a step needs a file, the page uses the demo's own: the tag rules from `scripts/demo.sh`, `demo/diff-rules.yaml`, `demo/thresholds.yaml`, `demo/rp.yaml`, `examples/invariants/order-lifecycle.yaml`, and `demo/recording.jsonl`. The commands and output shown were produced on the demo. The names `orders.internal`, `$CANDIDATE_URL`, and `$REFERENCE_URL` stand for your own systems. Your service has its own routes, tags, and fields, so the files are a template and not something to copy unchanged. `docs/operations.md` is the runbook for the same flow and `docs/troubleshooting.md` answers the questions that come up on the way.

## What you need

- `rp` installed. `docs/release.md` describes `npx @replay-parity/cli` and the container image, which work once a release has been published. Until then run `rp` from a clone with `pnpm build`.
- A reference system that clients already use, and a place to put a proxy in front of it.
- A candidate system that can be reset to a known state, and a credential for it. The demo resets with `POST /admin/reset`.
- A secret store for the credentials and, if you redact bodies, for `RP_REDACTION_KEY`.

## 1. Capture

Put `rp capture` between the clients and the reference. It forwards each request, streams the response back unchanged, and records the exchange.

```sh
rp capture --listen :8080 --target https://orders.internal --out recordings/ref.jsonl \
  --tag-rule 'POST /v1/orders=create-order' \
  --tag-rule 'GET /v1/orders/*=get-order' \
  --tag-rule 'POST /v1/orders/*/cancel=cancel-order' \
  --max-exchanges 50000
```

**Tag rules.** `scripts/demo.sh` uses ten, such as `POST /v1/orders=create-order` and `GET /v1/inventory=list-inventory`. A tag names a scenario. The first matching rule wins, and a request that matches none has no tag. The thresholds, the substitutions, the barriers, and the filter all refer to tags, so give every route you care about one.

**Authentication.** The proxy forwards the client's `authorization` header to the reference and writes `<redacted>` in its place in the recording. `authorization`, `cookie`, `set-cookie`, and `x-api-key` are redacted by default, and so are the query parameters `api_key`, `apikey`, `access_token`, `token`, `key`, `secret`, `signature`, and `password`. On replay the engine drops every header whose recorded value is the marker, so the candidate receives a credential only when you supply one with `--header`, as step 4 does.

**Redaction rules.** Bodies are stored as received. If a body carries a credential or personal data, name it in a capture rules file, in the format of `docs/capture.md`:

```yaml
redact:
  body:
    - { path: '$.access_token', mode: drop }
    - { path: '$.customer.email', mode: hash }
```

`drop` writes `<redacted>`. `hash` writes `hmac-sha256:<hex>` keyed by `RP_REDACTION_KEY`, so equal values stay equal. Pass the file with `--capture-rules`, and export the key from your secret store before the capture starts, because the capture refuses to start when a rule hashes and the key is unset. The demo has no personal data, so these two paths are examples of the format. Do not hash an id that also appears in a URL path. Rules cover bodies and query parameters only, so a hashed `order_id` in a body no longer matches the clear id in `/v1/orders/o-1`, and the substitution in step 3 would not find it. In a test capture of the demo with `$..order_id` hashed, the response body held `hmac-sha256:` followed by the digest while the next request's path stayed `/v1/orders/o-1`.

**TLS and sampling.** `--tls-cert` and `--tls-key` make the proxy listen over HTTPS. `--upstream-ca`, `--upstream-cert`, `--upstream-key`, and `--upstream-servername` describe the reference's certificate chain. For high volume, `--sample 0.1 --sample-by header:x-session-id` keeps whole sessions, so a create is kept with the reads that use its id. `docs/operations.md` covers rotation and gzip.

**Look at what you have.** Three commands check a finished recording without sending anything. On the demo:

```sh
rp recording validate demo/recording.jsonl
rp recording stats demo/recording.jsonl --rules demo/diff-rules.yaml
rp recording scan demo/recording.jsonl
```

`stats` prints the exchanges by tag, method, and status class, the body sizes, the largest gap between exchanges, and, with `--rules`, how many exchanges produce a value for each substitution. For the demo it reports 283 exchanges in nine tags, and 47 exchanges that produce an `order_id`, 44 of them distinct. A tag with only a few exchanges will not reach a latency row's `min_samples`, which step 3 deals with. `scan` reports fields that look like personal data. On the demo it reports the redacted `authorization` header on all 283 exchanges and nothing else. Run it on every real capture before the file leaves the machine, and read `SECURITY.md` for how to treat a recording.

## 2. Write diff rules

The rules file tells the differ which differences are expected. Start with the smallest file that can work: the substitutions and the controls, and no ignore rules. This is the demo's `demo/diff-rules.yaml` without its `ignore` entry:

```yaml
substitutions:
  - name: order_id
    capture: { tag: create-order, path: '$.order_id' }
controls:
  tags: [admin-restart, admin-reset]
```

Replay the demo recording with it against a clean candidate and the run fails:

```text
correctness: 282 compared, 130 match, 0 tolerated, 152 mismatch (53.90%), 0 errors (0.00%)
  top mismatching paths: $.created_at x152 in 152 exchanges
```

Each service stamps `created_at` from its own clock, so the value never matches. This is the first thing a real service shows. There are three answers. Write an `ignore` or a `time` rule, let `rp rules suggest` propose one, or replay with `--reference-target`, which step 4 uses.

**Ask the tool.** `rp rules suggest` takes two captures of the same traffic, such as two runs of the load against the reference, pairs their exchanges, and diffs each pair under empty rules.

```sh
rp rules suggest --recording first.jsonl --recording second.jsonl --out suggested.yaml
```

On the demo's traffic, with the two runs a few seconds apart, it reports 152 pairs with differences and suggests one rule, with the evidence in a comment above it:

```yaml
time:
  # differs 152 times across 152 pairs holding it, every value reads as iso8601, at most 330 ms apart
  - { path: '$.created_at', abs_ms: 1000, format: iso8601 }
```

It suggests `ignore`, `time`, and `mask` rules and lists what it cannot explain. It never edits a rules file. Review each entry and copy the ones you accept. The `abs_ms` tolerance covers the gap between the two runs it saw. A replay happens later than the capture, and `created_at` holds the time the candidate stamped it, so the recorded value and the replayed one are as far apart as the recording is old, and a one second rule would not hold. `demo/diff-rules.yaml` chose `ignore: ['$.created_at']` for that reason.

**Check the file.** `rp rules lint` loads the rules and shows how many recorded exchanges each reaches.

```sh
rp rules lint --rules demo/diff-rules.yaml --recording demo/recording.jsonl
```

On the demo it prints `ok ignore[0] ... 152 of 283`, `ok substitution:order_id ... 47 of 48`, and `0 warnings`. A rule that reaches nothing is a `warn` line. That is usually a path typed wrong, or a rule scoped to a tag the recording lacks. `docs/diff-rules.md` describes every key, the `when` scope, and rule packs.

**Substitutions for server assigned ids.** A service assigns its own order ids, so the id in the recording is the reference's and the candidate will assign another. The substitution above captures `$.order_id` from the response of every `create-order` exchange, on the reference from the recording and on the candidate from the replay. A later request that carries the reference's id in its path, query, or body is rewritten to the candidate's id before it is sent, and the differ treats the pair as equivalent. When the service returns the id in a header, capture it from there:

```yaml
substitutions:
  - name: order_id
    capture: { tag: create-order, header: location, pattern: '/orders/([^/]+)$' }
```

A substitution applies to the path, the query, and the body. It does not rewrite headers, so a token that travels in a header is supplied once with `--header` and not substituted. The preflight checks that each capture tag exists and that its path finds a value in the recorded responses.

## 3. Write thresholds

The thresholds file turns the run's statistics into pass or fail rows. `demo/thresholds.yaml` is a working one. It sets `latency.min_samples: 20`, absolute p50 and p99 limits overall and per tag, `correctness.mismatch_rate_max: 0`, `errors.rate_max: 0`, `pacing.slip_max_ms: 250`, and `invariants.fail_on_violation: true`.

Two of its keys matter more on a real recording. A latency row with fewer successful samples than `min_samples` is inconclusive and not failed. The demo sets `list-ledger: { p99_ms: 80, min_samples: 10 }` for a tag that has 16 exchanges. A real recording has tags that are rare, and each one makes the run inconclusive if you leave it out. Either lower `min_samples` for that tag, or give the file a budget:

```yaml
inconclusive: { max_rows: 2 }
```

With the budget, a run where no row failed and at most two rows are inconclusive for lack of samples passes, and the report lists those rows as tolerated. A barrier timeout, an aborted run, and the other run level conditions are never budgeted. `docs/thresholds.md` lists every key and when each row is inconclusive.

## 4. The first replay

Reset the candidate, then replay with the reference as a second target:

```sh
rp replay --recording recordings/ref.jsonl --target "$CANDIDATE_URL" \
  --reference-target "$REFERENCE_URL" \
  --rules diff-rules.yaml --thresholds thresholds.yaml \
  --header 'authorization: Bearer ${CANDIDATE_TOKEN}' \
  --barrier-tag list-ledger --out out/run.json
```

`${CANDIDATE_TOKEN}` is read from the environment when the command runs and is not written to the run. Quote it as shown so the shell leaves it alone.

`--reference-target` sends every exchange to the reference as well, at the same moment as to the candidate. A path where the reference differs from its own recording moved by itself, and the same difference on the candidate is tolerated as noise instead of failing the run. The reference receives every exchange again, writes included, so aim the flag at a copy that can take the traffic. On the demo with the `created_at` ignore rule removed, against the clean candidate, the run passes:

```text
correctness: 282 compared, 130 match, 152 tolerated, 0 mismatch (0.00%), 0 errors (0.00%)
```

The 152 tolerated findings are `$.created_at`, marked `noise:reference`. A threshold on `correctness.noise_rate_max` fails the run if the reference becomes unstable and starts excusing too much. The terminal summary shows the rows, and `rp report --run out/run.json --out report.html` writes the HTML report. Read the correctness section first. A real service will show more paths than the demo did, and each one is either a candidate defect, noise to ignore, or a field to add to the rules. Fix the rules, and replay again until the only mismatches left are ones you mean to look at.

A barrier tag makes its exchanges wait for every earlier exchange to be acknowledged. The demo uses `list-ledger`, a snapshot read, so that it never reads state while a write is in flight. Choose barrier tags for the reads that must see every earlier write.

If a sequential recording takes as long as it ran, that is expected. `docs/troubleshooting.md` explains why and what `--session-key` changes.

## 5. Invariants

Agreement between two systems is not evidence that either is right, so the invariants check each system against its own acknowledgements. For a service that is not the demo's order lifecycle, write a declarative `invariants.yaml`. It needs no code and covers idempotency, monotonic values, read your writes, allowed transitions, and conservation. `examples/invariants/order-lifecycle.yaml` is the demo's file. Running it against the demo recording alone:

```sh
rp invariants --recording demo/recording.jsonl --rules examples/invariants/order-lifecycle.yaml
```

```text
invariants for system (demo/recording.jsonl): 4 hold
   1. holds          idempotency-1 (3 checks)
   2. holds          shipped-never-decreases (119 checks)
   3. holds          quantity-change-visible (2 checks)
   4. holds          order-status (11 checks)
```

Running the rules on the reference's recording first is a cheap audit. A violation there is a defect in the reference, and a rule that cannot hold on the reference is a rule to fix before it is used on a candidate. Then put the file in the replay with `--invariants-rules invariants.yaml`, which evaluates it on both recordings and gates on `invariants.fail_on_violation`. Where the timing cannot order two overlapping exchanges, a rule reports the instance as inconclusive and does not guess. Rules that need code are written as a module, which `docs/invariants.md` describes along with every declarative rule kind.

## 6. A baseline

A passing run becomes the baseline for the next one. Keep its run file, and pass it back:

```sh
rp replay ... --baseline baseline/run.json
```

The `baseline` section of the thresholds then gates this run against the baseline's statistics:

```yaml
baseline:
  latency:
    overall: { p99_ratio_max: 1.2 }
  correctness:
    mismatch_rate_delta_max: 0
  errors: { rate_delta_max: 0.001 }
```

`p99_ratio_max: 1.2` fails the run when the candidate's p99 grew by more than a fifth since the baseline. `mismatch_rate_delta_max: 0` fails it when the mismatch rate grew at all. Without `--baseline` these keys produce no rows and `rp replay` says so, so the first night passes with that message. A baseline from a different recording is refused, because percentiles over different traffic do not compare. When you capture a new recording, start the baseline over. `rp compare a.json b.json` shows two runs side by side.

## 7. The nightly job

Move the settings that do not change into `rp.yaml`, which `demo/rp.yaml` shows in small:

```yaml
replay:
  recording: recordings/ref.jsonl
  rules: diff-rules.yaml
  thresholds: thresholds.yaml
  barrier-tag: [list-ledger]
  invariants-rules: invariants.yaml
  header:
    - 'authorization: Bearer ${CANDIDATE_TOKEN}'
profiles:
  nightly:
    replay:
      reference-target: ${REFERENCE_URL}
```

Then the job is a short script that any scheduler can run. The reset URLs are the demo's `POST /admin/reset`, so replace them with whatever returns your systems to a known state.

```sh
#!/bin/sh
mkdir -p out baseline
rm -f out/run.json
curl -fsS -X POST "$CANDIDATE_URL/admin/reset" >/dev/null || exit 1
curl -fsS -X POST "$REFERENCE_URL/admin/reset" >/dev/null || exit 1

baseline=""
if [ -f baseline/run.json ]; then baseline="--baseline baseline/run.json"; fi

rp replay --profile nightly --target "$CANDIDATE_URL" --out out/run.json $baseline
code=$?
if [ "$code" -eq 1 ]; then exit 1; fi

rp report --run out/run.json --format junit --out out/junit.xml
rp report --run out/run.json --format markdown --out out/summary.md
rp report --run out/run.json --out out/report.html

if [ "$code" -eq 0 ]; then cp out/run.json baseline/run.json; fi
exit "$code"
```

The script passes `--baseline` only when a baseline file exists, because `--baseline` with a missing file is an error. The first night therefore runs without baseline rows and says so, and a pass creates the baseline. The script reports first and gates last, so the artifacts exist whatever the verdict, and it promotes the run to the baseline only on a pass. The exit code is the replay's: 0 for pass, 2 for fail, 3 for inconclusive, and 1 for a tool error, which writes no run file. Publish `out/junit.xml` to the CI system's test report, post `out/summary.md` as a job summary or comment, and keep `out/run.json` and `out/report.html` as artifacts.

For a long recording, add `--exchanges-sidecar` and `--progress` to the profile so a stopped run can be resumed with `--resume` and the log shows progress. For a recording where many users act independently, add `--session-key header:<name>`. Both are in `docs/operations.md`.

When a night comes back inconclusive, `docs/operations.md` lists each condition and what to change. When it fails, open `out/report.html`, and if the failure is an invariant or a mismatch you want reduced, `rp shrink` replays subsets of the recording against a reset candidate and writes a reduced reproduction. `docs/shrinking.md` describes it.
