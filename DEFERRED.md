# Deferred

Items noticed during the build that are out of scope for the current step. Each one names the step that raised it and what would change. Nothing here is required for `make demo`.

## From Step 4, the replay engine

- **Compressed bodies.** The capture proxy stores a compressed upstream body as the raw bytes it received, and the replay engine stores a compressed candidate body the same way. Two systems that compress differently therefore differ byte for byte even when the decoded JSON is equal. A transparent decode of `content-encoding` in both places, with the encoding noted on the exchange, would remove that noise.
- **Redis Streams bus coverage in CI.** The `RedisStreamsBus` test runs only when `REDIS_URL` is set. CI could start a Redis service container and set the variable so the test runs on every push.
