# Contributing

This page says how to set up the repository, what a change has to pass, and where each kind of change is recorded. Report a security problem through the process in `SECURITY.md` and not through an issue or a pull request.

## Setup

The repository is a pnpm workspace on Node 22 or later. `.nvmrc` names Node 22, and the `packageManager` field of `package.json` names the pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` runs `tsc -b`, which is also the typecheck. The tests resolve the workspace packages to their TypeScript sources, so a test run needs no build. The CLI does need one, so run `pnpm build` before `node packages/cli/dist/src/main.js --help`. `make demo` needs Docker as well, and the committed demo recording replays without it as the README shows.

## Running the checks

`make check` is the command to run before you push. It runs lint, the typecheck, the tests, and the three guards in the order CI runs them. `docs/ci.md` maps each CI step to its Makefile target, and the pull request template asks you to confirm that it passes.

| Command               | What it runs                                |
| --------------------- | ------------------------------------------- |
| `make check`          | lint, typecheck, test, and the three guards |
| `make lint`           | eslint, then prettier in check mode         |
| `make format`         | prettier and eslint with fixes applied      |
| `make test`           | both vitest projects                        |
| `make coverage`       | both projects under v8 coverage             |
| `make test-unit`      | the unit project only                       |
| `make test-int`       | the integration project only                |
| `make check-prose`    | the prose guard                             |
| `make check-secrets`  | the secrets guard                           |
| `make check-parallel` | the guard on the two demo services          |

Run `pnpm exec prettier --write` on every file you change, Markdown included. `make lint` fails on a file that is not formatted.

## Tests

The suite has two vitest projects, and `docs/testing.md` describes both.

- `unit` covers `packages/*/src/**/*.test.ts` and the demo sources. A unit test sits beside the module it covers and needs no network, file system, or process. Each has a 20 second limit.
- `integration` covers `packages/*/test/**/*.int.test.ts`, the demo tests, and `scripts/test/**/*.int.test.ts`. These tests may start servers, write temporary files, or run the whole engine. Each has a 60 second limit and each hook 30 seconds.

Property based tests use `fast-check`, live in `<module>.prop.test.ts` files beside the module, and run every property 200 times under the fixed seed `20261027`. `docs/testing.md` explains how to replay a failure from its printed seed and path.

The Redis Streams bus test runs only when `REDIS_URL` points at a server, and CI starts one. Locally it is skipped without the variable.

### The timing policy

A test that depends on time follows the policy in `docs/testing.md` under "Timing in tests". The short form:

- Judge ordering and spacing from the run's own fields, `scheduled_at_ms`, `sent_at_ms`, `acked_at_ms`, and `duration_ms`, and not from a stopwatch around the call.
- Give any absolute upper bound at least 1500 ms of slack over the figure a quiet machine produces, and write a comment saying what was observed and why the bound is what it is.
- Give a test with such a bound `retry: 2` and an `onTestFailed` hook that prints what the failed attempt saw, so a retry is never silent. `logFailedAttempt` in `packages/replay/test/engine.int.test.ts` is the model.
- Give a wait on a condition a deadline far above its quiet figure. It guards against a hang and is not an assertion.
- A test that expects a `pass` verdict from a candidate running in the test's own process gates on the correctness and error rows, because that process shares the worker's stalls.

A vitest worker has stalled for about 9 seconds on a macOS machine when another suite ran at the same time, and the suite is expected to pass under that load. The check is `pnpm test` run three times while `pnpm exec vitest run --project unit` runs in another process. `DEFERRED.md` records that the cause is open.

## The prose and secrets guards

Two scripts run in `make check` and in CI.

- `scripts/check-prose.sh` fails on an em dash in any Markdown file, and on a word from its banned list in any tracked text file. The list is in the script, so read it before you write. One file is exempt from the vocabulary scan by exact path, and the em dash check still applies to it. Write plain declarative sentences, and leave out marketing language.
- `scripts/check-secrets.sh` fails when any file that git can see, tracked or untracked and not ignored, contains a string that begins with the Anthropic API key prefix. It prints file names and line numbers and never the matching text. A key belongs in the environment or in the gitignored `.env`.

`scripts/check-parallel.sh` is the third guard. It fails when the candidate demo service differs from the reference anywhere but the marked divergence lines.

## Commits

Commit messages follow Conventional Commits: `type(scope): subject`, with the subject in the imperative and a body that says why when the subject does not. The types in this repository's history are `feat`, `fix`, `test`, `docs`, `build`, `perf`, and `chore`, as in `chore(release): v<version>`. The scope is a package or an area, such as `feat(replay)`, `fix(invariants)`, `test(cli)`, and `perf(preflight)`. A change that touches only documentation is `docs:`.

## Changesets

A pull request that changes a public package carries a changeset. Run `pnpm changeset`, choose the packages and whether the bump is major, minor, or patch, and write the summary the changelog will show. Commit the file in `.changeset/` with the change. The eight public packages are a fixed group and share one version. A change that touches no public package, such as a documentation or CI change, needs no changeset. `docs/release.md` has the versioning policy and the release steps.

Separately, `CHANGELOG.md` at the root is the hand written build log. Add an entry under Unreleased that says what was added, which flags or files, and how it was verified, in the style of the entries already there.

## Where documentation lives

| Place                                                                  | Holds                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                            | What the tool is, the demo, how to run it against a real system, the measured figures, the design notes, the limits |
| `docs/architecture.md`, `docs/adr/`                                    | The packages and the decisions, with one record per decision                                                        |
| `docs/configuration.md`                                                | `rp.yaml`, profiles, `RP_` variables, interpolation, `rp validate`, the preflight, `rp doctor`                      |
| `docs/capture.md`                                                      | The manifest, session sampling, rotation, redaction, lossless numbers, and HAR import                               |
| `docs/recording-tools.md`                                              | `rp recording` and the recording hash                                                                               |
| `docs/diff-rules.md`                                                   | Every key of the rules file, scopes, rule packs, `rp rules lint` and `suggest`                                      |
| `docs/thresholds.md`                                                   | Every key of the thresholds file, baselines, noise, and the inconclusive budget                                     |
| `docs/invariants.md`                                                   | The module contract, the declarative rules, and the built in rules                                                  |
| `docs/shrinking.md`                                                    | `rp shrink`: rules, reset strategies, lowering, parallel targets, the cache                                         |
| `docs/writing-adapters.md`                                             | The adapter contract, TLS and proxy options, plugins, the bus                                                       |
| `docs/report-format.md`                                                | Every field of the run file, the inconclusive kinds, and the exit codes                                             |
| `docs/observability.md`                                                | The logger, progress, the trace header, and the metrics endpoint                                                    |
| `docs/operations.md`, `docs/real-system.md`, `docs/troubleshooting.md` | The runbook, the walkthrough from a service to a nightly job, and the questions that come up                        |
| `docs/testing.md`, `docs/ci.md`, `docs/release.md`                     | The test suite, the CI workflow, and releasing                                                                      |
| `SECURITY.md`                                                          | How to report a vulnerability, what the tool stores, what redaction covers, what the agent sends                    |
| `DEFERRED.md`                                                          | What was noticed and left out, with the item that raised it                                                         |
| `examples/`                                                            | Rules, thresholds, `rp.yaml`, invariants, rule packs, and an adapter, each with every key explained                 |

Change the page that owns a behavior in the same pull request that changes the behavior, and record anything you noticed and chose not to do in `DEFERRED.md`. `CODEOWNERS` in `.github/` names the reviewer for every path.
