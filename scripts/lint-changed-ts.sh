#!/usr/bin/env bash
# Lint and format-check files changed from origin/main through the current working tree.

set -euo pipefail

BASE="$(git merge-base origin/main HEAD 2>/dev/null || true)"
if [ -z "$BASE" ]; then
  echo "error: could not find merge-base with origin/main" >&2
  echo "Run: git fetch origin main" >&2
  exit 1
fi

all_changed_files=()
while IFS= read -r file; do
  [ -f "$file" ] && all_changed_files+=("$file")
done < <(
  {
    git diff --name-only "$BASE"
    git diff --cached --name-only "$BASE"
    git ls-files --others --exclude-standard
  } | awk 'NF && !seen[$0]++'
)

npm run check:developer-paths
npm run guard:bridge-llm
npm run guard:pr-coordination-writers

prettier_files=()
ts_files=()
if [ "${#all_changed_files[@]}" -gt 0 ]; then
  for file in "${all_changed_files[@]}"; do
    case "$file" in
      *.ts | *.tsx)
        ts_files+=("$file")
        prettier_files+=("$file")
        ;;
      *.js | *.jsx | *.cjs | *.mjs | *.cts | *.mts | *.json | *.md | *.yml | *.yaml | *.css | *.html)
        prettier_files+=("$file")
        ;;
    esac
  done
fi

if [ "${#prettier_files[@]}" -ne 0 ]; then
  echo "Checking formatting for changed files..."
  npx prettier --check --ignore-unknown "${prettier_files[@]}"
fi

if [ "${#ts_files[@]}" -eq 0 ]; then
  echo "No changed TypeScript files to lint between origin/main and the working tree."
  exit 0
fi

echo "Linting changed TypeScript files before publish..."
npx eslint "${ts_files[@]}"
