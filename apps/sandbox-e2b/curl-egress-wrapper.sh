#!/usr/bin/env bash
set -euo pipefail

REAL_CURL="${ARCANIST_REAL_CURL_PATH:-/usr/bin/curl}"
LOG_PATH="${ARCANIST_EGRESS_LOG_PATH:-/var/log/cycloid-egress.log}"
ALLOWLIST="${ARCANIST_SANDBOX_EGRESS_ALLOWLIST:-}"
PERMANENTLY_BLOCKED="This command is permanently blocked -- do not retry."

deny() {
  printf 'Policy block: %s\n' "$1" >&2
  exit 126
}

normalize_host() {
  local host="$1"
  host="$(printf "%s" "${host}" | tr '[:upper:]' '[:lower:]')"
  host="${host#[}"
  host="${host%]}"
  printf "%s" "${host}"
}

is_allowed_host() {
  local host="$1"
  local entry
  IFS=',' read -ra entries <<<"${ALLOWLIST}"
  for entry in "${entries[@]}"; do
    entry="$(normalize_host "${entry}")"
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    if [ "${entry}" = "${host}" ]; then
      return 0
    fi
  done
  return 1
}

is_local_host() {
  local host="$1"
  case "${host}" in
    localhost|::1|127.*|10.*|192.168.*|172.16.*|172.17.*|172.18.*|172.19.*|172.2[0-9].*|172.30.*|172.31.*)
      return 0
      ;;
  esac
  return 1
}

validate_url_args() {
  if [ -z "${ALLOWLIST//[[:space:],]/}" ]; then
    return
  fi

  local arg host
  for arg in "$@"; do
    if ! [[ "${arg}" =~ ^https?://(\[[^]/?#]+\]|[^/:?#]+) ]]; then
      continue
    fi
    host="$(normalize_host "${BASH_REMATCH[1]}")"
    if is_local_host "${host}" || is_allowed_host "${host}"; then
      continue
    fi
    printf '[egress] blocked domain=%s tool=curl\n' "${host}" >>"${LOG_PATH}" 2>/dev/null || true
    deny "curl to non-allowlisted domain ${host} is blocked. ${PERMANENTLY_BLOCKED}"
  done
}

validate_url_args "$@"
exec "${REAL_CURL}" "$@"
