#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DEV_VARS="$ROOT_DIR/apps/control-plane-worker/.dev.vars"
SIGNAL_FILE="$ROOT_DIR/.tunnel-url"
API_PORT="3000"
UI_PORT="5173"
TIMEOUT="${DOGFOOD_E2E_TIMEOUT:-90}"
PIDS=()

cd "$ROOT_DIR"

log() {
  printf '[dogfood:e2e] %s\n' "$*" >&2
}

read_dev_var() {
  local key="$1"
  sed -n "s|^${key}=||p" "$WORKER_DEV_VARS" 2>/dev/null | tail -n 1
}

random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -f "$SIGNAL_FILE"
}

require_command() {
  local command="$1"
  if ! command -v "$command" >/dev/null 2>&1; then
    log "error: $command is required"
    exit 1
  fi
}

require_dev_var() {
  local key="$1"
  local value
  value="$(read_dev_var "$key")"
  if [[ -z "$value" ]]; then
    log "error: $key is required in apps/control-plane-worker/.dev.vars"
    exit 1
  fi
}

require_env_or_dev_var() {
  local key="$1"
  local env_value="${!key:-}"
  local value
  value="$(read_dev_var "$key")"
  if [[ -z "$env_value" && -z "$value" ]]; then
    log "error: $key is required in the shell env or apps/control-plane-worker/.dev.vars"
    exit 1
  fi
}

require_any_dev_var() {
  local label="$1"
  shift
  local key
  for key in "$@"; do
    if [[ -n "$(read_dev_var "$key")" ]]; then
      return 0
    fi
  done
  log "error: one of [$*] is required in apps/control-plane-worker/.dev.vars for $label"
  exit 1
}

assert_port_free() {
  local port="$1"
  if ! PORT="$port" node <<'NODE'
const net = require("node:net");
const port = Number(process.env.PORT);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.once("listening", () => server.close(() => process.exit(0)));
server.listen(port, "127.0.0.1");
NODE
  then
    log "error: localhost:$port is already in use; stop the existing process before running dogfood:e2e"
    exit 1
  fi
}

curl_status() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true
}

wait_for_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local elapsed=0
  local status=""

  while [[ "$elapsed" -lt "$TIMEOUT" ]]; do
    status="$(curl_status "$url")"
    if [[ "$status" == "$expected" ]]; then
      log "$label ready ($url)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  log "error: timed out waiting for $label at $url; last HTTP status=${status:-none}, expected=$expected"
  return 1
}

wait_for_tunnel_url() {
  local elapsed=0
  while [[ ! -f "$SIGNAL_FILE" && "$elapsed" -lt "$TIMEOUT" ]]; do
    sleep 1
    elapsed=$((elapsed + 1))
    ensure_children_alive
  done

  if [[ ! -f "$SIGNAL_FILE" ]]; then
    log "error: timed out waiting for tunnel URL"
    exit 1
  fi

  cat "$SIGNAL_FILE"
}

ensure_children_alive() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      log "error: child process $pid exited; stopping dogfood:e2e"
      exit 1
    fi
  done
}

monitor_children() {
  while true; do
    sleep 1
    ensure_children_alive
  done
}

trap cleanup EXIT INT TERM

require_command node
require_command curl
require_command ngrok

node scripts/dev-env.mjs --mode "${DOGFOOD_ENV_MODE:-session}"

require_dev_var E2B_API_KEY
require_dev_var GITHUB_APP_ID
require_dev_var GITHUB_PRIVATE_KEY
if [[ "${ALLOW_EPHEMERAL_NGROK:-$(read_dev_var ALLOW_EPHEMERAL_NGROK)}" != "1" ]]; then
  require_env_or_dev_var NGROK_DOMAIN
fi
require_any_dev_var "agent model access" OPENAI_API_KEY OPENAI_API_KEY_INTERNAL_REVIEW ARCANIST_OPENAI_API_KEY

assert_port_free "$API_PORT"
assert_port_free "$UI_PORT"

rm -f "$SIGNAL_FILE"
export DOGFOOD_SESSION_TOKEN="${DOGFOOD_SESSION_TOKEN:-$(random_hex)}"

log "starting ngrok tunnel to API port $API_PORT"
DEV_PORT="$API_PORT" bash scripts/dev-tunnel.sh &
PIDS+=("$!")

TUNNEL_URL="$(wait_for_tunnel_url)"
log "tunnel ready at $TUNNEL_URL"

log "starting dogfood API"
bash scripts/dogfood-runtime.sh api &
PIDS+=("$!")

log "starting dogfood UI"
bash scripts/dogfood-runtime.sh ui &
PIDS+=("$!")

wait_for_status "local API" "http://127.0.0.1:$API_PORT/api/health" "200"
wait_for_status "public API tunnel" "$TUNNEL_URL/api/health" "200"
wait_for_status "sandbox websocket preflight" "$TUNNEL_URL/api/sessions/dogfood-local-preflight/ws?type=sandbox" "426"
wait_for_status "local UI" "http://127.0.0.1:$UI_PORT/auth/status" "200"

node scripts/dogfood-prepare.mjs
node scripts/dogfood-preflight.mjs --mode "${DOGFOOD_PREFLIGHT_MODE:-session}"

ARCANIST_BASE_URL="http://127.0.0.1:$UI_PORT" \
ARCANIST_AUTH_VALIDATE_URL="http://127.0.0.1:$UI_PORT/auth/status" \
ARCANIST_AUTH_STATE_PATH="/tmp/cycloid-auth/dogfood/storage-state.json" \
DOGFOOD_SESSION_TOKEN="$DOGFOOD_SESSION_TOKEN" \
  node scripts/cycloid-auth.mjs

cat >&2 <<EOF
[dogfood:e2e] dogfood ready
[dogfood:e2e] UI:  http://127.0.0.1:$UI_PORT
[dogfood:e2e] API: http://127.0.0.1:$API_PORT
[dogfood:e2e] CONTROL_PLANE_URL: $TUNNEL_URL
[dogfood:e2e] AUTH_STATE: /tmp/cycloid-auth/dogfood/storage-state.json
[dogfood:e2e] REPOS: $(node -e "const fs=require('fs'); const p='.tmp/dogfood-ready.json'; console.log(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')).repos.join(',') : '')")
[dogfood:e2e] E2B_TEMPLATE: $(node -e "const fs=require('fs'); const p='.tmp/dogfood-ready.json'; console.log(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')).e2bTemplate || '' : '')")
[dogfood:e2e] Keep this process running while local E2B sessions execute.
EOF

monitor_children
