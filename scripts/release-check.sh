#!/bin/sh
# make release-check. A local dry run of the release. Builds the workspace,
# packs every public package into a scratch directory, lists each tarball,
# checks that no workspace: range survived the pack, installs core alone and
# then the cli with every tarball into temporary projects, imports core and
# runs rp --version from the installed bin, and builds the rp image when a
# Docker daemon is reachable. Nothing is published, pushed, or tagged.
set -eu
cd "$(dirname "$0")/.."

PNPM=${PNPM:-pnpm}
IMAGE=${IMAGE:-replay-parity-rp:dev}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/replay-parity-release-check.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM
tarballs="$scratch/tarballs"
mkdir -p "$tarballs"

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "release-check: $*" >&2; exit 1; }

expected=$(node -p "require('./packages/cli/package.json').version")

step "building the workspace"
$PNPM build

step "packing every public package into $tarballs"
$PNPM -r --filter './packages/*' pack --pack-destination "$tarballs" >/dev/null
count=$(ls "$tarballs"/*.tgz | wc -l | tr -d ' ')
[ "$count" -eq 8 ] || fail "expected 8 tarballs, found $count"

for t in "$tarballs"/*.tgz; do
  step "$(basename "$t")"
  tar -tzf "$t" | sed 's#^package/##' | sort
  manifest=$(tar -xzOf "$t" package/package.json)
  if echo "$manifest" | grep -q 'workspace:'; then fail "$(basename "$t") still carries a workspace: range"; fi
  if echo "$manifest" | grep -q '"private": true'; then fail "$(basename "$t") is marked private"; fi
  tar -tzf "$t" | grep -q '^package/dist/src/index.js$' || fail "$(basename "$t") has no dist/src/index.js"
done

step "installing core from its tarball alone and importing it"
core_dir="$scratch/core-consumer"
mkdir -p "$core_dir"
(
  cd "$core_dir"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error "$tarballs"/replay-parity-core-*.tgz >/dev/null
  node -e "import('@replay-parity/core').then((m) => { if (typeof m.EXIT_CODES !== 'object') throw new Error('EXIT_CODES missing'); console.log('import of @replay-parity/core ok, exit codes', JSON.stringify(m.EXIT_CODES)); })"
)

step "installing the cli from the tarballs and running rp --version"
cli_dir="$scratch/cli-consumer"
mkdir -p "$cli_dir"
(
  cd "$cli_dir"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error "$tarballs"/*.tgz >/dev/null
  version=$(./node_modules/.bin/rp --version)
  echo "rp --version printed $version"
  [ "$version" = "$expected" ] || fail "expected $expected from the installed bin"
  ./node_modules/.bin/rp --help | head -3
  [ -f node_modules/@replay-parity/agent/prompts/system.md ] || fail "agent prompts missing from the installed package"
  [ -f node_modules/@replay-parity/core/schema/run.schema.json ] || fail "core schema missing from the installed package"
)

step "building the rp image"
if docker info >/dev/null 2>&1; then
  docker build -f Dockerfile -t "$IMAGE" .
  echo "image $IMAGE reports version $(docker run --rm "$IMAGE" --version)"
else
  echo "no Docker daemon reachable, image build skipped"
fi

echo
echo "release check passed for version $expected"
