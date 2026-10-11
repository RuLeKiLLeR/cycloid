#!/usr/bin/env bash
set -euo pipefail

MARKER_PATH="${ARCANIST_EGRESS_MARKER_PATH:-/run/cycloid-egress-enforced}"
LOG_PATH="${ARCANIST_EGRESS_LOG_PATH:-/var/log/cycloid-egress.log}"
ALLOWLIST="${1:-${ARCANIST_SANDBOX_EGRESS_ALLOWLIST:-}}"
GITHUB_META_SNAPSHOT_PATH="${ARCANIST_GITHUB_META_SNAPSHOT_PATH:-/app/github-meta-cidrs.snapshot}"
GITHUB_META_FETCH_MAX_ATTEMPTS="${ARCANIST_GITHUB_META_FETCH_MAX_ATTEMPTS:-3}"
# Auth is opt-in for callers that need higher GitHub API rate limits. Do not
# implicitly consume ambient GITHUB_TOKEN values from unrelated CI jobs.
GITHUB_META_TOKEN="${ARCANIST_GITHUB_META_TOKEN:-}"

if [ "${ARCANIST_SANDBOX_EGRESS_ENFORCEMENT:-1}" = "0" ]; then
  echo "[egress] enforcement disabled"
  exit 0
fi

if [ -z "${ALLOWLIST//[[:space:],]/}" ]; then
  echo "[egress] allowlist is empty" >&2
  exit 2
fi

if [ -e "${MARKER_PATH}" ]; then
  echo "[egress] already enforced"
  exit 0
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "[egress] iptables is required" >&2
  exit 2
fi

mkdir -p "$(dirname "${MARKER_PATH}")" "$(dirname "${LOG_PATH}")"
touch "${LOG_PATH}"
chmod 0666 "${LOG_PATH}"

normalize_domains() {
  printf "%s" "${ALLOWLIST}" \
    | tr ',[:space:]' '\n' \
    | sed '/^$/d' \
    | awk '{print tolower($0)}' \
    | sort -u
}

validate_domain() {
  local domain="$1"
  if [[ "${domain}" == "*"* ]] || [[ "${domain}" == *"*"* ]] || [[ "${domain}" == "."* ]] || [[ "${domain}" == *"." ]]; then
    echo "[egress] invalid allowlist domain: ${domain}" >&2
    exit 2
  fi
  if ! [[ "${domain}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
    echo "[egress] invalid allowlist domain: ${domain}" >&2
    exit 2
  fi
}

resolve_domain() {
  local domain="$1"
  local attempt attempt_ips resolved_ips=""
  for attempt in 1 2 3 4 5 6 7 8; do
    attempt_ips="$(
      {
        getent ahosts "${domain}" 2>/dev/null | awk '{print $1}'
        getent hosts "${domain}" 2>/dev/null | awk '{print $1}'
      } | sort -u
    )"
    if [ -n "${attempt_ips}" ]; then
      resolved_ips="$(printf "%s\n%s\n" "${resolved_ips}" "${attempt_ips}" | sed '/^$/d' | sort -u)"
      # Take one extra immediate sample for round-robin DNS, but avoid sleeping
      # once resolution is working.
      if [ "${attempt}" != "1" ]; then
        break
      fi
    elif [ -n "${resolved_ips}" ]; then
      break
    elif [ "${attempt}" != "8" ]; then
      sleep 0.1
    fi
  done
  printf "%s\n" "${resolved_ips}" | sed '/^$/d' | sort -u
}

ensure_chain() {
  local binary="$1"
  local chain="$2"
  "${binary}" -N "${chain}" 2>/dev/null || "${binary}" -F "${chain}"
  "${binary}" -C OUTPUT -j "${chain}" 2>/dev/null || "${binary}" -I OUTPUT 1 -j "${chain}"
}

add_common_rules() {
  local binary="$1"
  local chain="$2"
  "${binary}" -A "${chain}" -o lo -j ACCEPT
  "${binary}" -A "${chain}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "${binary}" -A "${chain}" -p udp --dport 53 -j ACCEPT
  "${binary}" -A "${chain}" -p tcp --dport 53 -j ACCEPT
}

# RFC1918 private-network destinations. Allowed for OUTPUT because Docker's
# host-port forwarding DNATs `127.0.0.1:<host_port>` to the container's
# bridge IP (e.g. `172.17.0.x:<container_port>`). After the DNAT rewrite,
# the packet's destination is in 172.16.0.0/12 (or whichever bridge subnet
# the compose project picked) and its outbound interface is `docker0`, NOT
# `lo`. Without this rule the OUTPUT chain falls through to REJECT and
# `cycloid-app start` reports the app booted in the container but
# `curl http://127.0.0.1:<host_port>` from the sandbox host resets — which
# is exactly the failure the agent observed in prod session
# d5039304-51d8-4417-a622-fc8d05330686 right after PR #2817 fixed the
# Cloudflare CIDR drift.
#
# RFC1918 isn't routable from the sandbox to the public internet anyway
# (E2B isolates the sandbox network), so allowing these destinations
# doesn't expand the egress threat surface — it just stops blocking
# legitimate host->container loopback traffic.
add_private_network_rules() {
  local binary="$1"
  local chain="$2"
  local cidr
  for cidr in "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16"; do
    "${binary}" -A "${chain}" -d "${cidr}" -j ACCEPT
    echo "[egress] allowed private-network=${cidr}" >>"${LOG_PATH}"
  done
}

# Fastly's published IP ranges (https://api.fastly.com/public-ip-list). Allowed
# for ports 80/443 only when a Fastly-fronted domain is present in the allowlist
# (see FASTLY_ALLOWLIST_DOMAINS / allowlist_needs_fastly_ranges below). PyPI's
# `pypi.org` and `files.pythonhosted.org` are Fastly-fronted and use Anycast +
# short DNS TTLs, so the point-in-time per-domain A/AAAA resolution can miss the
# IP a later pip connection lands on — the same drift class the Cloudflare ranges
# above were added to fix. Trusting the published Fastly ranges does not expand
# trust beyond what the named allowlist already implies (only added when a
# Fastly-fronted allowlist domain is present). Refresh against
# https://api.fastly.com/public-ip-list when Fastly publishes an update.
FASTLY_IPV4_RANGES=(
  "23.235.32.0/20"
  "43.249.72.0/22"
  "103.244.50.0/24"
  "103.245.222.0/23"
  "103.245.224.0/24"
  "104.156.80.0/20"
  "140.248.64.0/18"
  "140.248.128.0/17"
  "146.75.0.0/17"
  "151.101.0.0/16"
  "157.52.64.0/18"
  "167.82.0.0/17"
  "167.82.128.0/20"
  "167.82.160.0/20"
  "167.82.224.0/20"
  "172.111.64.0/18"
  "185.31.16.0/22"
  "199.27.72.0/21"
  "199.232.0.0/16"
)
FASTLY_IPV6_RANGES=(
  "2a04:4e40::/32"
  "2a04:4e42::/32"
)
FASTLY_ALLOWLIST_DOMAINS=(
  "pypi.org"
  "files.pythonhosted.org"
)

GITHUB_META_ENDPOINT="https://api.github.com/meta"
GITHUB_META_ALLOWLIST_DOMAINS=(
  "github.com"
  "api.github.com"
  "codeload.github.com"
  "objects.githubusercontent.com"
  "raw.githubusercontent.com"
  "ghcr.io"
  "pkg-containers.githubusercontent.com"
)

allowlist_needs_fastly_ranges() {
  local domain allowed
  while IFS= read -r domain; do
    [ -n "${domain}" ] || continue
    for allowed in "${FASTLY_ALLOWLIST_DOMAINS[@]}"; do
      if [ "${domain}" = "${allowed}" ]; then
        return 0
      fi
    done
  done < <(normalize_domains)
  return 1
}

add_fastly_cidr_rules() {
  local chain="$1"
  local cidr
  if ! allowlist_needs_fastly_ranges; then
    return
  fi
  for cidr in "${FASTLY_IPV4_RANGES[@]}"; do
    iptables -A "${chain}" -p tcp -d "${cidr}" -m multiport --dports 80,443 -j ACCEPT
    echo "[egress] allowed fastly-cidr=${cidr}" >>"${LOG_PATH}"
  done
  if command -v ip6tables >/dev/null 2>&1; then
    for cidr in "${FASTLY_IPV6_RANGES[@]}"; do
      ip6tables -A "${chain}" -p tcp -d "${cidr}" -m multiport --dports 80,443 -j ACCEPT
      echo "[egress] allowed fastly-cidr=${cidr}" >>"${LOG_PATH}"
    done
  fi
}

allowlist_needs_github_meta_ranges() {
  local domain
  while IFS= read -r domain; do
    [ -n "${domain}" ] || continue
    case "${domain}" in
      github.com|api.github.com|codeload.github.com|objects.githubusercontent.com|raw.githubusercontent.com|ghcr.io|pkg-containers.githubusercontent.com)
        return 0
        ;;
    esac
  done < <(normalize_domains)
  return 1
}

fetch_github_meta_cidrs() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  local attempt backoff max_attempts payload cidrs
  local curl_args=(
    -fsSL
    -H "User-Agent: cycloid-egress-enforcer"
    --connect-timeout 5
    --max-time 20
  )
  if [ -n "${GITHUB_META_TOKEN}" ]; then
    curl_args+=(
      -H "Authorization: Bearer ${GITHUB_META_TOKEN}"
      -H "X-GitHub-Api-Version: 2022-11-28"
    )
  fi
  max_attempts="${GITHUB_META_FETCH_MAX_ATTEMPTS}"
  if ! [[ "${max_attempts}" =~ ^[1-9][0-9]*$ ]]; then
    max_attempts=3
  fi
  for attempt in $(seq 1 "${max_attempts}"); do
    if payload="$(
      curl "${curl_args[@]}" "${GITHUB_META_ENDPOINT}"
    )"; then
      if cidrs="$(
        printf "%s" "${payload}" \
          | jq -r '
              [
                (.web // []),
                (.api // []),
                (.git // []),
                (.hooks // []),
                (.packages // [])
              ] | flatten[]?
            ' \
          | sed '/^$/d' \
          | sort -u
      )"; then
        printf "%s\n" "${cidrs}"
        return 0
      fi
    fi
    echo "[egress] github-meta-fetch-failed endpoint=${GITHUB_META_ENDPOINT} attempt=${attempt} max_attempts=${max_attempts}" | tee -a "${LOG_PATH}" >&2
    if [ "${attempt}" -lt "${max_attempts}" ]; then
      backoff=$((2 ** (attempt - 1)))
      sleep "${backoff}"
    fi
  done
  return 1
}

read_github_meta_snapshot_cidrs() {
  local snapshot_path="${GITHUB_META_SNAPSHOT_PATH}"
  if [ ! -s "${snapshot_path}" ]; then
    return 1
  fi
  grep -Ehv '^\s*(#|$)' "${snapshot_path}" | sed 's/[[:space:]]*$//' | sort -u
}

add_github_meta_cidr_rules() {
  local chain="$1"
  local cidr cidrs="" cidr_source=""
  if ! allowlist_needs_github_meta_ranges; then
    return
  fi
  if cidrs="$(fetch_github_meta_cidrs)"; then
    cidr_source="live"
  elif cidrs="$(read_github_meta_snapshot_cidrs)"; then
    cidr_source="snapshot"
    echo "[egress] github-meta-snapshot-used path=${GITHUB_META_SNAPSHOT_PATH}" | tee -a "${LOG_PATH}" >&2
  else
    echo "[egress] github-meta-cidrs-unavailable endpoint=${GITHUB_META_ENDPOINT} snapshot_path=${GITHUB_META_SNAPSHOT_PATH}" | tee -a "${LOG_PATH}" >&2
    return 1
  fi
  while IFS= read -r cidr; do
    [ -n "${cidr}" ] || continue
    case "${cidr}" in
      *:*)
        if command -v ip6tables >/dev/null 2>&1; then
          ip6tables -A "${chain}" -p tcp -d "${cidr}" -m multiport --dports 80,443 -j ACCEPT
        fi
        ;;
      *)
        iptables -A "${chain}" -p tcp -d "${cidr}" -m multiport --dports 80,443 -j ACCEPT
        ;;
    esac
    echo "[egress] allowed github-meta-cidr=${cidr} source=${cidr_source}" >>"${LOG_PATH}"
  done <<<"${cidrs}"
  return 0
}

CHAIN="ARCANIST_EGRESS"
ensure_chain iptables "${CHAIN}"
add_common_rules iptables "${CHAIN}"
add_private_network_rules iptables "${CHAIN}"

if command -v ip6tables >/dev/null 2>&1; then
  ensure_chain ip6tables "${CHAIN}"
  add_common_rules ip6tables "${CHAIN}"
  # RFC1918 is IPv4-only; IPv6 has Unique Local Addresses (fc00::/7) but
  # Docker bridges are IPv4-only by default, so we don't add an IPv6 ULA
  # rule here. If we ever wire IPv6 docker bridges, mirror this for ip6.
fi

add_fastly_cidr_rules "${CHAIN}"
if ! add_github_meta_cidr_rules "${CHAIN}"; then
  echo "[egress] failed-closed reason=github-meta-cidrs-unavailable" >&2
  exit 2
fi

resolved_count=0
unresolved_count=0
# Keep public egress pinned to the exact IPs resolved for the named allowlist
# domains. Provider-wide CDN CIDR exceptions (notably Cloudflare) reopen access
# to unrelated tenants and defeat the allowlist boundary this firewall is meant
# to enforce.
while IFS= read -r domain; do
  validate_domain "${domain}"
  ips="$(resolve_domain "${domain}")"
  if [ -z "${ips}" ]; then
    echo "[egress] unresolved domain=${domain}" | tee -a "${LOG_PATH}" >&2
    unresolved_count=$((unresolved_count + 1))
    continue
  fi
  while IFS= read -r ip; do
    [ -n "${ip}" ] || continue
    case "${ip}" in
      *:*)
        if command -v ip6tables >/dev/null 2>&1; then
          ip6tables -A "${CHAIN}" -p tcp -d "${ip}" -m multiport --dports 80,443 -j ACCEPT
        fi
        ;;
      *)
        iptables -A "${CHAIN}" -p tcp -d "${ip}" -m multiport --dports 80,443 -j ACCEPT
        ;;
    esac
    resolved_count=$((resolved_count + 1))
    echo "[egress] allowed domain=${domain} ip=${ip}" >>"${LOG_PATH}"
  done <<<"${ips}"
done < <(normalize_domains)

if [ "${resolved_count}" -eq 0 ]; then
  echo "[egress] no allowlist addresses resolved" >&2
  exit 2
fi

iptables -A "${CHAIN}" -m limit --limit 12/min -j LOG --log-prefix "cycloid-egress-block " --log-level 4 2>/dev/null || true
iptables -A "${CHAIN}" -j REJECT

if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -A "${CHAIN}" -m limit --limit 12/min -j LOG --log-prefix "cycloid-egress-block " --log-level 4 2>/dev/null || true
  ip6tables -A "${CHAIN}" -j REJECT
fi

date +%s >"${MARKER_PATH}"
chmod 0644 "${MARKER_PATH}"
echo "[egress] enforced allowed_addresses=${resolved_count} unresolved_domains=${unresolved_count}"
