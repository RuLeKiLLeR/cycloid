#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "Skipping gh authentication: gh CLI not found"
  exit 0
fi

verify_gh_token() {
  [ -n "$(gh auth token -h github.com 2>/dev/null || true)" ]
}

verify_gh_token_with_retries() {
  local attempt
  for attempt in 1 2 3; do
    if verify_gh_token; then
      return 0
    fi
    sleep "${GH_AUTH_VERIFY_RETRY_SLEEP_SECONDS:-$attempt}"
  done
  echo "gh auth token is still empty after authentication"
  return 1
}

gh_config_dir() {
  if [ -n "${GH_CONFIG_DIR:-}" ]; then
    printf "%s" "$GH_CONFIG_DIR"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf "%s/gh" "$XDG_CONFIG_HOME"
  else
    printf "%s/.config/gh" "$HOME"
  fi
}

write_github_user_token_config() {
  local login="$1"
  local hosts_file
  hosts_file="$(gh_config_dir)/hosts.yml"
  GH_TOKEN_TO_STORE="$token_value" node --input-type=module - "$hosts_file" "$login" <<'NODE'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";

const [hostsFile, login] = process.argv.slice(2);
const token = process.env.GH_TOKEN_TO_STORE ?? "";
if (!hostsFile || !login || !token) process.exit(1);

let root = {};
if (existsSync(hostsFile)) {
  const existing = readFileSync(hostsFile, "utf8");
  if (existing.trim()) {
    const parsed = parseDocument(existing).toJSON();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed;
  }
}

root["github.com"] = {
  git_protocol: "https",
  users: {
    [login]: { oauth_token: token },
  },
  user: login,
};

mkdirSync(dirname(hostsFile), { recursive: true, mode: 0o700 });
writeFileSync(hostsFile, stringify(root), { mode: 0o600 });
chmodSync(hostsFile, 0o600);
NODE
}

authenticate_github_user_token() {
  local login
  login="$(GH_TOKEN="$token_value" gh api user --jq .login 2>/dev/null || true)"
  if [ -z "$login" ]; then
    echo "Failed to resolve GitHub login from GITHUB_USER_TOKEN"
    return 1
  fi
  write_github_user_token_config "$login"
  verify_gh_token_with_retries
}

if verify_gh_token; then
  echo "gh already authenticated"
  exit 0
fi

token_name=""
token_value=""
for candidate in GITHUB_USER_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!candidate:-}" ]; then
    token_name="$candidate"
    token_value="${!candidate}"
    break
  fi
done

if [ -z "$token_value" ]; then
  echo "gh is not logged in and no GITHUB_USER_TOKEN, GH_TOKEN, or GITHUB_TOKEN is set"
  exit 1
fi

if [ "$token_name" = "GITHUB_USER_TOKEN" ]; then
  authenticate_github_user_token
  echo "Authenticated gh from $token_name"
  exit 0
fi

if printf '%s\n' "$token_value" | gh auth login --hostname github.com --with-token >/dev/null 2>&1; then
  verify_gh_token_with_retries
  echo "Authenticated gh from $token_name"
  exit 0
fi

echo "Token from $token_name was rejected by gh auth login"
exit 1
