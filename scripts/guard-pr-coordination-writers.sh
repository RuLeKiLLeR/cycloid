#!/usr/bin/env bash
set -euo pipefail

# Guards literal write SQL against pr_coordination/pr_coordination_events.
# The business offboarding purge builds table names from offboarding-tables.ts;
# this literal scan intentionally leaves that templated path out of scope.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN='\b(INSERT(\s+OR\s+(ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?\s+INTO|UPDATE|DELETE\s+FROM)\s+pr_coordination'
ALLOWLIST='apps/control-plane-worker/src/session/pr-coordination-db.ts|apps/control-plane-worker/src/session/pr-coordination-events-db.ts'

matches=$(rg -n -i -U "$PATTERN" apps/control-plane-worker/src --glob '*.ts' || true)
violations=$(printf '%s\n' "$matches" | grep -Ev "^(${ALLOWLIST}):" || true)

if [ -n "$violations" ]; then
  echo "pr_coordination write SQL must stay in the FSM DAO owners:" >&2
  echo "$violations" >&2
  exit 1
fi
