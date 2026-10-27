# Testing

The suite runs under vitest from the repository root. Workspace packages resolve to their TypeScript sources through the aliases in `vitest.config.ts`, so no build is needed before a test run. This page names the two projects, the property based tests and how to replay one of their failures, the chaos tests, and the Makefile targets.

## The two projects

| Project       | Files                                                                                               | Timeouts               | Command          |
| ------------- | --------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- |
| `unit`        | `packages/*/src/**/*.test.ts`, `demo/*/src/**/*.test.ts`                                            | vitest defaults        | `pnpm test:unit` |
| `integration` | `packages/*/test/**/*.int.test.ts`, `demo/*/test/**/*.int.test.ts`, `scripts/test/**/*.int.test.ts` | 30 s per test and hook | `pnpm test:int`  |

`pnpm test` runs both. A unit test sits beside the module it covers and needs no network, file system, or process. An integration test lives in the package's `test` directory and may start servers, write temporary files, or run the whole engine. The Redis Streams bus test needs a server at `REDIS_URL` and is skipped without it.

`pnpm test:coverage` runs both projects under v8 coverage with a 90 percent threshold on lines, branches, functions, and statements for `packages/core`. Test files, `index.ts` barrels, and `testing.ts` builders are excluded from the measurement.

## Property based tests

Property based tests use `fast-check` and live in the unit project in files named `<module>.prop.test.ts` beside the module. Each file builds its own arbitraries for the inputs it needs, bounded in depth and size so a run stays fast, and every property runs 200 times with the fixed seed `20261027`. The whole set adds a few tens of milliseconds to the unit project.

| File                                              | Properties                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/differ/diff.prop.test.ts`      | `diff(x, x)` matches for any response and rules; findings do not depend on key order; permutations match under keyless and keyed `unordered` rules; finding paths parse; two runs agree; the verdict follows the findings.  |
| `packages/core/src/json.prop.test.ts`             | `canonicalJson` ignores key order and is `JSON.stringify` with sorted keys; `deepEqual` agrees with an independent structural equality and holds exactly when the canonical texts are equal.                                |
| `packages/core/src/jsonpath/index.prop.test.ts`   | `parsePath` and `renderPath` round trip in both directions; alternative spellings parse alike; a rule built from a concrete path by inserting wildcards matches it; `select` returns only what `get` reaches.               |
| `packages/replay/src/substitutions.prop.test.ts`  | An empty table returns the request itself; a value that was not captured is never rewritten and the request's shape is kept; a disjoint table is idempotent; `dependenciesOf` returns only earlier producers.               |
| `packages/core/src/recording/body.prop.test.ts`   | `encodeBody` and `decodeBody` round trip JSON and bytes; empty bytes are absent; a coded body stores the same body as the plain bytes with the coding noted; a body over the cap is truncated with the right hash and size. |
| `packages/core/src/recording/reader.prop.test.ts` | `parseRecordingText` round trips any list of exchanges with non decreasing offsets under any mix of blank lines and line endings, and rejects a decreasing offset naming the line.                                          |
| `packages/capture/src/ordered-sink.prop.test.ts`  | `OrderedSink` emits in reservation order under any completion order, null slots, and emit failures, and `idle()` resolves.                                                                                                  |
| `packages/core/src/stats/histogram.prop.test.ts`  | `exactSummary` percentiles are monotone, the mean lies between min and max, the result does not depend on sample order, and every percentile is a sample.                                                                   |

### Reproducing a failure

A failing property prints the seed, the path to the failing case, and the shrunk counterexample:

```
Error: Property failed after 31 tests
{ seed: 20261027, path: "30:0:3:1:1:1:1:2:2:2", endOnFailure: true }
Counterexample: [{"ignore":[],"tolerances":[],"unordered":[{"path":"$","key":"$.a"}],...},[[]],[]]
Shrunk 9 time(s)
```

The counterexample is the list of generated arguments in the order the property declares them, after shrinking. To replay exactly that case, pass the printed seed and path to the same `fc.assert` call:

```ts
fc.assert(property, { seed: 20261027, path: '30:0:3:1:1:1:1:2:2:2', endOnFailure: true });
```

With the path given, fast-check skips straight to the failing case. Add `verbose: true` to see every failing value met during shrinking. The seed is fixed in each file, so the same run on any machine draws the same inputs, and the counterexample can be copied into an example based test once the cause is understood. To search more widely on a local machine, raise `numRuns` or drop the seed for one run and note the seed fast-check prints.

### Defects the properties found

The first run of the properties found three defects, each recorded as an `it.fails` test with the exact inputs in a comment until it was fixed. All three are fixed and the tests are plain tests now, kept as regression examples beside the widened properties.

- `diff.prop.test.ts`: a keyed unordered rule rendered key names and values unescaped into `[name=value]`, so a key holding a quote mark, an array, or an object produced a finding path `parsePath` rejected. Keyed segments now quote every form that the bare syntax cannot hold, and every finding path reads back as itself.
- `diff.prop.test.ts`: `keyValueText` rendered the number `1` and the string `"1"` as the same text, so rows keyed by each shared a group. A string now renders bare only when it looks like an identifier, so the two differ.
- `body.prop.test.ts`: `decodeContentEncoding` bounded every coding layer by the cap, so a small body under `gzip, br` was truncated. Only the final decoded size is held to the cap; inner layers get a generous bound that still stops a decompression bomb.

A property that fails again prints its seed and path; see the section above to reproduce it.

## Chaos tests

`packages/replay/test/chaos.int.test.ts` starts a `node:http` stand in that misbehaves on purpose and asserts how the HTTP adapter classifies each failure and how a run reports it. Every test carries a five second limit.

| Route                         | Behavior                                                         | Assertion                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/half-body`                  | Headers and half of a 64 byte body, then the socket is destroyed | A `SendError` of kind `connection` (undici reports a socket error), never `other`.                                     |
| `/never`                      | Never answers                                                    | Kind `timeout`, and the measured time is within a few hundred milliseconds of the configured deadline.                 |
| `/bad-gzip`, `/bad-gzip-json` | `content-encoding: gzip` over bytes that are not gzip            | The body is stored as received by the usual rules, base64 or parsed JSON, with no `content_encoding` note.             |
| `/flaky`                      | Every third request gets a 503 status line and no body           | Through `replayExchanges`, the run fails on `errors.rate_max` at one third and the three exchanges record their kinds. |
| `/flaky-clean`                | Every third request is a complete 503                            | The exchanges are compared and mismatch on status; the error rate stays zero, since only transport failures count.     |
| `/close-before-headers`       | The socket is destroyed before any header                        | Kind `connection`.                                                                                                     |

## Makefile targets

| Target                                    | Runs                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `make install`                            | `pnpm install --frozen-lockfile`                                                           |
| `make build`, `make typecheck`            | `tsc -b`                                                                                   |
| `make lint`                               | eslint and a prettier check                                                                |
| `make format`                             | prettier and eslint with fixes applied                                                     |
| `make test`                               | both vitest projects                                                                       |
| `make test-unit`, `make test-int`         | one project                                                                                |
| `make coverage`                           | both projects under coverage                                                               |
| `make check-prose`                        | no em dash in Markdown and no banned vocabulary in any text file, `scripts/check-prose.sh` |
| `make check-secrets`                      | no key shaped string in any git visible file, `scripts/check-secrets.sh`                   |
| `make check-parallel`                     | the candidate demo service differs from the reference only at marked lines                 |
| `make check`                              | lint, typecheck, test, and the three guards, which is what CI runs                         |
| `make recording`                          | rebuilds `demo/recording.jsonl` through the capture proxy                                  |
| `make bench-capture`, `make bench-replay` | the throughput benchmarks against `REFERENCE_URL` and `CANDIDATE_URL`                      |
| `make demo`, `make demo-down`             | the end to end demo with docker compose, and its teardown                                  |
| `make screenshots`                        | refreshes the report images in `docs/images`                                               |
| `make clean`                              | removes build output, coverage, and `demo/out`                                             |
