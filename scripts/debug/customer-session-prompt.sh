#!/usr/bin/env bash
# Recover the exact prompt(s) and core metadata for any Cycloid session,
# across businesses, from a session UUID, session URL, branch name, or PR URL.
#
# Why this exists: raw prompt text is NOT in D1 (only run metadata is); it lives
# in the Braintrust "cycloid" project. D1 is the multi-tenant index that maps a
# branch/PR back to a session id regardless of which business owns it, which the
# `cycloid sessions list --scope business` API cannot do (it only shows yours).
#
# Prereqs:
#   - wrangler logged in WITH the d1 scope (`npx wrangler whoami` must list `d1`;
#     re-run `npx wrangler login` if missing).
#   - BRAINTRUST_API_KEY exported (it is in the repo dev shell).
#
# Usage:
#   bash scripts/debug/customer-session-prompt.sh <session-uuid | session-url | branch | pr-url | pr#>
#   REPO=owner/name bash scripts/debug/customer-session-prompt.sh <pr-number>   # PR number needs a repo
#   TRACE=1 bash scripts/debug/customer-session-prompt.sh <arg>                 # also dump the tool-call trace
set -euo pipefail

D1_DB="${D1_DB:-cycloid-control-plane-production}"
BT_PROJECT_ID="${BT_PROJECT_ID:-8b3d7d5c-971f-4372-9bc7-d2f39b6f9f74}" # Braintrust "cycloid" project
BT_API="${BT_API:-https://api.braintrust.dev}"
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

if [[ $# -lt 1 ]]; then
  grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
  exit 1
fi
ARG="$1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Run one read-only D1 SELECT and return the JSON `results` array.
# Kept as a lone `wrangler d1 execute ... --command "SELECT ..."` so the repo's
# remote-wrangler guard (single read-only SELECT, no chaining) is satisfied.
d1() {
  # Keep wrangler stderr visible: the most common failure this runbook warns
  # about (token missing the `d1` scope -> Cloudflare error `10000`) only shows
  # up there, and swallowing it would surface as a confusing python parse error.
  npx wrangler d1 execute "$D1_DB" --remote --json --command "$1" >"$TMP/d1.json"
  python3 -c "import json,sys; print(json.dumps(json.load(open('$TMP/d1.json'))[0]['results']))"
}

# ---- 1. Resolve the input to a session UUID -------------------------------
SESSION_ID=""
if [[ "$ARG" =~ /sessions/($UUID_RE) ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
elif [[ "$ARG" =~ ^$UUID_RE$ ]]; then
  SESSION_ID="$ARG"
elif [[ "$ARG" =~ github.com/([^/]+/[^/]+)/pull/([0-9]+) ]] || [[ "$ARG" =~ ^[0-9]+$ ]]; then
  # PR reference -> resolve by exact pr_url, which session_pr_metadata records
  # as GitHub's canonical html_url (unique per session). Branch names are
  # sanitized prompt slugs and are NOT globally unique across businesses/repos,
  # and a multi-PR session's older PR can stop matching session_index's single
  # published_branch, so never resolve a PR through the branch.
  if [[ "$ARG" =~ github.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
    PR_URL="https://github.com/${BASH_REMATCH[1]}/pull/${BASH_REMATCH[2]}"
  else
    : "${REPO:?Pass a PR URL, or set REPO=owner/name for a bare PR number}"
    PR_URL="https://github.com/$REPO/pull/$ARG"
  fi
  echo "Resolving via PR: $PR_URL" >&2
  SESSION_ID="$(d1 "SELECT session_id FROM session_pr_metadata WHERE pr_url = '$PR_URL' ORDER BY updated_at DESC LIMIT 1" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['session_id'] if r else '')")"
  [[ -n "$SESSION_ID" ]] || echo "No session_pr_metadata row for $PR_URL (may predate PR tracking); retry with the branch name." >&2
else
  # Branch name. Escape single quotes before interpolating into the SQL literal
  # (branch names originate from user/customer input).
  BRANCH="$ARG"
  SAFE_BRANCH="${BRANCH//\'/\'\'}"
  echo "Resolving via branch: $BRANCH" >&2
  # Legacy suffixed branches end in the 12-char session-UUID tail; clean
  # (post-#7194) branches do not, so fall back to a published_branch match.
  if [[ "$BRANCH" =~ -([0-9a-f]{12})$ ]]; then
    SUFFIX="${BASH_REMATCH[1]}" # hex-only capture, safe to interpolate
    SESSION_ID="$(d1 "SELECT session_id FROM session_index WHERE session_id LIKE '%$SUFFIX'" \
      | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['session_id'] if r else '')")"
  fi
  if [[ -z "$SESSION_ID" ]]; then
    SESSION_ID="$(d1 "SELECT session_id FROM session_index WHERE published_branch = '$SAFE_BRANCH'" \
      | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['session_id'] if r else '')")"
  fi
fi
[[ -n "$SESSION_ID" ]] || { echo "Could not resolve a session id from: $ARG" >&2; exit 1; }

# ---- 2. Session metadata from D1 ------------------------------------------
echo "=== session $SESSION_ID ===" >&2
d1 "SELECT business_id, owner_user_id, repo_owner, repo_name, title, published_branch, created_at FROM session_index WHERE session_id = '$SESSION_ID'" \
  | python3 -c "
import json,sys
r=json.load(sys.stdin)
if not r: print('  (no session_index row)'); sys.exit()
s=r[0]
for k in ['business_id','owner_user_id','repo_owner','repo_name','title','published_branch','created_at']:
    print(f'  {k}: {s.get(k)}')
"

# ---- 3. Exact prompt(s) from Braintrust -----------------------------------
# Prompt text is only here. Filter by metadata.sessionId (camelCase); the
# per-prompt root span is named `prompt:p-N` and carries the user text in
# input.user (input.system is the harness preamble).
cat >"$TMP/btql.json" <<JSON
{"query":"select: input, metadata, created from: project_logs('$BT_PROJECT_ID') filter: metadata.sessionId = '$SESSION_ID' AND span_attributes.name LIKE 'prompt:%' sort: created asc limit: 50","fmt":"json"}
JSON
# --fail-with-body: curl exits non-zero on HTTP 4xx/5xx (a plain `-s` exits 0 and
# hides auth failures) while still writing the error body for the handler below.
curl -s --fail-with-body "$BT_API/btql" -H "Authorization: Bearer $BRAINTRUST_API_KEY" \
  -H "Content-Type: application/json" --data @"$TMP/btql.json" >"$TMP/bt.json" || true
echo "=== prompts ===" >&2
python3 -c "
import json,sys
try:
    d=json.load(open('$TMP/bt.json'))
except Exception as e:
    print('  Braintrust request failed (no/invalid JSON response):', e); sys.exit(1)
if isinstance(d,dict) and d.get('Code'):
    print('  Braintrust error:', d.get('Message')); sys.exit(1)
rows=d.get('data',d) if isinstance(d,dict) else d
if not rows:
    print('  (no prompt spans; session may predate Braintrust logging or tracing was disabled)'); sys.exit()
for r in rows:
    md=r.get('metadata') or {}
    inp=r.get('input') or {}
    user=inp.get('user') if isinstance(inp,dict) else inp
    print(f\"  [{md.get('promptId')}] {r.get('created')}\")
    print(f'    {json.dumps(user)}')
"

# ---- 4. Optional: full tool-call trace ------------------------------------
if [[ "${TRACE:-}" == "1" ]]; then
  cat >"$TMP/btql_trace.json" <<JSON
{"query":"select: input, metadata, span_attributes, created from: project_logs('$BT_PROJECT_ID') filter: metadata.sessionId = '$SESSION_ID' sort: created asc limit: 500","fmt":"json"}
JSON
  curl -s --fail-with-body "$BT_API/btql" -H "Authorization: Bearer $BRAINTRUST_API_KEY" \
    -H "Content-Type: application/json" --data @"$TMP/btql_trace.json" >"$TMP/bt_trace.json" || true
  echo "=== trace (tool calls) ===" >&2
  python3 -c "
import json,sys
d=json.load(open('$TMP/bt_trace.json'))
rows=d.get('data',d) if isinstance(d,dict) else d
for r in rows:
    sa=r.get('span_attributes') or {}; md=r.get('metadata') or {}
    print(f\"  {r.get('created')} [{md.get('promptId')}] {sa.get('name')}: {json.dumps(r.get('input'))[:200]}\")
"
fi
