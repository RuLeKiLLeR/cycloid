#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/apps/control-plane-worker"
DEV_VARS_FILE="${DOGFOOD_SOURCE_DEV_VARS:-$WORKER_DIR/.dev.vars}"
DOGFOOD_BUSINESS_ID="dogfood-cycloid"
DOGFOOD_GITHUB_ID="900000001"
DOGFOOD_LOGIN="cycloid-dogfood"
DOGFOOD_DEFAULT_REPO="${DOGFOOD_DEFAULT_REPO:-trycycloid/cycloid}"
DOGFOOD_SESSION_TOKEN="${DOGFOOD_SESSION_TOKEN:-}"
DOGFOOD_SESSION_TOKEN_FILE="${DOGFOOD_SESSION_TOKEN_FILE:-/tmp/cycloid-dogfood-session-token}"
export LANG=C
export LC_ALL=C
export LC_CTYPE=C
export WRANGLER_REGISTRY_PATH="${WRANGLER_REGISTRY_PATH:-$ROOT_DIR/.tmp/wrangler-registry}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-$ROOT_DIR/.tmp/wrangler-logs}"
mkdir -p "$(dirname "$WRANGLER_REGISTRY_PATH")" "$WRANGLER_LOG_PATH"

cd "$ROOT_DIR"

log() {
  printf '[dogfood-runtime] %s\n' "$*" >&2
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

dev_var_value() {
  local key="$1"
  if [[ ! -f "$DEV_VARS_FILE" ]]; then
    return 0
  fi
  sed -n "s|^${key}=||p" "$DEV_VARS_FILE" | tail -n 1
}

env_var_value() {
  local key="$1"
  printenv "$key" 2>/dev/null || true
}

dev_or_default() {
  local key="$1"
  local fallback="$2"
  local value
  value="$(env_var_value "$key")"
  if [[ -n "$value" ]]; then
    printf "%s" "$value"
    return
  fi
  value="$(dev_var_value "$key")"
  if [[ -n "$value" ]]; then
    printf "%s" "$value"
    return
  fi
  printf "%s" "$fallback"
}

default_e2b_sandbox_template() {
  local template_user="${DOGFOOD_E2B_TEMPLATE_USER:-${SUDO_USER:-${USER:-local}}}"
  if [[ -z "$template_user" || "$template_user" == "root" ]]; then
    template_user="local"
  fi
  printf "cycloid-sandbox-dev-%s" "$template_user"
}

normalize_private_key_for_dev_vars() {
  local raw="$1"
  if [[ -z "$raw" ]]; then
    return
  fi

  RAW_PRIVATE_KEY="$raw" node <<'NODE'
const raw = process.env.RAW_PRIVATE_KEY || "";
let key = raw.trim().replace(/^"|"$/g, "");
if (!key.includes("\\n")) {
  const match = key.match(/^(-----BEGIN [^-]+-----)\s+(.+?)\s+(-----END [^-]+-----)$/);
  if (match) {
    const body = match[2].replace(/\s+/g, "");
    const chunks = body.match(/.{1,64}/g) ?? [];
    key = [match[1], ...chunks, match[3]].join("\\n");
  }
}
process.stdout.write(key);
NODE
}

is_hosted_control_plane_url() {
  case "$1" in
    http://app.trycycloid.com | http://app.trycycloid.com/* | https://app.trycycloid.com | https://app.trycycloid.com/*)
      return 0
      ;;
    http://qa.app.trycycloid.com | http://qa.app.trycycloid.com/* | https://qa.app.trycycloid.com | https://qa.app.trycycloid.com/*)
      return 0
      ;;
    http://qa.trycycloid.com | http://qa.trycycloid.com/* | https://qa.trycycloid.com | https://qa.trycycloid.com/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_local_control_plane_url() {
  local value="$1"
  if is_hosted_control_plane_url "$value"; then
    log "error: local CONTROL_PLANE_URL points at hosted Cycloid ($value); run npm run dev:full so it points at your API tunnel"
    exit 1
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$file" | awk '{print $1}'
}

ensure_node_deps() {
  local expected_hash actual_hash lock_file
  mkdir -p "$ROOT_DIR/node_modules"
  expected_hash="$(sha256_file "$ROOT_DIR/package-lock.json")"
  lock_file="$ROOT_DIR/.tmp/cycloid-dogfood-install.lock"
  mkdir -p "$(dirname "$lock_file")"

  install_if_needed() {
    actual_hash="$(cat "$ROOT_DIR/node_modules/.cycloid-dogfood-package-lock-sha" 2>/dev/null || true)"
    if [[ "$actual_hash" == "$expected_hash" ]]; then
      log "node dependencies already match package-lock"
      return 0
    fi

    log "installing node dependencies"
    HUSKY=0 npm ci --include-workspace-root --prefer-offline --no-audit
    printf "%s\n" "$expected_hash" > "$ROOT_DIR/node_modules/.cycloid-dogfood-package-lock-sha"
  }

  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      install_if_needed
    ) 9>"$lock_file"
  else
    local lock_dir="${lock_file}.d"
    local waited=0
    while ! mkdir "$lock_dir" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
      if [ "$waited" -gt 300 ]; then
        log "error: timed out waiting for dependency install lock"
        exit 1
      fi
    done
    trap 'rm -rf "$lock_dir"' RETURN
    install_if_needed
    rm -rf "$lock_dir"
    trap - RETURN
  fi
}

write_dev_env_file() {
  local env_file="${DOGFOOD_ENV_FILE:-/tmp/cycloid-dogfood.env}"
  local token_encryption_key sandbox_callback_secret sandbox_runtime_cleanup_secret
  local cycloid_admin_token ci_automation_token build_callback_secret
  local eval_callback_secret github_webhook_secret
  local github_app_id github_private_key github_client_id github_client_secret
  local openai_api_key cycloid_openai_api_key e2b_api_key control_plane_url e2b_sandbox_template

  token_encryption_key="$(dev_or_default "TOKEN_ENCRYPTION_KEY" "$(random_hex)")"
  sandbox_callback_secret="$(dev_or_default "SANDBOX_CALLBACK_SECRET" "$(random_hex)")"
  sandbox_runtime_cleanup_secret="$(dev_or_default "SANDBOX_RUNTIME_CLEANUP_SECRET" "$(random_hex)")"
  cycloid_admin_token="$(dev_or_default "ARCANIST_ADMIN_TOKEN" "$(random_hex)")"
  ci_automation_token="$(dev_or_default "CI_AUTOMATION_TOKEN" "$(random_hex)")"
  build_callback_secret="$(dev_or_default "BUILD_CALLBACK_SECRET" "$(random_hex)")"
  eval_callback_secret="$(dev_or_default "EVAL_CALLBACK_SECRET" "$(random_hex)")"
  github_webhook_secret="$(dev_or_default "GITHUB_WEBHOOK_SECRET" "$(random_hex)")"
  github_app_id="$(dev_or_default "GITHUB_APP_ID" "")"
  github_private_key="$(normalize_private_key_for_dev_vars "$(dev_or_default "GITHUB_PRIVATE_KEY" "")")"
  github_client_id="$(dev_or_default "GITHUB_CLIENT_ID" "")"
  github_client_secret="$(dev_or_default "GITHUB_CLIENT_SECRET" "")"
  openai_api_key="$(dev_or_default "OPENAI_API_KEY" "")"
  if [[ -z "$openai_api_key" ]]; then
    openai_api_key="$(dev_or_default "OPENAI_API_KEY_FOR_LOCAL_DEV" "")"
  fi
  if [[ -z "$openai_api_key" ]]; then
    openai_api_key="$(dev_or_default "OPENAI_API_KEY_INTERNAL_REVIEW" "")"
  fi
  cycloid_openai_api_key="$(dev_or_default "ARCANIST_OPENAI_API_KEY" "$openai_api_key")"
  e2b_api_key="$(dev_or_default "E2B_API_KEY" "")"
  control_plane_url="$(dev_or_default "CONTROL_PLANE_URL" "")"
  assert_local_control_plane_url "$control_plane_url"
  e2b_sandbox_template="$(dev_or_default "E2B_SANDBOX_TEMPLATE" "$(default_e2b_sandbox_template)")"

  log "writing dogfood Wrangler env file"
  cat > "$env_file" <<EOF
WORKER_ENV=local
MEMORY_CONTEXT_LOCAL_DOGFOOD_ENABLED=1
FRONTEND_URL=http://127.0.0.1:5173
GITHUB_CALLBACK_URL=http://127.0.0.1:5173/auth/callback
CONTROL_PLANE_URL=$control_plane_url
TOKEN_ENCRYPTION_KEY=$token_encryption_key
SANDBOX_CALLBACK_SECRET=$sandbox_callback_secret
SANDBOX_RUNTIME_CLEANUP_SECRET=$sandbox_runtime_cleanup_secret
ARCANIST_ADMIN_TOKEN=$cycloid_admin_token
CI_AUTOMATION_TOKEN=$ci_automation_token
BUILD_CALLBACK_SECRET=$build_callback_secret
EVAL_CALLBACK_SECRET=$eval_callback_secret
E2B_SANDBOX_TEMPLATE=$e2b_sandbox_template
E2B_RUNTIME_RETENTION_HOURS=24
GITHUB_APP_ID=$github_app_id
GITHUB_PRIVATE_KEY=$github_private_key
GITHUB_WEBHOOK_SECRET=$github_webhook_secret
GITHUB_CLIENT_ID=$github_client_id
GITHUB_CLIENT_SECRET=$github_client_secret
OPENAI_API_KEY=$openai_api_key
ARCANIST_OPENAI_API_KEY=$cycloid_openai_api_key
E2B_API_KEY=$e2b_api_key
EOF
  printf "%s\n" "$env_file"
}

seed_dogfood_d1() {
  local token escaped_token escaped_default_repo tmp_sql
  token="${DOGFOOD_SESSION_TOKEN:-$(random_hex)}"
  DOGFOOD_SESSION_TOKEN="$token"
  export DOGFOOD_SESSION_TOKEN
  printf "%s" "$token" > "$DOGFOOD_SESSION_TOKEN_FILE"
  chmod 600 "$DOGFOOD_SESSION_TOKEN_FILE"
  escaped_token="$(sql_escape "$token")"
  escaped_default_repo="$(sql_escape "$DOGFOOD_DEFAULT_REPO")"
  tmp_sql="$(mktemp)"
  trap 'rm -f "$tmp_sql"' RETURN

  cat > "$tmp_sql" <<SQL
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('$DOGFOOD_BUSINESS_ID', 'Cycloid Dogfood', 0, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
VALUES (
  $DOGFOOD_GITHUB_ID,
  '$DOGFOOD_LOGIN',
  'Cycloid Dogfood',
  'dogfood@trycycloid.com',
  NULL,
  '$DOGFOOD_BUSINESS_ID',
  unixepoch() * 1000,
  unixepoch() * 1000
)
ON CONFLICT(github_id) DO UPDATE SET
  login = excluded.login,
  name = excluded.name,
  email = excluded.email,
  avatar_url = excluded.avatar_url,
  updated_at = excluded.updated_at;

INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT '$DOGFOOD_BUSINESS_ID', id, 'admin', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = $DOGFOOD_GITHUB_ID
ON CONFLICT(business_id, user_id) DO UPDATE SET
  role = excluded.role,
  updated_at = excluded.updated_at;

INSERT INTO auth_sessions (token, user_id, expires_at, created_at)
SELECT '$escaped_token', id, unixepoch() * 1000 + (30 * 24 * 60 * 60 * 1000), unixepoch() * 1000
FROM users
WHERE github_id = $DOGFOOD_GITHUB_ID
ON CONFLICT(token) DO UPDATE SET
  user_id = excluded.user_id,
  expires_at = excluded.expires_at;

INSERT INTO user_settings (
  user_id, default_pr_draft, auto_verify_enabled, use_codex_subscription,
  default_model, default_repo, created_at, updated_at
)
SELECT id, 0, 0, 0,
  NULL, '$escaped_default_repo', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = $DOGFOOD_GITHUB_ID
ON CONFLICT(user_id) DO UPDATE SET
  default_repo = excluded.default_repo,
  updated_at = excluded.updated_at;
SQL

  local openai_api_key escaped_openai_api_key
  openai_api_key="$(dev_or_default "OPENAI_API_KEY" "")"
  if [[ -z "$openai_api_key" ]]; then
    openai_api_key="$(dev_or_default "OPENAI_API_KEY_FOR_LOCAL_DEV" "")"
  fi
  if [[ -z "$openai_api_key" ]]; then
    openai_api_key="$(dev_or_default "OPENAI_API_KEY_INTERNAL_REVIEW" "")"
  fi
  if [[ -n "$openai_api_key" ]]; then
    escaped_openai_api_key="$(sql_escape "$openai_api_key")"
    cat >> "$tmp_sql" <<SQL
INSERT INTO user_integrations (
  user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
  api_key, external_user_id, service_url, encrypted,
  last_validated_at, last_validation_status, last_validation_reason_code,
  connected_at, updated_at
)
SELECT id, 'openai', NULL, NULL, NULL,
  '$escaped_openai_api_key', NULL, NULL, 0,
  unixepoch() * 1000, 'validated', NULL,
  unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = $DOGFOOD_GITHUB_ID
ON CONFLICT(user_id, integration_id) DO UPDATE SET
  api_key = excluded.api_key,
  encrypted = excluded.encrypted,
  last_validated_at = excluded.last_validated_at,
  last_validation_status = excluded.last_validation_status,
  last_validation_reason_code = excluded.last_validation_reason_code,
  updated_at = excluded.updated_at;
SQL
  fi

  (
    cd "$WORKER_DIR"
    npx --yes wrangler d1 execute DB --local --file "$tmp_sql" >/dev/null
  )
  rm -f "$tmp_sql"
  trap - RETURN
  log "seeded dogfood user and auth session"
}

assert_dogfood_repo_credentials() {
  local token_count
  token_count="$(
    cd "$WORKER_DIR"
    npx --yes wrangler d1 execute DB --local --command "
      SELECT COUNT(*) AS count
      FROM user_integrations
      WHERE integration_id = 'github'
        AND oauth_access_token IS NOT NULL
        AND oauth_access_token != ''
        AND (service_url IS NULL OR service_url != 'local-github-app-installation-token')
        AND user_id IN (SELECT id FROM users WHERE github_id = $DOGFOOD_GITHUB_ID);
    " --json | node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const count = data?.[0]?.results?.[0]?.count ?? 0;
      process.stdout.write(String(count));
    '
  )"
  if [[ "${token_count:-0}" != "0" ]]; then
    log "dogfood GitHub repo credential ready for $DOGFOOD_DEFAULT_REPO"
    return 0
  fi

  log "warning: dogfood GitHub repo credential is missing; repo browsing and new session creation may fail"
  log "fix: set DOGFOOD_GITHUB_TOKEN to the dogfood user's GitHub token when you need repo-backed dogfood sessions. GITHUB_USER_TOKEN or authenticated gh are workstation fallbacks. GitHub App secrets alone cannot list user repositories"
  return 0
}

seed_local_integrations() {
  (
    cd "$WORKER_DIR"
    bash scripts/seed-local.sh
  )
  log "seeded local integrations"
  assert_dogfood_repo_credentials
}

start_api() {
  local dogfood_env_file
  ensure_node_deps
  dogfood_env_file="$(write_dev_env_file)"
  (
    cd "$WORKER_DIR"
    log "applying local D1 migrations"
    npx --yes wrangler d1 migrations apply DB --local
  )
  seed_dogfood_d1
  seed_local_integrations
  # Drive the worker's cron triggers (review-loop sweep, warm-pool reconcile, etc.)
  # that wrangler dev registers but never fires. Detached + self-terminating so it
  # does not orphan once the exec'd wrangler process below exits.
  ( bash "$ROOT_DIR/scripts/dev-cron-ticker.sh" "http://localhost:3000" & ) >/dev/null 2>&1
  log "started local cron ticker (drives scheduled() handler)"
  cd "$WORKER_DIR"
  log "starting control-plane worker on 0.0.0.0:3000"
  exec npx --yes wrangler dev --env-file "$dogfood_env_file" --ip 0.0.0.0 --port 3000
}

start_ui() {
  ensure_node_deps
  log "starting Vite UI on 0.0.0.0:5173"
  exec npx --workspace=cycloid-ui vite --host 0.0.0.0 --port 5173
}

case "${1:-}" in
  deps)
    ensure_node_deps
    ;;
  api)
    start_api
    ;;
  ui)
    start_ui
    ;;
  *)
    echo "Usage: $0 <deps|api|ui>" >&2
    exit 2
    ;;
esac
