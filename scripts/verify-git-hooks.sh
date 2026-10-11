#!/usr/bin/env bash
# Verify Husky shims are installed for this checkout. Git points at the
# generated .husky/_ directory, so committed .husky/pre-* files alone are not
# enough for hooks to run.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: not inside a git repository" >&2
  exit 1
}

cd "$ROOT"

HOOKS_PATH="$(git config --get core.hooksPath || true)"
if [ "$HOOKS_PATH" != ".husky/_" ]; then
  echo "error: core.hooksPath is '${HOOKS_PATH:-unset}', expected '.husky/_'" >&2
  echo "Run: npm run prepare" >&2
  exit 1
fi

missing=false
for hook in pre-commit pre-push; do
  if [ ! -x ".husky/_/$hook" ]; then
    echo "error: missing executable Husky shim .husky/_/$hook" >&2
    missing=true
  fi
  if [ ! -x ".husky/$hook" ]; then
    echo "error: missing executable hook body .husky/$hook" >&2
    missing=true
  fi
done

if [ "$missing" = true ]; then
  echo "Run: npm run prepare" >&2
  exit 1
fi

echo "Git hooks verified."
