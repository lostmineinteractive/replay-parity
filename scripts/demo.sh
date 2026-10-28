#!/bin/sh
# make demo. Builds the workspace, starts the demo pair with docker compose,
# records load against the reference through the capture proxy, and runs
# three replays against three candidates:
#   1. the classic candidate with the four planted divergences (fails),
#      under the strict rules and again under the unordered rules,
#   2. the clean candidate with DIVERGENCES=off (passes),
#   3. one seeded defect, DEMO_DEFECT (default shipment-applied-twice),
#      caught by the invariants and reduced by rp shrink.
# Reports land in demo/out. The agent runs when ANTHROPIC_API_KEY is set,
# from the shell or from a gitignored .env at the repository root.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

OUT=demo/out
REF_PORT=${DEMO_REFERENCE_PORT:-3000}
CAND_PORT=${DEMO_CANDIDATE_PORT:-3001}
CLEAN_PORT=${DEMO_CLEAN_PORT:-3002}
DEFECT_PORT=${DEMO_DEFECT_PORT:-3003}
PROXY_PORT=${DEMO_PROXY_PORT:-8080}
export DEMO_DEFECT=${DEMO_DEFECT:-shipment-applied-twice}
export DIVERGENCES=${DIVERGENCES:-on}
PNPM=${PNPM:-pnpm}
RP="node packages/cli/dist/src/main.js"
LOAD="node demo/load/dist/src/main.js"
COMPOSE="docker compose -f demo/docker-compose.yml"

step() { printf '\n==> %s\n' "$*"; }

# A replay exits 2 on fail and 3 on inconclusive. Those are results, not errors.
replay() {
  set +e
  $RP replay "$@"
  code=$?
  set -e
  if [ "$code" -eq 1 ]; then
    echo "demo: replay failed with a tool error" >&2
    exit 1
  fi
  return 0
}

mkdir -p "$OUT"
for f in "${OUT:?}"/*.json "${OUT:?}"/*.jsonl "${OUT:?}"/*.html; do
  [ -e "$f" ] && rm -f -- "$f"
done

step "building the workspace"
$PNPM build

step "starting the demo pair with docker compose (candidate DIVERGENCES=$DIVERGENCES, defect $DEMO_DEFECT)"
$COMPOSE up --build -d --wait

# Every service starts from its initial state, so a rerun of make demo is a
# fresh run even when the containers were already up.
reset() {
  curl -fsS -X POST "http://127.0.0.1:$1/admin/reset" >/dev/null || {
    echo "demo: reset of the service on port $1 failed" >&2
    exit 1
  }
}

step "resetting the four services"
for port in "$REF_PORT" "$CAND_PORT" "$CLEAN_PORT" "$DEFECT_PORT"; do reset "$port"; done

step "recording load against the reference through the capture proxy on :$PROXY_PORT"
$RP capture --listen "127.0.0.1:$PROXY_PORT" --target "http://127.0.0.1:$REF_PORT" \
  --out "$OUT/recording.jsonl" --no-append \
  --tag-rule 'POST /v1/orders=create-order' \
  --tag-rule 'GET /v1/orders/*=get-order' \
  --tag-rule 'POST /v1/orders/*/cancel=cancel-order' \
  --tag-rule 'POST /v1/orders/*/quantity=set-quantity' \
  --tag-rule 'POST /v1/orders/*/shipments=ship-order' \
  --tag-rule 'GET /v1/inventory=list-inventory' \
  --tag-rule 'POST /v1/inventory/*/adjust=adjust-stock' \
  --tag-rule 'GET /v1/ledger=list-ledger' \
  --tag-rule 'POST /admin/restart=admin-restart' \
  --tag-rule 'POST /admin/reset=admin-reset' &
CAPTURE_PID=$!
# Wait for the proxy socket without sending a request through it, so the
# recording holds the load generator's traffic and nothing else.
i=0
until node -e "require('node:net').connect($PROXY_PORT, '127.0.0.1').once('connect', () => process.exit(0)).once('error', () => process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then echo "demo: capture proxy did not start" >&2; exit 1; fi
  sleep 0.2
done
$LOAD --target "http://127.0.0.1:$PROXY_PORT"
kill -TERM "$CAPTURE_PID"
wait "$CAPTURE_PID"

# The shared replay settings (recording, pacing, concurrency, thresholds,
# barrier tag, invariants) live in demo/rp.yaml. The profile picks the rules
# file. The target, the run file, and the candidate recording differ per
# replay and stay on the command line.
CONFIG="--config demo/rp.yaml"

step "replay 1: classic candidate, strict rules (expected FAIL on the four divergences)"
replay $CONFIG --profile strict --target "http://127.0.0.1:$CAND_PORT" \
  --candidate-recording "$OUT/candidate.jsonl" --out "$OUT/run.json"
$RP report --run "$OUT/run.json" --out "$OUT/report.html"

step "replay 1b: classic candidate, unordered rules (ordering tolerated)"
reset "$CAND_PORT"
replay $CONFIG --profile unordered --target "http://127.0.0.1:$CAND_PORT" \
  --out "$OUT/run-unordered.json" --quiet
$RP report --run "$OUT/run-unordered.json" --out "$OUT/report-unordered.html"

step "replay 2: clean pair, DIVERGENCES=off (expected PASS)"
replay $CONFIG --profile strict --target "http://127.0.0.1:$CLEAN_PORT" \
  --candidate-recording "$OUT/candidate-clean.jsonl" --out "$OUT/run-clean.json"
$RP report --run "$OUT/run-clean.json" --out "$OUT/report-clean.html"

step "replay 3: seeded defect $DEMO_DEFECT (expected FAIL on invariants), then shrink"
replay $CONFIG --profile strict --target "http://127.0.0.1:$DEFECT_PORT" \
  --candidate-recording "$OUT/candidate-defect.jsonl" --out "$OUT/run-defect.json"
$RP shrink --run "$OUT/run-defect.json" --recording "$OUT/recording.jsonl" \
  --target "http://127.0.0.1:$DEFECT_PORT" --reset "http://127.0.0.1:$DEFECT_PORT/admin/reset" \
  --out "$OUT/reduced-reproduction.jsonl"
$RP report --run "$OUT/run-defect.json" --out "$OUT/report-defect.html"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -f packages/cli/dist/src/commands/agent.js ]; then
    step "agent: two rounds against the classic candidate"
    set +e
    $RP agent --run "$OUT/run.json" --recording "$OUT/recording.jsonl" \
      --target "http://127.0.0.1:$CAND_PORT" --reference "http://127.0.0.1:$REF_PORT" \
      --rules demo/diff-rules.yaml --thresholds demo/thresholds.yaml \
      --out "$OUT/generated-cases.jsonl" --budget-usd 2 --max-rounds 2
    set -e
    $RP report --run "$OUT/run.json" --out "$OUT/report.html"
  else
    step "agent: ANTHROPIC_API_KEY is set but rp agent is not built yet (build step 8)"
  fi
else
  step "agent skipped: ANTHROPIC_API_KEY is not set"
fi

step "done"
echo "reports:"
for f in report report-unordered report-clean report-defect; do
  echo "  $OUT/$f.html"
done
echo "runs: $OUT/run.json $OUT/run-unordered.json $OUT/run-clean.json $OUT/run-defect.json"
echo "recording: $OUT/recording.jsonl, reduced reproduction: $OUT/reduced-reproduction.jsonl"
echo "stop the services with: make demo-down"
