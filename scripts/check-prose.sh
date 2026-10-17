#!/bin/sh
# Prose and vocabulary checks for the repository.
# 1. No em dash (U+2014) in any Markdown file.
# 2. No banned financial terms in any tracked text file.
# Exit status 1 when a check fails, 0 otherwise.

set -u
cd "$(dirname "$0")/.." || exit 1

status=0
em_dash=$(printf '\342\200\224')

prune='-path ./node_modules -o -path ./.git -o -path ./coverage -o -path ./demo/out -o -name node_modules -o -name dist'

md_files=$(find . \( $prune \) -prune -o -type f -name '*.md' -print | sort)
for f in $md_files; do
  if grep -n "$em_dash" "$f" >/dev/null 2>&1; then
    echo "em dash found in $f:"
    grep -n "$em_dash" "$f"
    status=1
  fi
done

# Banned vocabulary. Matched as whole words, case insensitive.
banned='bank|banking|settlement|settle|trade|trading|trader|payment|payments|payout|payouts|invoice|invoicing|currency|currencies|broker|brokerage|fintech|wallet|equities|securities|custody|forex'

# Files exempt from the banned term scan, by exact path. The em dash check still
# applies to them. A second document does not inherit the exemption.
banned_exempt='./docs/oms-mapping.md'

text_files=$(find . \( $prune \) -prune -o -type f \( -name '*.md' -o -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.html' -o -name '*.sh' -o -name 'Makefile' -o -name 'Dockerfile' \) -print | grep -v -e 'scripts/check-prose.sh' -e 'pnpm-lock.yaml' | sort)
for f in $text_files; do
  exempt=0
  for e in $banned_exempt; do
    if [ "$f" = "$e" ]; then exempt=1; fi
  done
  if [ "$exempt" -eq 1 ]; then continue; fi
  if grep -n -i -w -E "$banned" "$f" >/dev/null 2>&1; then
    echo "banned term found in $f:"
    grep -n -i -w -E "$banned" "$f"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "prose check passed"
fi
exit $status
