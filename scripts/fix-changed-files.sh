#!/usr/bin/env bash
# Auto-fix formatter/lint issues for files changed from origin/main through the current working tree.

set -euo pipefail

BASE="$(git merge-base origin/main HEAD 2>/dev/null || true)"
if [ -z "$BASE" ]; then
  echo "error: could not find merge-base with origin/main" >&2
  echo "Run: git fetch origin main" >&2
  exit 1
fi

collect_changed_files() {
  local -a patterns=("$@")
  {
    git diff --name-only "$BASE" -- "${patterns[@]}"
    git diff --cached --name-only "$BASE" -- "${patterns[@]}"
    git ls-files --others --exclude-standard -- "${patterns[@]}"
  } | awk 'NF && !seen[$0]++'
}

prettier_files=()
while IFS= read -r file; do
  [ -f "$file" ] && prettier_files+=("$file")
done < <(collect_changed_files '*.ts' '*.tsx' '*.js' '*.jsx' '*.cjs' '*.mjs' '*.json' '*.md' '*.yml' '*.yaml' '*.css' '*.html')

ts_files=()
while IFS= read -r file; do
  [ -f "$file" ] && ts_files+=("$file")
done < <(collect_changed_files '*.ts' '*.tsx')

if [ "${#prettier_files[@]}" -gt 0 ]; then
  echo "Formatting changed files before publish..."
  npx prettier --write --ignore-unknown "${prettier_files[@]}"
else
  echo "No changed formatter-supported files to format."
fi

if [ "${#ts_files[@]}" -gt 0 ]; then
  echo "Fixing changed TypeScript files before publish..."
  npx eslint --fix "${ts_files[@]}" || true
else
  echo "No changed TypeScript files to lint-fix."
fi
