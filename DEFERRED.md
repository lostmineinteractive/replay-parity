# Deferred

Items noticed during the build that are out of scope for the current step. Each one names the step that raised it and what would change. Nothing here is required for `make demo`.

## From Step 4, the replay engine

- **Redis Streams bus coverage in CI.** The `RedisStreamsBus` test runs only when `REDIS_URL` is set. CI could start a Redis service container and set the variable so the test runs on every push.

## From Step 7, the demo

- **Top mismatching paths grouped by array position.** The correctness section counts `$.items[0].name` and `$.items[1].name` as two paths. A grouped view that folds array indices into `[*]`, the way the agent's summary already does, would show the inventory ordering divergence as one line instead of forty.

## From Step 8, the agent

- **Dedupe granularity.** A mismatch keys on the exact set of untolerated paths, so two cases that show the same divergence on different fields of the same rows count twice, as cases 1-7 and 1-8 did in the demo run. A key that folds array indices and groups paths by their parent would merge them.
- **Prompt caching.** The system prompt and the recording's request shapes are identical across rounds. Marking them with `cache_control` would cut the input cost of every round after the first, which matters once the summary grows past a few thousand tokens.
- **Latency cases need volume.** A single sample cannot find a divergence that fires on five percent of calls. A case could carry a repeat count and the breach could be judged on the sample's percentile.
