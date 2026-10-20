# Deferred

Items noticed during the build that are out of scope for the current step. Each one names the step that raised it and what would change. Nothing here is required for `make demo`.

## From Step 8, the agent

- **Latency cases need volume.** A single sample cannot find a divergence that fires on five percent of calls. A case could carry a repeat count and the breach could be judged on the sample's percentile.
