# ADR 0013: Configuration is layered and checked first

Status: Accepted

Date: 2026-10-27, the date of commit `33e96fb`, which introduced it.

## Context

Every setting was a flag, with no config file and no preflight. A tag named in the thresholds that the recording lacked produced an inconclusive row at the end of a long replay.

## Decision

Every long flag of every command can be a key in `rp.yaml` under the command's name. A profile overrides the top level, an `RP_<COMMAND>_<FLAG>` variable overrides the profile, and a flag on the command line overrides everything, with a list replaced whole at each layer. The schema is derived from the registered commander options, so an unknown key or a value a flag's parser rejects is an error naming the key. Any string may hold `${NAME}`, resolved from the environment when the command runs and never written to the run, the candidate recording, or the output of `rp doctor`. Before anything is sent, `rp validate`, and the same preflight inside `rp replay`, `rp shrink`, and `rp agent`, checks the recording against the thresholds, the rules, and the barrier tags and probes the URLs it is asked to.

## Consequences

- A misspelled tag fails at the start with exit 1 and no run file.
- Secrets stay in the environment and out of the file and the run.
- `--no-preflight` keeps the earlier behavior for a recording that legitimately lacks a tag, and the row is then inconclusive as before.
