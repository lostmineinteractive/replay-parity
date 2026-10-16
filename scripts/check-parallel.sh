#!/bin/sh
# The candidate demo service is the reference service plus marked lines.
# This guard fails when the two app.ts files differ anywhere else, or when
# store.ts or catalog.ts differ at all.

set -u
cd "$(dirname "$0")/.." || exit 1

ref=demo/reference-service/src
cand=demo/candidate-service/src
status=0

for f in store.ts catalog.ts; do
  if ! cmp -s "$ref/$f" "$cand/$f"; then
    echo "$f differs between the reference and the candidate"
    status=1
  fi
done

# Every hunk of the app.ts diff must add at least one line carrying a marker,
# and no hunk may be a pure deletion from the reference.
out=$(diff "$ref/app.ts" "$cand/app.ts" | awk '
  /^[0-9]+(,[0-9]+)?[acd][0-9]+(,[0-9]+)?$/ {
    if (hunk != "" && ok == 0) { print "unmarked hunk: " hunk; bad++ }
    hunk = $0; ok = 0
    if ($0 ~ /d/) { print "deletion hunk: " $0; bad++ }
    next
  }
  /^> / { if ($0 ~ /DIVERGENCE|DEFECT/) ok = 1 }
  END {
    if (hunk != "" && ok == 0) { print "unmarked hunk: " hunk; bad++ }
    exit (bad + 0)
  }')
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "$out"
  echo "app.ts differs outside marked lines"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "parallel check passed"
fi
exit $status
