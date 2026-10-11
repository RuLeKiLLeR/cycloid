#!/usr/bin/env bash
set -euo pipefail

# Preflight for local dev: validates the things `npm run dev:full` (just dev)
# needs but fails on silently or cryptically -- required .dev.vars, an ngrok
# domain, free API/UI ports, and (optionally) SSL certs. Prints actionable fix
# instructions and exits non-zero if any hard requirement is missing, so a
# misconfigured env is caught up front instead of as a cascading tunnel death
# or a stuck session.

DEV_VARS="apps/control-plane-worker/.dev.vars"
DEV_VARS_EXAMPLE="apps/control-plane-worker/.dev.vars.example"

# Layer-1 control-plane secrets that ship empty in .dev.vars.example and must be
# filled by hand (the rest -- SANDBOX_CALLBACK_SECRET, E2B_SANDBOX_TEMPLATE,
# GITHUB_CALLBACK_URL, FRONTEND_URL, CONTROL_PLANE_URL -- are auto-set by
# scripts/dev-full.sh / dev-tunnel.sh, so we do not require them here).
REQUIRED_VARS=(
  OPENAI_API_KEY
  GITHUB_APP_ID
  GITHUB_PRIVATE_KEY
  GITHUB_WEBHOOK_SECRET
  TOKEN_ENCRYPTION_KEY
  ARCANIST_ADMIN_TOKEN
  BUILD_CALLBACK_SECRET
  CI_AUTOMATION_TOKEN
  EVAL_CALLBACK_SECRET
  E2B_API_KEY
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
)

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=""; C_YEL=""; C_GRN=""; C_DIM=""; C_RST=""
fi

errors=0
warnings=0

ok()   { printf '  %sok%s   %s\n' "$C_GRN" "$C_RST" "$1"; }
warn() { printf '  %swarn%s %s\n' "$C_YEL" "$C_RST" "$1"; warnings=$((warnings + 1)); }
fail() { printf '  %serror%s %s\n' "$C_RED" "$C_RST" "$1"; errors=$((errors + 1)); }
fix()  { printf '       %s%s%s\n' "$C_DIM" "$1" "$C_RST"; }

read_dev_var() {
  # Strip one layer of surrounding quotes so a copy-pasted KEY="" (common for
  # GITHUB_PRIVATE_KEY pasted from JSON) reads as empty, not the literal `""`.
  sed -n "s|^${1}=||p" "$DEV_VARS" 2>/dev/null | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# True when ngrok has an auth token configured. `ngrok config check` only
# validates config syntax (it exits 0 with no token), so check the two places a
# token actually lives -- the NGROK_AUTHTOKEN env var or an `authtoken:` line in
# the config file -- without ever printing the value. Returns 0 (skip) if the
# config path can't be resolved, to avoid false-failing a working setup.
ngrok_has_authtoken() {
  [[ -n "${NGROK_AUTHTOKEN:-}" ]] && return 0
  local cfg
  cfg="$(ngrok config check 2>/dev/null | sed -n 's/.*at //p' | tail -n 1)"
  [[ -z "$cfg" || ! -f "$cfg" ]] && return 0
  # v2 keeps `authtoken:` at the top level; v3 nests it under `agent:` (indented),
  # so allow leading whitespace.
  grep -qE '^[[:space:]]*authtoken:' "$cfg"
}

echo "Cycloid dev doctor"
echo ""

# --- .dev.vars exists ---
echo ".dev.vars"
if [[ ! -f "$DEV_VARS" ]]; then
  fail "$DEV_VARS not found"
  fix "cp $DEV_VARS_EXAMPLE $DEV_VARS   # then fill in the required values"
  fix "pull values from SSM: aws ssm get-parameters-by-path --path /cycloid/ --with-decryption --query 'Parameters[*].[Name,Value]' --output text"
  # Nothing else to check without it.
  echo ""
  printf "%sdoctor: %d error(s), %d warning(s) -- fix the errors above before 'just dev'%s\n" "$C_RED" "$errors" "$warnings" "$C_RST"
  exit 1
fi
ok "$DEV_VARS present"

# --- required env vars present and non-empty ---
echo ""
echo "required env vars"
missing_vars=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "$(read_dev_var "$var")" ]]; then
    missing_vars+=("$var")
  fi
done
if ((${#missing_vars[@]} > 0)); then
  fail "missing/empty in $DEV_VARS: ${missing_vars[*]}"
  fix "fill them in $DEV_VARS (pull from SSM, see header of $DEV_VARS_EXAMPLE)"
else
  ok "all ${#REQUIRED_VARS[@]} required control-plane vars set"
fi

# --- ngrok (tunnel/webhooks) ---
echo ""
echo "tunnel (ngrok)"
ngrok_domain="${NGROK_DOMAIN:-$(read_dev_var NGROK_DOMAIN)}"
if ! command -v ngrok >/dev/null 2>&1; then
  fail "ngrok not installed (dev:full starts the tunnel first and hard-exits without it)"
  fix "brew install ngrok && ngrok config add-authtoken <token>"
elif [[ -z "$ngrok_domain" ]]; then
  fail "NGROK_DOMAIN not set (dev:full tunnel hard-exits, cascading into a stuck stack)"
  fix "claim a free static domain at https://dashboard.ngrok.com/domains"
  fix "then add NGROK_DOMAIN=<your-domain> to $DEV_VARS"
elif ! ngrok_has_authtoken; then
  fail "ngrok auth token not configured (dev:full tunnel hard-exits without it)"
  fix "ngrok config add-authtoken <token>   # get a token at https://dashboard.ngrok.com/authtokens"
else
  ok "ngrok installed, NGROK_DOMAIN=$ngrok_domain, auth token present"
fi

# --- ports ---
echo ""
echo "ports"
api_port="${API_PORT:-3000}"
ui_port="${UI_PORT:-5173}"
if [[ -f ".worktree-ports" ]]; then
  # shellcheck disable=SC1091
  source .worktree-ports
  api_port="${API_PORT:-3000}"
  ui_port="${UI_PORT:-5173}"
fi
if ! command -v lsof >/dev/null 2>&1; then
  warn "lsof not found; skipping port checks (API=$api_port UI=$ui_port)"
else
  for entry in "API:$api_port" "UI:$ui_port"; do
    label="${entry%%:*}"
    port="${entry##*:}"
    if port_in_use "$port"; then
      fail "$label port $port is already in use"
      fix "stop the process on $port, or run another worktree (worktree-setup.sh assigns offset ports)"
    else
      ok "$label port $port free"
    fi
  done
fi

# --- SSL certs (optional; Slack OAuth only) ---
echo ""
echo "SSL certs (optional, Slack OAuth)"
if [[ -f "certs/localhost.pem" && -f "certs/localhost-key.pem" ]]; then
  ok "certs present"
else
  warn "certs missing; the SSL proxy is skipped silently and Slack OAuth won't work locally"
  fix "bash scripts/setup-ssl-certs.sh   # one-time, needs mkcert"
fi

# --- summary ---
echo ""
if ((errors > 0)); then
  printf "%sdoctor: %d error(s), %d warning(s) -- fix the errors above before 'just dev'%s\n" "$C_RED" "$errors" "$warnings" "$C_RST"
  exit 1
fi
if ((warnings > 0)); then
  printf '%sdoctor: ready (%d warning(s))%s\n' "$C_YEL" "$warnings" "$C_RST"
else
  printf '%sdoctor: all checks passed%s\n' "$C_GRN" "$C_RST"
fi
