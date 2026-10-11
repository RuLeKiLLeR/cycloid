#!/usr/bin/env bash
set -euo pipefail

# Tunnel for local dev (ngrok).
# Starts a tunnel to localhost:3000, captures the generated URL,
# and writes it as CONTROL_PLANE_URL into .dev.vars so wrangler picks it up.
#
# Cloudflare quick tunnels don't reliably proxy WebSocket from remote clients
# (cross-POP routing issue), so we use ngrok instead.

DEV_VARS="apps/control-plane-worker/.dev.vars"
PORT="${DEV_PORT:-3000}"
TIMEOUT="${TUNNEL_TIMEOUT:-30}"

read_dev_var() {
  local key="$1"
  sed -n "s|^${key}=||p" "$DEV_VARS" 2>/dev/null | tail -n 1
}

if ! command -v ngrok &>/dev/null; then
  echo "Error: ngrok not found. Install with: brew install ngrok"
  echo "Then authenticate: ngrok config add-authtoken <token>"
  exit 1
fi

if [[ ! -f "$DEV_VARS" ]]; then
  echo "Error: $DEV_VARS not found. Run: cp apps/control-plane-worker/.dev.vars.example $DEV_VARS"
  exit 1
fi

# Free ngrok accounts require a claimed static domain. Claim one at
# https://dashboard.ngrok.com/domains, then set NGROK_DOMAIN in your shell or
# in apps/control-plane-worker/.dev.vars.
NGROK_DOMAIN="${NGROK_DOMAIN:-$(read_dev_var NGROK_DOMAIN)}"
ALLOW_EPHEMERAL_NGROK="${ALLOW_EPHEMERAL_NGROK:-$(read_dev_var ALLOW_EPHEMERAL_NGROK)}"

if [[ -z "$NGROK_DOMAIN" && "$ALLOW_EPHEMERAL_NGROK" != "1" ]]; then
  echo "Error: NGROK_DOMAIN is not set."
  echo "Claim a free static domain at https://dashboard.ngrok.com/domains"
  echo "Then add NGROK_DOMAIN=<your-domain> to $DEV_VARS or export it before running."
  echo "For a disposable local test only, set ALLOW_EPHEMERAL_NGROK=1."
  exit 1
fi

if [[ "${ALLOW_UI_TUNNEL:-}" != "1" && "$PORT" =~ ^517[0-9]$ ]]; then
  echo "Error: dev tunnel must target the API port, got $PORT, which looks like a Vite UI port."
  echo "Use DEV_PORT=\${API_PORT:-3000}; UI-port tunnels fail sandbox callbacks and Vite host checks."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Persist the ngrok log (gitignored) so agent-session drops are inspectable
# after the fact; truncate per run so stale reconnects never mislead. The log
# intentionally survives the EXIT trap for post-mortem debugging.
TUNNEL_LOG=".ngrok.log"
: > "$TUNNEL_LOG"

# Kill any stale ngrok processes to avoid ERR_NGROK_334
pkill -f 'ngrok http' 2>/dev/null || true
sleep 1

NGROK_PID=""
WATCH_PID=""
trap 'rm -f .tunnel-url; kill ${WATCH_PID:-} 2>/dev/null || true; kill ${NGROK_PID:-} 2>/dev/null || true' EXIT

if [[ "$ALLOW_EPHEMERAL_NGROK" == "1" ]]; then
  echo "Starting ephemeral ngrok tunnel on port $PORT..."
  ngrok http "$PORT" --log=stdout --log-format=logfmt > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_URL_PATTERN='https://[a-zA-Z0-9.-]+ngrok-free.app'
else
  echo "Starting ngrok tunnel on port $PORT (domain: $NGROK_DOMAIN)..."
  ngrok http "$PORT" --domain="$NGROK_DOMAIN" --log=stdout --log-format=logfmt > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_URL_PATTERN="https://$NGROK_DOMAIN"
fi
NGROK_PID=$!

# Surface ngrok agent-session drops (e.g. macOS Wi-Fi scans) in the console;
# see docs/debugging.md "Local sessions disconnect".
bash "$SCRIPT_DIR/dev-tunnel-log-watch.sh" "$TUNNEL_LOG" &
WATCH_PID=$!

# Wait for ngrok to expose the public URL
TUNNEL_URL=""
ELAPSED=0
while [[ -z "$TUNNEL_URL" && $ELAPSED -lt $TIMEOUT ]]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [[ "$ALLOW_EPHEMERAL_NGROK" != "1" ]]; then
    # Try the ngrok API on both default and fallback ports. Ephemeral runs parse
    # only this process log because another local ngrok API may already exist.
    for api_port in 4040 4041 4042; do
      TUNNEL_URL=$(curl -s "http://localhost:$api_port/api/tunnels" 2>/dev/null \
        | grep -oE "$TUNNEL_URL_PATTERN" | head -1 || true)
      [[ -n "$TUNNEL_URL" ]] && break
    done
  fi
  # Fallback: parse from log output
  if [[ -z "$TUNNEL_URL" ]]; then
    TUNNEL_URL=$(grep -oE "$TUNNEL_URL_PATTERN" "$TUNNEL_LOG" | head -1 || true)
  fi
  # If ngrok failed fast, bail early
  if ! kill -0 $NGROK_PID 2>/dev/null; then
    echo "Error: ngrok exited unexpectedly:"
    cat "$TUNNEL_LOG"
    exit 1
  fi
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Error: Timed out waiting for ngrok URL after ${TIMEOUT}s"
  cat "$TUNNEL_LOG"
  exit 1
fi

echo ""
echo "Tunnel URL: $TUNNEL_URL"
echo ""

# Write/update CONTROL_PLANE_URL in .dev.vars. Use `sed -i.bak` (and remove the
# backup) so the substitution works on both BSD sed (macOS) and GNU sed (Linux).
if grep -q '^CONTROL_PLANE_URL=' "$DEV_VARS" 2>/dev/null; then
  sed -i.bak "s|^CONTROL_PLANE_URL=.*|CONTROL_PLANE_URL=$TUNNEL_URL|" "$DEV_VARS"
  rm -f "${DEV_VARS}.bak"
elif grep -q '^# CONTROL_PLANE_URL=' "$DEV_VARS" 2>/dev/null; then
  sed -i.bak "s|^# CONTROL_PLANE_URL=.*|CONTROL_PLANE_URL=$TUNNEL_URL|" "$DEV_VARS"
  rm -f "${DEV_VARS}.bak"
else
  echo "CONTROL_PLANE_URL=$TUNNEL_URL" >> "$DEV_VARS"
fi

echo "Updated $DEV_VARS with CONTROL_PLANE_URL=$TUNNEL_URL"

# Write signal file so dev:full knows the URL is ready
echo "$TUNNEL_URL" > .tunnel-url

echo "Tunnel ready. Keep this running."
echo ""

# Keep ngrok in foreground
wait $NGROK_PID
