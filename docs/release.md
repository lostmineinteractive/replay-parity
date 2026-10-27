# Releasing

This page states the versioning policy, how a release is cut with changesets, what the release workflow does and the one secret it needs, how a consumer verifies a published package and the image, and how to install `rp`. `docs/ci.md` covers the workflow that runs on every push; this page covers `.github/workflows/release.yml`, which runs on a version tag.

## What is published

| Artifact                                                                                                                                                                         | Where                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `@replay-parity/core`, `capture`, `replay`, `invariants`, `shrink`, `report`, `agent`, and `cli`                                                                                 | npm, public, with provenance |
| `ghcr.io/seesharp15/replay-parity:<version>` and `:latest`, the `rp` command on a distroless base, signed with cosign and carrying a CycloneDX SBOM attestation                  | GitHub Container Registry    |
| A GitHub release named `v<version>` with the eight package tarballs, the CycloneDX SBOM of the repository, the SBOM of the image, and the changelog section as the release notes | GitHub releases              |

The root package, the three demo packages, and `scripts` stay private and are never published.

## Versioning policy

The packages follow semantic versioning and share one version. The eight public packages are a `fixed` group in `.changeset/config.json`, so a bump to any of them bumps all of them, and `@replay-parity/cli@1.4.0` always depends on `@replay-parity/core@1.4.0`.

The public interface is:

- the recording format, one JSON Lines exchange per line as `packages/core` reads and writes it;
- the run schema, `packages/core/schema/run.schema.json`;
- the rules schema, the `diff-rules.yaml` and `thresholds.yaml` keys that `examples/` documents;
- the adapter contract in `docs/writing-adapters.md`;
- the exit codes: 0 pass, 2 fail, 3 inconclusive, 1 tool error.

A breaking change to any of these is a major version with a migration path: a reader that migrates the old format, as `packages/core` already does for older run files, or a command that rewrites it. Adding an optional field, a flag, a rule key, a renderer, or an invariant is a minor version. A fix that changes no interface is a patch. The same rule applies before 1.0, so a 0.x minor never breaks a recording, a run file, a rules file, an adapter, or a script that reads the exit code.

The version lives in the eight `packages/*/package.json` files and nowhere else. `rp --version` reads it from the cli package at run time, and the release workflow refuses a tag whose name does not equal `v` followed by that version.

## Cutting a release

Every pull request that changes a public package carries a changeset. `pnpm changeset` asks which packages changed and whether the bump is major, minor, or patch, then writes a Markdown file under `.changeset/` with the summary for the changelog. The file is committed with the change. A change that touches no public package, such as a docs or CI change, needs no changeset.

When `main` is ready to ship:

1. `pnpm run version`. This runs `changeset version`: it deletes the pending changesets, bumps the eight packages to the new version, and writes each package's `CHANGELOG.md` with a section for that version. The root `CHANGELOG.md` is the hand written build log and is not touched. Note the `run`: pnpm forwards a bare `pnpm version` to npm, which would print version numbers instead of running the script.
2. Review the diff, commit it as `chore(release): v<version>`, and push to `main`.
3. Tag the commit and push the tag: `git tag v<version> && git push origin v<version>`.
4. The workflow runs on the tag. It verifies the tree, publishes the packages, builds and pushes the image, signs it, attests its SBOM, and creates the GitHub release. The run is at Actions, release.

`pnpm release` is the fallback for a machine with `npm login` done: it runs `pnpm build` and then `changeset publish`, which publishes every package whose version is not yet on the registry. A package published this way has no provenance statement, because provenance needs the OIDC token that only the workflow holds, so the fallback is for an emergency and not the normal path.

`workflow_dispatch` runs the same workflow on the current commit of the chosen branch and creates the tag if it does not exist. It is the way to rerun a release whose image or release step failed after the packages were published: `pnpm publish` skips a version that is already on the registry, `cosign sign` and the attestation are idempotent, and the release step updates the release that exists.

## The workflow

The workflow grants the default token `contents: read` and nothing else. Each job that publishes names its own permissions.

| Job           | Needs            | Permissions                                                                   | What it does                                                                                                                                                                                                                                          |
| ------------- | ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`      |                  | `contents: read`                                                              | Checks the tag against the package version, then `pnpm lint`, `pnpm build`, `pnpm test:unit`, `pnpm check-prose`, `pnpm check-secrets`, and `pnpm check-parallel`.                                                                                    |
| `publish-npm` | `verify`         | `contents: read`, `id-token: write`                                           | `pnpm publish -r --access public --no-git-checks` with `NPM_CONFIG_PROVENANCE=true`. pnpm replaces every `workspace:*` range with the version and npm signs a provenance statement with the OIDC token.                                               |
| `sbom`        | `verify`         | `contents: read`                                                              | `anchore/sbom-action` over the repository, CycloneDX JSON from `pnpm-lock.yaml`, uploaded as a run artifact for the release job.                                                                                                                      |
| `image`       | `verify`         | `contents: read`, `packages: write`, `id-token: write`, `attestations: write` | Builds the root `Dockerfile`, pushes `:<version>` and `:latest` to GHCR, signs the digest keyless with `cosign sign --yes`, generates a CycloneDX SBOM of the image, and attests it with `actions/attest-sbom`, which pushes the attestation to GHCR. |
| `release`     | all of the above | `contents: write`                                                             | Packs the eight tarballs, downloads the two SBOMs, takes the release notes from the section for this version in `packages/cli/CHANGELOG.md`, and creates or updates the GitHub release with `gh`.                                                     |

Every action is pinned to a commit SHA with the release tag in a trailing comment, as in `ci.yml`. The procedure for moving a pin is in `docs/ci.md`, and Dependabot's `github-actions` entry covers this workflow too.

The image is built with buildx `provenance` and `sbom` turned off, so the pushed digest is the image manifest itself rather than an index wrapping an attestation manifest. The cosign signature and the SBOM attestation are the image's attestations.

## Secrets and settings the workflow needs

- `NPM_TOKEN`, a repository secret. A granular access token from npmjs.com with read and write access to the `@replay-parity` scope and the two factor requirement set to allow automation. The `publish-npm` job passes it as `NODE_AUTH_TOKEN`. Without it the job fails at the first publish and nothing else is published, because `image` and `sbom` run in parallel with it but `release` waits for all three.
- `GITHUB_TOKEN` covers the rest: the GHCR push, the attestation, and the release. No personal token is involved.
- On npmjs.com the `replay-parity` organization must exist and the token's owner must be a member who can publish to it. The first publish of a scoped package needs `--access public`, which the command and each package's `publishConfig` both set.
- On GitHub, after the first image push, open the package `replay-parity` under the owner's packages, link it to this repository, and set its visibility to public so `docker pull` needs no login.

## Verifying a published package

`npm audit signatures` checks every installed package against the registry's signing keys and, for a package published with provenance, verifies the provenance attestation.

```sh
mkdir verify && cd verify
npm init -y >/dev/null
npm install @replay-parity/cli
npm audit signatures
```

The output names the number of packages with verified registry signatures and the number with verified attestations, and exits non zero when either check fails. The package page on npmjs.com shows a Provenance panel naming this repository, the `release.yml` workflow, and the commit the package was built from. A package published through the `pnpm release` fallback shows no panel.

## Verifying the image

The signature is keyless: cosign recorded the workflow's OIDC identity in the certificate and the signature in the public transparency log. Verify it by naming the issuer and the identity, which is the workflow file at a version tag of this repository:

```sh
cosign verify ghcr.io/seesharp15/replay-parity:<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/seesharp15/replay-parity/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
```

A `workflow_dispatch` run signs with a branch identity, `@refs/heads/main`, so an image released that way needs the regexp widened to `@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/main)$`.

The SBOM attestation is verified with the GitHub CLI, which checks the attestation against the repository's attestations and the transparency log:

```sh
gh attestation verify oci://ghcr.io/seesharp15/replay-parity:<version> \
  --owner seesharp15 --predicate-type https://cyclonedx.org/bom
```

`gh attestation verify ... --format json` prints the SBOM itself. The same SBOM is attached to the GitHub release as `replay-parity-image-<version>.cdx.json`, next to `replay-parity-<version>.cdx.json` for the repository.

## Installing

Without installing anything, `npx` fetches the cli and runs its `rp` binary:

```sh
npx @replay-parity/cli --version
npx @replay-parity/cli replay --recording demo/recording.jsonl --target http://127.0.0.1:3001 \
  --rules demo/diff-rules.yaml --thresholds demo/thresholds.yaml --out run.json
```

As a global install, which puts `rp` on the PATH:

```sh
npm install -g @replay-parity/cli
rp --help
```

As a container. The image has no shell and runs as a non root user (uid 65532), so files are passed through a mount and the user is set to the caller when the command writes:

```sh
docker run --rm ghcr.io/seesharp15/replay-parity:<version> --version
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  ghcr.io/seesharp15/replay-parity:<version> report --run run.json --out report.html
```

A target on the host is reached as `http://host.docker.internal:<port>` from Docker Desktop and with `--network host` on Linux.

As a library, `npm install @replay-parity/core` gives the recording reader and writer, the differ, the statistics, the thresholds, and the run model with its JSON Schema under `schema/`. `@replay-parity/replay` and `@replay-parity/report` are the engine and the renderers. All three are ES modules with type declarations and need Node 22 or later.

## The local dry run

`make release-check` runs `scripts/release-check.sh`, which rehearses the release without publishing, pushing, or tagging anything:

1. `pnpm build`.
2. `pnpm -r --filter './packages/*' pack` into a scratch directory, then for each of the eight tarballs the file list, a check that no `workspace:` range survived, that the package is not marked private, and that `dist/src/index.js` is present.
3. `npm install` of the core tarball alone into a temporary project and `import('@replay-parity/core')`.
4. `npm install` of all eight tarballs into a second temporary project, `rp --version` from the installed bin compared with the version in `packages/cli/package.json`, and a check that the agent's `prompts/` and core's `schema/` arrived.
5. `docker build` of the root `Dockerfile` and `docker run ... --version` when a Docker daemon answers, and a note that the image was skipped otherwise.

`make image` builds the image as `replay-parity-rp:dev`, and `make image-run RP_ARGS="report --run /demo/out/run.json"` runs it with `demo/` mounted read only at `/demo`. Both take `IMAGE=` to name a different tag.

## What a tarball contains

`files` in each `package.json` is the glob `dist/src/**/!(*.test).*`, every built file under `dist/src` except the compiled tests, plus `schema/` for core and `prompts/` for agent. The packlist pnpm uses ignores a leading `!` entry in `files`, which is why the exclusion is an extglob and not a second entry; `scripts/release-check.sh` fails when a tarball lacks `dist/src/index.js`, so a packlist that stopped honoring the glob would be caught before a release. The compiled tests, the `.tsbuildinfo`, and the sources are left out, and `LICENSE` is copied in from the repository root. `exports` and `types` point at `dist/src/index.js` and `dist/src/index.d.ts`, which `pnpm build` produces, and the cli's `bin` points at `dist/src/main.js`, which carries the shebang. Both the cli and the agent locate files relative to their own module: the version from `../../package.json` and the prompts from `../../prompts`, two levels up from `dist/src/`, so they work from a tarball and from the deployed image alike.
