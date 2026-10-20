# Deferred

Items noticed during the build that are out of scope for the current step. Each one names the step that raised it and what would change. Nothing here is required for `make demo`.

## From Step 8, the agent

- **Prompt caching.** The system prompt and the recording's request shapes are identical across rounds. Marking them with `cache_control` would cut the input cost of every round after the first, which matters once the summary grows past a few thousand tokens.
- **Latency cases need volume.** A single sample cannot find a divergence that fires on five percent of calls. A case could carry a repeat count and the breach could be judged on the sample's percentile.
