#!/usr/bin/env bash
# Seeds local D1 with dev data required to run the app locally.
# Reads GitHub App credentials from .dev.vars to look up the real installation ID.
# Safe to run multiple times (uses INSERT OR IGNORE).
#
# Usage: bash scripts/seed-local.sh
#   Run from apps/control-plane-worker/

set -euo pipefail

DEV_VARS=".dev.vars"
ARCANIST_BUSINESS_ID="295d2abc-d10b-4662-b84d-7bfa66242882"

if [ ! -f "$DEV_VARS" ]; then
  echo "  note: $DEV_VARS not found; GitHub App fallback seeding will be skipped"
fi

exec_sql() {
  npx wrangler d1 execute DB --local --command "$1" > /dev/null
}

exec_sql_file() {
  npx wrangler d1 execute DB --local --file "$1" > /dev/null
}

upsert_dev_var() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$DEV_VARS" > "$tmp"
  mv "$tmp" "$DEV_VARS"
}

read_dev_var() {
  local key="$1"
  grep -E "^${key}=" "$DEV_VARS" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

read_first_dev_var() {
  local key
  local value
  for key in "$@"; do
    value="$(read_dev_var "$key")"
    if [ -n "$value" ]; then
      printf "%s" "$value"
      return 0
    fi
  done
}

read_first_env_or_dev_var() {
  local key
  local value
  for key in "$@"; do
    value="${!key:-}"
    if [ -n "$value" ]; then
      printf "%s" "$value"
      return 0
    fi
    value="$(read_dev_var "$key")"
    if [ -n "$value" ]; then
      printf "%s" "$value"
      return 0
    fi
  done
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

read_gh_user_field() {
  local github_user_json="$1"
  local field="$2"

  GITHUB_USER_JSON="$github_user_json" GITHUB_USER_FIELD="$field" node -e '
    const user = JSON.parse(process.env.GITHUB_USER_JSON || "{}");
    const field = process.env.GITHUB_USER_FIELD;
    const value = user?.[field];
    if (value == null) process.exit(0);
    process.stdout.write(String(value));
  ' 2>/dev/null || true
}

seed_github_token_for_user() {
  local user_id="$1"
  local label="$2"
  local attach_external_user_id="${3:-1}"

  if ! command -v gh >/dev/null 2>&1; then
    echo "    Skipped GitHub token seed for $label: gh CLI not found"
    return 0
  fi

  local github_token
  github_token="$(gh auth token 2>/dev/null || true)"
  if [ -z "$github_token" ]; then
    echo "    Skipped GitHub token seed for $label: gh CLI is not authenticated"
    return 0
  fi

  local github_user_json
  github_user_json="$(gh api user 2>/dev/null || true)"

  local tmp_sql
  tmp_sql="$(mktemp)"
  trap 'rm -f "$tmp_sql"' RETURN
  LOCAL_TARGET_USER_ID="$user_id" \
    LOCAL_ATTACH_EXTERNAL_USER_ID="$attach_external_user_id" \
    LOCAL_GITHUB_TOKEN="$github_token" \
    LOCAL_GITHUB_USER_JSON="$github_user_json" \
    node <<'NODE' > "$tmp_sql"
const token = process.env.LOCAL_GITHUB_TOKEN || "";
const userId = Number(process.env.LOCAL_TARGET_USER_ID);
const attachExternalUserId = process.env.LOCAL_ATTACH_EXTERNAL_USER_ID !== "0";
let externalUserId = null;
if (attachExternalUserId) {
  try {
    const user = JSON.parse(process.env.LOCAL_GITHUB_USER_JSON || "{}");
    if (Number.isFinite(Number(user.id))) externalUserId = String(user.id);
  } catch {
    externalUserId = null;
  }
}

const q = (value) => (value == null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);
const externalUserIdUpdate = attachExternalUserId
  ? "COALESCE(excluded.external_user_id, user_integrations.external_user_id)"
  : "NULL";

process.stdout.write(
  `INSERT INTO user_integrations (
     user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
     api_key, external_user_id, service_url, encrypted,
     last_validated_at, last_validation_status, last_validation_reason_code,
     connected_at, updated_at
   ) VALUES (
     ${userId}, 'github', ${q(token)}, NULL, NULL,
     NULL, ${q(externalUserId)}, NULL, 0,
     unixepoch() * 1000, 'validated', NULL,
     unixepoch() * 1000, unixepoch() * 1000
   )
   ON CONFLICT(user_id, integration_id) DO UPDATE SET
     oauth_access_token = excluded.oauth_access_token,
     oauth_expires_at = excluded.oauth_expires_at,
     external_user_id = ${externalUserIdUpdate},
     service_url = excluded.service_url,
     encrypted = 0,
     last_validated_at = excluded.last_validated_at,
     last_validation_status = excluded.last_validation_status,
     last_validation_reason_code = excluded.last_validation_reason_code,
     updated_at = excluded.updated_at;\n`,
);
NODE

  if exec_sql_file "$tmp_sql"; then
    rm -f "$tmp_sql"
    trap - RETURN
    echo "    Seeded GitHub OAuth token for $label from gh auth"
  else
    rm -f "$tmp_sql"
    trap - RETURN
    echo "    warning: failed to seed GitHub token for $label"
  fi
}

seed_github_token_for_all_users() {
  local github_token="$1"
  local label="$2"
  local tmp_sql
  tmp_sql="$(mktemp)"
  trap 'rm -f "$tmp_sql"' RETURN
  LOCAL_GITHUB_TOKEN="$github_token" node <<'NODE' > "$tmp_sql"
const token = process.env.LOCAL_GITHUB_TOKEN || "";
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

process.stdout.write(
  `INSERT INTO user_integrations (
     user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
     api_key, external_user_id, service_url, encrypted,
     last_validated_at, last_validation_status, last_validation_reason_code,
     connected_at, updated_at
   )
   SELECT id, 'github', ${q(token)}, NULL, NULL,
     NULL, NULL, NULL, 0,
     unixepoch() * 1000, 'validated', NULL,
     unixepoch() * 1000, unixepoch() * 1000
   FROM users
   WHERE id IS NOT NULL
   ON CONFLICT(user_id, integration_id) DO UPDATE SET
     oauth_access_token = excluded.oauth_access_token,
     oauth_expires_at = excluded.oauth_expires_at,
     service_url = excluded.service_url,
     encrypted = 0,
     last_validated_at = excluded.last_validated_at,
     last_validation_status = excluded.last_validation_status,
     last_validation_reason_code = excluded.last_validation_reason_code,
     updated_at = excluded.updated_at;\n`,
);
NODE

  if exec_sql_file "$tmp_sql"; then
    rm -f "$tmp_sql"
    trap - RETURN
    echo "  Seeded GitHub OAuth token for local users from $label"
  else
    rm -f "$tmp_sql"
    trap - RETURN
    echo "  warning: failed to seed GitHub token for local users"
  fi
}

seed_github_token_for_all_users_from_env() {
  local github_token
  github_token="$(read_first_env_or_dev_var "DOGFOOD_GITHUB_TOKEN" "GITHUB_USER_TOKEN")"
  if [ -z "$github_token" ]; then
    echo "  Skipping GitHub token seed for local users: DOGFOOD_GITHUB_TOKEN/GITHUB_USER_TOKEN not set"
    return 0
  fi

  seed_github_token_for_all_users "$github_token" "runtime env"
}

seed_github_token_for_all_users_from_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "  Skipping GitHub token seed for local users: gh CLI not found"
    return 0
  fi

  local github_token
  github_token="$(gh auth token 2>/dev/null || true)"
  if [ -z "$github_token" ]; then
    echo "  Skipping GitHub token seed for local users: gh CLI is not authenticated"
    return 0
  fi

  seed_github_token_for_all_users "$github_token" "gh auth"
}

seed_github_installation_token_for_all_users() {
  local owner tmp_sql
  if [ ! -f "$DEV_VARS" ]; then
    echo "    Skipped GitHub installation token fallback: $DEV_VARS not found"
    return 0
  fi

  owner="$(read_first_dev_var "DOGFOOD_GITHUB_OWNER" "GITHUB_INSTALLATION_OWNER" "GITHUB_HEALTH_REPO_OWNER")"
  if [ -z "$owner" ]; then
    owner="trycycloid"
  fi

  tmp_sql="$(mktemp)"
  if ! LOCAL_DEV_VARS="$DEV_VARS" LOCAL_GITHUB_INSTALLATION_OWNER="$owner" node <<'NODE' > "$tmp_sql"
const fs = require("fs");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");

function parseDevVars(path) {
  const vars = {};
  const text = fs.readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function normalizePrivateKey(raw) {
  let key = String(raw || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\n/g, "\n");
  if (!key.includes("\n")) {
    const match = key.match(/^(-----BEGIN [^-]+-----)\s+(.+?)\s+(-----END [^-]+-----)$/);
    if (match) {
      const body = match[2].replace(/\s+/g, "");
      const chunks = body.match(/.{1,64}/g) ?? [];
      key = [match[1], ...chunks, match[3]].join("\n");
    }
  }
  return key;
}

function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const fallbackServiceUrl = "local-github-app-installation-token";
  const vars = parseDevVars(process.env.LOCAL_DEV_VARS);
  const appId = vars.GITHUB_APP_ID?.trim();
  const privateKey = normalizePrivateKey(vars.GITHUB_PRIVATE_KEY);
  if (!appId || !privateKey) return;

  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  const installations = (await octokit.apps.listInstallations()).data;
  if (installations.length === 0) return;

  const owner = String(process.env.LOCAL_GITHUB_INSTALLATION_OWNER || "").trim().toLowerCase();
  const selected =
    installations.find((installation) => installation.account?.login?.toLowerCase() === owner) ?? installations[0];
  const auth = createAppAuth({ appId, privateKey });
  const installationAuth = await auth({ type: "installation", installationId: selected.id });
  if (!("token" in installationAuth) || !installationAuth.token) return;

  const token = q(installationAuth.token);
  const expiresAtMs = Date.parse(installationAuth.expiresAt);
  const expiresAt = Number.isFinite(expiresAtMs) ? String(expiresAtMs) : "NULL";
  process.stdout.write(
    `UPDATE user_integrations
     SET oauth_access_token = ${token},
       oauth_expires_at = ${expiresAt},
       encrypted = 0,
       last_validated_at = unixepoch() * 1000,
       last_validation_status = 'validated',
       last_validation_reason_code = NULL,
       updated_at = unixepoch() * 1000
     WHERE integration_id = 'github' AND service_url = ${q(fallbackServiceUrl)};

     INSERT OR IGNORE INTO user_integrations (
       user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
       api_key, external_user_id, service_url, encrypted,
       last_validated_at, last_validation_status, last_validation_reason_code,
       connected_at, updated_at
     )
     SELECT id, 'github', ${token}, NULL, ${expiresAt},
       NULL, NULL, ${q(fallbackServiceUrl)}, 0,
       unixepoch() * 1000, 'validated', NULL,
       unixepoch() * 1000, unixepoch() * 1000
     FROM users
     WHERE id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_integrations existing
         WHERE existing.user_id = users.id AND existing.integration_id = 'github'
       );\n`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
  then
    rm -f "$tmp_sql"
    echo "    warning: failed to mint local GitHub installation token fallback"
    return 0
  fi

  if [ ! -s "$tmp_sql" ]; then
    rm -f "$tmp_sql"
    echo "    Skipped GitHub installation token fallback: missing GitHub App credentials or installations"
    return 0
  fi

  if exec_sql_file "$tmp_sql"; then
    rm -f "$tmp_sql"
    echo "    Seeded/refreshed GitHub installation token fallback for local users without gh auth"
  else
    rm -f "$tmp_sql"
    echo "    warning: failed to seed GitHub installation token fallback"
  fi
}

seed_local_provider_key_for_all_users() {
  local provider="$1"
  local api_key="$2"

  if [ -z "$api_key" ]; then
    return 0
  fi

  local escaped_api_key
  escaped_api_key="$(sql_escape "$api_key")"
  exec_sql "INSERT INTO user_integrations (user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at, api_key, external_user_id, service_url, encrypted, last_validated_at, last_validation_status, last_validation_reason_code, connected_at, updated_at) SELECT id, '$provider', NULL, NULL, NULL, '$escaped_api_key', NULL, NULL, 0, unixepoch() * 1000, 'validated', NULL, unixepoch() * 1000, unixepoch() * 1000 FROM users WHERE id IS NOT NULL ON CONFLICT(user_id, integration_id) DO UPDATE SET api_key = excluded.api_key, encrypted = excluded.encrypted, last_validated_at = excluded.last_validated_at, last_validation_status = excluded.last_validation_status, last_validation_reason_code = excluded.last_validation_reason_code, updated_at = excluded.updated_at;"
  echo "    Seeded ${provider} API key for local users from $DEV_VARS"
}

seed_current_gh_user() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "  Skipping current GitHub user seed: gh CLI not found"
    return 0
  fi

  local github_user_json
  github_user_json="$(gh api user 2>/dev/null || true)"
  if [ -z "$github_user_json" ]; then
    echo "  Skipping current GitHub user seed: gh CLI is not authenticated"
    return 0
  fi

  local github_id login name email avatar_url
  github_id="$(read_gh_user_field "$github_user_json" "id")"
  login="$(read_gh_user_field "$github_user_json" "login")"
  name="$(read_gh_user_field "$github_user_json" "name")"
  email="$(read_gh_user_field "$github_user_json" "email")"
  avatar_url="$(read_gh_user_field "$github_user_json" "avatar_url")"
  if [ -z "$github_id" ] || [ -z "$login" ]; then
    echo "  Skipping current GitHub user seed: could not parse gh api user output"
    return 0
  fi

  local existing_business_id
  existing_business_id="$(npx wrangler d1 execute DB --local --command "SELECT business_id FROM users WHERE github_id = $github_id LIMIT 1;" --json | node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const businessId = data?.[0]?.results?.[0]?.business_id;
    if (businessId == null) process.exit(0);
    process.stdout.write(String(businessId));
  ' 2>/dev/null || true)"
  if [ -n "$existing_business_id" ] && [ "$existing_business_id" != "$ARCANIST_BUSINESS_ID" ]; then
    echo "  Failed to seed current GitHub user: github_id=$github_id already belongs to business $existing_business_id; cannot reassign to $ARCANIST_BUSINESS_ID because users.business_id is immutable"
    return 1
  fi

  local escaped_login escaped_name escaped_email escaped_avatar_url
  escaped_login="$(sql_escape "$login")"
  escaped_name="$(sql_escape "$name")"
  escaped_email="$(sql_escape "$email")"
  escaped_avatar_url="$(sql_escape "$avatar_url")"
  local name_sql email_sql avatar_url_sql
  if [ -n "$name" ]; then
    name_sql="'$escaped_name'"
  else
    name_sql="NULL"
  fi
  if [ -n "$email" ]; then
    email_sql="'$escaped_email'"
  else
    email_sql="NULL"
  fi
  if [ -n "$avatar_url" ]; then
    avatar_url_sql="'$escaped_avatar_url'"
  else
    avatar_url_sql="NULL"
  fi

  echo "  Seeding current GitHub user into Cycloid business..."
  exec_sql "INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES ('$ARCANIST_BUSINESS_ID', 'Cycloid', 0, unixepoch() * 1000, unixepoch() * 1000);"
  exec_sql "INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at) VALUES ($github_id, '$escaped_login', $name_sql, $email_sql, $avatar_url_sql, '$ARCANIST_BUSINESS_ID', unixepoch() * 1000, unixepoch() * 1000) ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name, email = excluded.email, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at;"
  exec_sql "INSERT INTO business_members (business_id, user_id, role, created_at, updated_at) SELECT '$ARCANIST_BUSINESS_ID', id, 'admin', unixepoch() * 1000, unixepoch() * 1000 FROM users WHERE github_id = $github_id ON CONFLICT (business_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at;"
  echo "    Seeded current GitHub user: github_id=$github_id login=$login business_id=$ARCANIST_BUSINESS_ID"

  local seeded_user_id
  seeded_user_id="$(npx wrangler d1 execute DB --local --command "SELECT id FROM users WHERE github_id = $github_id LIMIT 1;" --json | node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const id = data?.[0]?.results?.[0]?.id;
    if (id == null) process.exit(1);
    process.stdout.write(String(id));
  ' 2>/dev/null || true)"
  if [ -z "$seeded_user_id" ]; then
    echo "    warning: failed to resolve current GitHub user id after seed"
    return 0
  fi

  seed_github_token_for_user "$seeded_user_id" "current GitHub user" "1"
}

if [ -f "$DEV_VARS" ]; then
  echo "  Seeding github_installations..."

  # Look up the installation ID from the dev GitHub App
  INSTALLATION_JSON=$(node -e "
    const fs = require('fs');
    const { createAppAuth } = require('@octokit/auth-app');
    const { Octokit } = require('@octokit/rest');
    function normalizePrivateKey(raw) {
      let key = String(raw || '').trim().replace(/^\"|\"$/g, '').replace(/\\\\n/g, '\\n');
      if (!key.includes('\\n')) {
        const match = key.match(/^(-----BEGIN [^-]+-----)\\s+(.+?)\\s+(-----END [^-]+-----)$/);
        if (match) {
          const body = match[2].replace(/\\s+/g, '');
          const chunks = body.match(/.{1,64}/g) || [];
          key = [match[1], ...chunks, match[3]].join('\\n');
        }
      }
      return key;
    }
    const vars = fs.readFileSync('$DEV_VARS', 'utf8');
    const appId = vars.match(/GITHUB_APP_ID=(.+)/)?.[1]?.trim();
    const rawKey = normalizePrivateKey(vars.match(/GITHUB_PRIVATE_KEY=(.+)/)?.[1]);
    if (!appId || !rawKey) { console.error('Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY in $DEV_VARS'); process.exit(1); }
    const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey: rawKey } });
    octokit.apps.listInstallations().then(r => {
      console.log(JSON.stringify(r.data.map(i => ({ id: i.id, login: i.account?.login, type: i.account?.type }))));
    }).catch(e => { console.error(e.message); process.exit(1); });
  " 2>&1) || { echo "  Failed to fetch installations: $INSTALLATION_JSON"; exit 1; }

  # Seed each installation
  echo "$INSTALLATION_JSON" | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    data.forEach(i => {
      const sql = 'INSERT OR IGNORE INTO github_installations (installation_id, owner_login, owner_id, owner_type, repository_selection) VALUES (' + i.id + ', ' + \"'\" + i.login + \"'\" + ', 1, ' + \"'\" + (i.type || 'Organization') + \"'\" + ', ' + \"'all'\" + ');';
      console.log(sql);
    });
  " | while IFS= read -r sql; do
    exec_sql "$sql"
    echo "    Seeded: $sql"
  done
else
  echo "  Skipping github_installations seed: $DEV_VARS not found"
fi

seed_current_gh_user
seed_github_token_for_all_users_from_env
seed_github_token_for_all_users_from_gh
seed_github_installation_token_for_all_users
seed_local_provider_key_for_all_users "openai" "$(read_first_env_or_dev_var "OPENAI_API_KEY" "OPENAI_API_KEY_FOR_LOCAL_DEV" "OPENAI_API_KEY_INTERNAL_REVIEW" "ARCANIST_OPENAI_API_KEY")"

# Promote all local users to admin (useful for testing admin-only features like business-wide integrations)
echo "  Promoting all local users to admin..."
exec_sql "UPDATE business_members SET role = 'admin' WHERE role = 'member';" || true

echo "  Local seed complete."
