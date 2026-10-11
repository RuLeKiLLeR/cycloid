#!/usr/bin/env bash
set -euo pipefail

# Starts the full local dev stack: tunnel -> api + ui.
# The tunnel must start first so CONTROL_PLANE_URL is written to .dev.vars
# before wrangler reads it.

# Source worktree port assignments if available
USING_WORKTREE_PORTS=false
if [[ -f ".worktree-ports" ]]; then
  source .worktree-ports
  export API_PORT UI_PORT
  USING_WORKTREE_PORTS=true
fi

set_dev_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.bak"
    return
  fi

  printf '\n%s=%s\n' "$key" "$value" >> "$file"
}

get_dev_var() {
  local file="$1"
  local key="$2"
  if [[ ! -f "$file" ]]; then
    return
  fi
  sed -n "s|^${key}=||p" "$file" | tail -n 1
}

ensure_local_e2b_template() {
  local file="$1"
  local template="cycloid-sandbox-dev-${USER:-local}"
  local existing
  existing="$(get_dev_var "$file" "E2B_SANDBOX_TEMPLATE")"

  case "$existing" in
    ""|"cycloid-sandbox-dev-your-login"|"cycloid-sandbox-dev-<you>"|"cycloid-sandbox-dev-<your-login>")
      set_dev_var "$file" "E2B_SANDBOX_TEMPLATE" "$template"
      echo "E2B_SANDBOX_TEMPLATE=$template"
      ;;
  esac
}

ensure_local_sandbox_callback_secret() {
  local file="$1"
  local existing
  existing="$(get_dev_var "$file" "SANDBOX_CALLBACK_SECRET")"
  if [[ -z "$existing" ]]; then
    set_dev_var "$file" "SANDBOX_CALLBACK_SECRET" "local-dev-sandbox-callback-secret"
    echo "SANDBOX_CALLBACK_SECRET=<local-dev>"
  fi
}

if [[ -f "apps/control-plane-worker/.dev.vars" ]]; then
  if [[ "$USING_WORKTREE_PORTS" == "true" ]]; then
    set_dev_var "apps/control-plane-worker/.dev.vars" "GITHUB_CALLBACK_URL" "http://localhost:${UI_PORT}/auth/callback"
    set_dev_var "apps/control-plane-worker/.dev.vars" "FRONTEND_URL" "http://localhost:${UI_PORT}"
  fi
  ensure_local_e2b_template "apps/control-plane-worker/.dev.vars"
  ensure_local_sandbox_callback_secret "apps/control-plane-worker/.dev.vars"
fi

bash scripts/ensure-gh-auth.sh

# Apply any pending D1 migrations and seed local dev data
echo "Applying D1 migrations..."
(cd apps/control-plane-worker && npx wrangler d1 migrations apply DB --local)
echo "Seeding local dev data..."
(cd apps/control-plane-worker && bash scripts/seed-local.sh)

SIGNAL_FILE=".tunnel-url"
TIMEOUT="${TUNNEL_TIMEOUT:-30}"

# Clean up stale signal file
rm -f "$SIGNAL_FILE"

# Start the tunnel in the background
DEV_PORT="${API_PORT:-3000}" bash scripts/dev-tunnel.sh &
TUNNEL_SCRIPT_PID=$!
trap 'kill $TUNNEL_SCRIPT_PID 2>/dev/null || true; rm -f "$SIGNAL_FILE"' EXIT

# Wait for the signal file (written by dev-tunnel.sh)
echo "Waiting for tunnel URL..."
ELAPSED=0
while [[ ! -f "$SIGNAL_FILE" && $ELAPSED -lt $TIMEOUT ]]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  # Check if tunnel script died
  if ! kill -0 $TUNNEL_SCRIPT_PID 2>/dev/null; then
    echo "Error: tunnel script exited unexpectedly"
    exit 1
  fi
done

if [[ ! -f "$SIGNAL_FILE" ]]; then
  echo "Error: timed out waiting for tunnel URL after ${TIMEOUT}s"
  exit 1
fi

TUNNEL_URL=$(cat "$SIGNAL_FILE")
echo ""
echo "Tunnel ready at $TUNNEL_URL"
echo "Starting API + UI..."
echo ""

# Start api, ui, and SSL proxy concurrently. The tunnel monitor exits non-zero
# if ngrok dies so the rest of the stack cannot keep serving a stale callback URL.
# Forward API_PORT to the SSL proxy so it follows worktree port offsets.
TUNNEL_MONITOR_CMD="while kill -0 ${TUNNEL_SCRIPT_PID} 2>/dev/null; do sleep 1; done; echo 'Error: tunnel process exited; stopping dev stack' >&2; exit 1"

# Local cron driver (scripts/dev-cron-ticker.sh). `wrangler dev` registers the
# worker's cron triggers but never fires them, so the scheduled() handler
# (review-loop sweep, warm-pool reconcile, etc.) only runs in prod/QA. Without it,
# organic RLA/verification never advances locally — a published PR enters
# review_listening and then sits forever because nothing drives the 5-minute sweep.
npx concurrently --kill-others-on-fail -n tunnel,api,ui,ssl,cron -c magenta,blue,green,yellow,cyan \
  "bash -c \"$TUNNEL_MONITOR_CMD\"" \
  "bash scripts/dev-api.sh" \
  "bash scripts/dev-ui.sh" \
  "bash scripts/dev-ssl-proxy.sh" \
  "bash scripts/dev-cron-ticker.sh http://localhost:${API_PORT:-3000}"
