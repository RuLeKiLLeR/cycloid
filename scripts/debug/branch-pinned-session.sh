#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: REPO_URL=<url> SESSION_BRANCH=<branch> [AR... variables] bash scripts/debug/branch-pinned-session.sh

Creates a local verification session pinned to SESSION_BRANCH. Set ARCANIST_API_URL
when the local API is not available at the port in .worktree-ports.
USAGE
  exit 0
fi

ADMIN_TOKEN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars)"
REPO_URL="${REPO_URL:?set REPO_URL}"
SESSION_BRANCH="${SESSION_BRANCH:?set SESSION_BRANCH}"
OWNER_LOGIN="${ARCANIST_VERIFY_OWNER_LOGIN:-$(gh api user --jq .login 2>/dev/null || true)}"
OWNER_USER_ID=""
if [ -n "$OWNER_LOGIN" ]; then
  case "$OWNER_LOGIN" in
    *[!A-Za-z0-9-]*)
      echo "Invalid GitHub login for local owner lookup: $OWNER_LOGIN" >&2
      exit 1
      ;;
  esac
  OWNER_QUERY_OUTPUT="$(
    cd apps/control-plane-worker &&
      npx wrangler d1 execute DB --local \
        --command "SELECT id FROM users WHERE login = '$OWNER_LOGIN' LIMIT 1"
  )" || {
    echo "Failed to query local D1 for owner login '$OWNER_LOGIN'; fix local wrangler/D1 setup before falling back to another owner" >&2
    exit 1
  }
  OWNER_USER_ID="$(
    printf "%s" "$OWNER_QUERY_OUTPUT" |
      node -e 'const input=require("fs").readFileSync(0,"utf8"); const start=input.indexOf("["); if (start < 0) process.exit(0); const rows=JSON.parse(input.slice(start)); process.stdout.write(String(rows?.[0]?.results?.[0]?.id ?? ""));'
  )"
fi
if [ -z "$OWNER_USER_ID" ]; then
  OWNER_USER_ID="$(sed -n 's/^ARCANIST_EVAL_OWNER_USER_ID=//p' apps/control-plane-worker/.dev.vars)"
  if [ -n "$OWNER_USER_ID" ]; then
    echo "warn: using ARCANIST_EVAL_OWNER_USER_ID=$OWNER_USER_ID; session may not appear under the logged-in user's Mine tab" >&2
  fi
fi
if [ -z "$OWNER_USER_ID" ]; then
  echo "No local owner user found; sign in locally or rerun bash scripts/worktree-setup.sh to seed ARCANIST_EVAL_OWNER_USER_ID" >&2
  exit 1
fi
SESSION_PAYLOAD="$(
  OWNER_USER_ID="$OWNER_USER_ID" REPO_URL="$REPO_URL" SESSION_BRANCH="$SESSION_BRANCH" \
    node -e 'process.stdout.write(JSON.stringify({ ownerUserId: process.env.OWNER_USER_ID, context: { repoUrl: process.env.REPO_URL, baseBranch: process.env.SESSION_BRANCH } }))'
)"
SESSION_JSON="$(
  API_PORT="${API_PORT:-$(sed -n 's/^API_PORT=//p' .worktree-ports)}"
  curl -fsS \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: verify-branch-pinned-session-$(date +%s)" \
    --data "$SESSION_PAYLOAD" \
    "${ARCANIST_API_URL:-http://localhost:${API_PORT:-3000}}/api/sessions"
)"
node -e 'const x=JSON.parse(process.argv[1]); console.log(x.sessionId)' "$SESSION_JSON"
