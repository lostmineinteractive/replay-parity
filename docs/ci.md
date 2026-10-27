# Continuous integration

The workflow in `.github/workflows/ci.yml` runs on every push and every pull request. This page names each job, says which of them block a merge, explains how a pinned action is updated, and maps each CI step to the Makefile target that runs it locally.

## Workflow wide settings

The workflow grants the default token `contents: read` and nothing else. A job that needs more declares its own `permissions` block, and today only `supply-chain` does, for `pull-requests: read`.

Runs are grouped by workflow name and ref. A newer push to a pull request or to a feature branch cancels the run in progress for that ref. Pushes to the default branch never cancel each other, so every commit on `main` gets a complete run.

Every action is pinned to a full commit SHA with the release tag in a trailing comment. Dependabot keeps the SHAs current. The section on updating a pinned action below gives the manual procedure.

pnpm is installed by `pnpm/action-setup` at the version named in the `packageManager` field of `package.json`, and `actions/setup-node` restores the pnpm store from the Actions cache keyed on `pnpm-lock.yaml`. There is no `corepack enable` step because the action installs the same version corepack would.

## Jobs

### checks

Ubuntu, Node 22. Starts `redis:7-alpine` as a service container with a health check and sets `REDIS_URL` for the test step, so the Redis Streams bus test runs instead of being skipped. The steps are `pnpm lint` (eslint and prettier in check mode), `pnpm build` (`tsc -b`, which is also the typecheck), `pnpm test:coverage` (the unit and integration projects with v8 coverage, and the 90 percent thresholds on `packages/core`), and the three guards: `pnpm check-prose`, `pnpm check-secrets`, and `pnpm check-parallel`. The last step prints the head of `coverage/coverage-summary.json` and runs even when an earlier step failed.

### unit-matrix

Three runners, `pnpm install --frozen-lockfile` and `pnpm test:unit` only: Node 24 on `ubuntu-latest`, Node 22 on `macos-latest`, and Node 22 on `windows-latest`. `fail-fast` is off, so one failing runner does not cancel the other two. The Windows job has `continue-on-error: true` and is informational until the suite has been verified there. Its result is shown on the run and does not fail the workflow.

### supply-chain

Ubuntu. Checks out the full history and runs two scanners, both blocking.

`gitleaks/gitleaks-action` scans every commit of the push or the pull request with the default gitleaks rules. Pull request commenting is turned off because the token has no write permission. Findings go to the job summary and the log, and a SARIF file is uploaded as a run artifact when there are any. The repository belongs to a personal account, so no `GITLEAKS_LICENSE` is needed. An organization owned fork needs one as a secret.

`google/osv-scanner-action` scans `pnpm-lock.yaml` against the OSV database. The step fails when any locked version has a known vulnerability. There is no allowlist today. When a finding has no fix, the resolution is an `osv-scanner.toml` at the repository root with the vulnerability id and a reason, reviewed like any other change.

### demo

Ubuntu, Node 22, depends on `checks`. Builds the demo images with `docker compose`, runs `make demo` with an empty `ANTHROPIC_API_KEY` so the agent step prints its no key message and exits 0, stops the containers, and uploads the four reports, the three run files, and the reduced reproduction as the `demo-reports` artifact.

## What blocks a merge

These status checks must pass before a pull request can be merged. Branch protection on `main` should require each of them by name:

| Check                                 | Blocks | Note                                            |
| ------------------------------------- | ------ | ----------------------------------------------- |
| `lint, typecheck, test, guards`       | Yes    | The `checks` job                                |
| `unit tests, ubuntu-latest, Node 24`  | Yes    |                                                 |
| `unit tests, macos-latest, Node 22`   | Yes    |                                                 |
| `unit tests, windows-latest, Node 22` | No     | `continue-on-error` until the suite is verified |
| `secrets scan and dependency audit`   | Yes    | gitleaks and OSV, both blocking                 |
| `make demo without the agent`         | Yes    | Runs only after `checks` passes                 |

A failing coverage threshold fails `pnpm test:coverage` and therefore `checks`. A gitleaks finding or an OSV finding fails `supply-chain`. A Windows failure is visible on the run and in the pull request's check list but does not block.

## Updating a pinned action

Each `uses:` line has the form `owner/repo@<commit sha> # vX.Y.Z`. To move an action to a new release, resolve the tag to a commit with the GitHub API and replace both the SHA and the comment. Never copy a SHA from a blog post or a chat message.

```sh
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.type + " " + .object.sha'
```

When the type is `commit`, that SHA is the pin. When the type is `tag`, the ref points at an annotated tag object and one more call dereferences it to the commit:

```sh
gh api repos/pnpm/action-setup/git/tags/<tag object sha> --jq '.object.type + " " + .object.sha'
```

Confirm the commit exists and belongs to the release before pinning it:

```sh
gh api repos/actions/checkout/commits/<sha> --jq '.commit.committer.date + " " + (.commit.message | split("\n")[0])'
```

Then read the release notes for input changes, edit every occurrence of the action in `ci.yml`, and run `actionlint` and `pnpm lint` before committing. Dependabot opens the same change weekly under the `github-actions` ecosystem, so the manual procedure is for an urgent update between those runs.

## Running the checks locally

Every blocking step in `checks` has a Makefile target. `make check` runs them all in the CI order.

| CI step                                  | Makefile target       | What it runs                                |
| ---------------------------------------- | --------------------- | ------------------------------------------- |
| Install                                  | `make install`        | `pnpm install --frozen-lockfile`            |
| Lint and format check                    | `make lint`           | `eslint .` and `prettier --check .`         |
| Typecheck and build                      | `make build`          | `tsc -b`                                    |
| Unit and integration tests with coverage | `make coverage`       | `vitest run --coverage`                     |
| Unit tests only, as in `unit-matrix`     | `make test-unit`      | `vitest run --project unit`                 |
| Integration tests only                   | `make test-int`       | `vitest run --project integration`          |
| Prose guard                              | `make check-prose`    | `scripts/check-prose.sh`                    |
| Secrets guard                            | `make check-secrets`  | `scripts/check-secrets.sh`                  |
| Parallel services guard                  | `make check-parallel` | `scripts/check-parallel.sh`                 |
| All of the above except coverage         | `make check`          | lint, typecheck, test, and the three guards |
| The demo job                             | `make demo`           | `scripts/demo.sh`, needs Docker             |

The Redis Streams bus test is skipped locally unless `REDIS_URL` points at a server. `docker run --rm -p 6379:6379 redis:7-alpine` and `REDIS_URL=redis://127.0.0.1:6379 make test` run it the way CI does.

The two scanners in `supply-chain` have no Makefile target. With `gitleaks` and `osv-scanner` installed from Homebrew or their release pages, the equivalent commands from the repository root are `gitleaks git --no-banner .` for the history and `osv-scanner --lockfile=pnpm-lock.yaml` for the lockfile.
