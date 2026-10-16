#!/bin/sh
# Fails when any git visible file contains a string that starts with sk-ant-.
# Git visible means tracked files plus untracked files that are not ignored,
# so a gitignored .env is excluded by construction and nothing from it is printed.
# Only file names and line numbers are printed, never the matching text.

set -u
cd "$(dirname "$0")/.." || exit 1

status=0
files=$(git ls-files --cached --others --exclude-standard | grep -v '^scripts/check-secrets.sh$')

for f in $files; do
  [ -f "$f" ] || continue
  hits=$(grep -n -I 'sk-ant-' "$f" 2>/dev/null | cut -d: -f1)
  if [ -n "$hits" ]; then
    for line in $hits; do
      echo "possible secret in $f at line $line"
    done
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "secret check passed"
fi
exit $status
