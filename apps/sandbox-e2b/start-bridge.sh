#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="${REPO_PATH:-/workspace/repo}"
BRIDGE_BUNDLE="${BRIDGE_BUNDLE:-/app/bridge/bundle.js}"
CLONE_DEPTH="${CLONE_DEPTH:-1}"
WORKSPACE_SETUP_PENDING_PATH="${ARCANIST_WORKSPACE_SETUP_PENDING_PATH:-/tmp/cycloid-workspace-setup-pending}"
WORKSPACE_SETUP_READY_PATH="${ARCANIST_WORKSPACE_SETUP_READY_PATH:-/tmp/cycloid-workspace-setup-ready}"
WORKSPACE_SETUP_FAILED_PATH="${ARCANIST_WORKSPACE_SETUP_FAILED_PATH:-/tmp/cycloid-workspace-setup-failed}"
CLI_AUTH_PENDING_PATH="${ARCANIST_CLI_AUTH_PENDING_PATH:-/tmp/cycloid-cli-auth-pending}"
CLI_AUTH_READY_PATH="${ARCANIST_CLI_AUTH_READY_PATH:-/tmp/cycloid-cli-auth-ready}"
CLI_AUTH_FAILED_PATH="${ARCANIST_CLI_AUTH_FAILED_PATH:-/tmp/cycloid-cli-auth-failed}"
START_BRIDGE_LOG_PATH="${ARCANIST_START_BRIDGE_LOG_PATH:-/tmp/cycloid-start-bridge.log}"
# Sanitized repo-prep timing breadcrumb for spawn-latency instrumentation. Holds
# ONLY a path label (clone|fetch) and an integer millisecond duration — never
# tokens, URLs, branch names, or filesystem paths. The bridge reads and re-logs
# it at startup so cold-clone vs prebaked-fetch is attributable in Datadog.
REPO_PREP_TIMINGS_PATH="${ARCANIST_REPO_PREP_TIMINGS_PATH:-/tmp/cycloid-repo-prep-timings}"
# Sanitized workspace-setup timing breadcrumb, same discipline as the repo-prep
# one above: holds ONLY a fixed-vocabulary kind label (repo_setup_script | npm |
# pnpm | yarn | <pm>_skip_existing) and the integer millisecond duration of the
# actual setup work — never repo content, scripts, or paths. The bridge reads it
# when it observes setup completion and folds setup_kind/setup_ms into Datadog
# telemetry, so the install/build phase of cold start is attributable alongside
# e2b-create and clone/fetch. This is the real execution wall time, distinct from
# the bridge's per-prompt setup wait time.
SETUP_TIMINGS_PATH="${ARCANIST_SETUP_TIMINGS_PATH:-/tmp/cycloid-setup-timings}"
export DISPLAY="${ARCANIST_DESKTOP_DISPLAY:-:99}"

# This script's git operations are trusted BOOT CODE and must bypass the agent
# git policy wrapper at /usr/local/bin/git: the prebaked-image path resets the baked
# branch with `checkout -B <branch> FETCH_HEAD`, which the wrapper denies as
# agent branch creation (exit 126) — the bridge then never starts and every
# spawn times out retrying (2026-07-08 cycloid prebaked-snapshot incident; the same
# break was latent on E2B prebaked images for fresh sessions). Resolve the real
# binary the same way the wrapper itself does, falling back to PATH git where no
# wrapper layout exists (tests, plain hosts). The function shadows PATH lookup
# for every git call in this script including backgrounded subshells; agent
# processes are spawned later with normal PATH resolution and still get the
# policy wrapper.
START_BRIDGE_GIT="${ARCANIST_REAL_GIT_PATH:-/usr/local/lib/cycloid/real-bin/git}"
if [ ! -x "${START_BRIDGE_GIT}" ]; then
  START_BRIDGE_GIT="$(command -v git || true)"
fi
git() {
  "${START_BRIDGE_GIT}" "$@"
}

mkdir -p "$(dirname "${START_BRIDGE_LOG_PATH}")"
touch "${START_BRIDGE_LOG_PATH}"
chmod 0600 "${START_BRIDGE_LOG_PATH}" || true

log_stage() {
  printf '[start-bridge] %s\n' "$*" | tee -a "${START_BRIDGE_LOG_PATH}"
}

log_error() {
  printf '%s\n' "$*" | tee -a "${START_BRIDGE_LOG_PATH}" >&2
}

trap 'status=$?; if [ "${status}" -ne 0 ]; then log_error "[start-bridge] exit status=${status}"; fi' EXIT
log_stage "script_start"

LAYER_ENV_PATH="/etc/cycloid/layer-env.sh"
if [ -r "${LAYER_ENV_PATH}" ]; then
  # shellcheck source=/dev/null
  . "${LAYER_ENV_PATH}"
  log_stage "layer_env_loaded"
fi

required_env=(
  CONTROL_PLANE_URL
  SESSION_ID
  SANDBOX_ID
  SANDBOX_AUTH_TOKEN
  REPO_OWNER
  REPO_NAME
  GITHUB_CLONE_TOKEN
)

for key in "${required_env[@]}"; do
  if [ -z "${!key:-}" ]; then
    log_error "Missing required environment variable: ${key}"
    exit 2
  fi
done

# Cycloid-owned credentials untrusted repo code never needs. GITHUB_CLONE_TOKEN
# is deliberately retained: private dependency and registry installs require
# that short-lived repository credential, while broader platform credentials
# remain unavailable to lifecycle hooks.
UNTRUSTED_REPO_ENV_SCRUB=(
  SANDBOX_AUTH_TOKEN ARCANIST_TOKEN ARCANIST_ADMIN_TOKEN ARCANIST_RUNTIME_AUTH_PROOF
  CODEX_API_KEY OPENAI_API_KEY ARCANIST_OPENAI_API_KEY ARCANIST_CODEX_AUTH_JSON
  ANTHROPIC_API_KEY ARCANIST_ANTHROPIC_API_KEY BASETEN_API_KEY ARCANIST_BASETEN_API_KEY
  GH_TOKEN GITHUB_TOKEN GITHUB_USER_TOKEN DD_API_KEY DD_APP_KEY BRAINTRUST_API_KEY
  SANDBOX_CALLBACK_SECRET SANDBOX_RUNTIME_CLEANUP_SECRET
  LINEAR_ACCESS_TOKEN JIRA_ACCESS_TOKEN NOTION_ACCESS_TOKEN SENTRY_ACCESS_TOKEN
  CLOUDFLARE_API_TOKEN LAUNCHDARKLY_ACCESS_TOKEN VERCEL_ACCESS_TOKEN
  STRIPE_SECRET_KEY ARCANIST_TERRAFORM_PLAN_TOKEN
)
UNTRUSTED_REPO_ENV_SCRUB_ARGS=()
for key in "${UNTRUSTED_REPO_ENV_SCRUB[@]}"; do
  UNTRUSTED_REPO_ENV_SCRUB_ARGS+=(-u "${key}")
done

if [ ! -s "${BRIDGE_BUNDLE}" ]; then
  log_error "Bridge bundle not found: ${BRIDGE_BUNDLE}"
  exit 2
fi

# Branch names are passed as leading positionals to git fetch/checkout below; a
# leading dash would be parsed as a git flag (argument injection). The control
# plane validates these before persistence; this is defense-in-depth.
for branch_var in CHECKOUT_BRANCH BRANCH; do
  case "${!branch_var:-}" in
    -*)
      log_error "Refusing ${branch_var} with leading dash: ${!branch_var}"
      exit 2
      ;;
  esac
done

# --- Swap (best-effort) --------------------------------------------------------
# Heavy in-sandbox builds (webpack, JVM, multi-service compose) can exhaust the
# sandbox RAM and trip the kernel OOM-killer, which kills the build container,
# cascades into a lost sandbox, and surfaces to the agent as "Sandbox
# disconnected". A swapfile lets those builds spill to disk instead of OOM-ing.
# Sized adaptively to leave disk headroom for docker images/build artifacts;
# every step is best-effort and never blocks bridge startup.
# Tunables: ARCANIST_SWAP_DISABLED=1 skips; ARCANIST_SWAP_SIZE_GB forces a size;
# ARCANIST_SWAP_RESERVE_GB / ARCANIST_SWAP_MAX_GB adjust the heuristic.
SWAPFILE_PATH="${ARCANIST_SWAPFILE_PATH:-/swapfile}"

is_positive_int() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

# Accepts a positive decimal (e.g. 1 or 0.02). Rejects empty, non-numeric,
# multiple dots, and any zero-valued input. Used for sleep intervals where
# `[ -gt ]` cannot handle fractions.
is_positive_number() {
  case "$1" in
    '' | . | *[!0-9.]* | *.*.*) return 1 ;;
  esac
  # Require at least one nonzero digit so 0, 0.0, .00 are rejected.
  case "$1" in
    *[1-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

setup_swap() {
  if [ "${ARCANIST_SWAP_DISABLED:-0}" = "1" ]; then
    log_stage "swap_skip reason=disabled"
    return 0
  fi
  # Exact first-column match: /proc/swaps lists the swap device/file in column 1,
  # so a substring grep would false-match an unrelated entry (e.g. /mnt/swap vs
  # /mnt/swap2) and wrongly skip creation. Header line (NR==1) is ignored.
  if [ -r /proc/swaps ] && awk -v p="${SWAPFILE_PATH}" 'NR>1 && $1==p{f=1} END{exit !f}' /proc/swaps; then
    log_stage "swap_skip reason=already_active path=${SWAPFILE_PATH}"
    return 0
  fi

  # Validate numeric tunables up front so a bad value skips cleanly instead of
  # reaching fallocate with a malformed size or aborting under set -euo pipefail.
  local reserve_gb="${ARCANIST_SWAP_RESERVE_GB:-10}"
  local max_gb="${ARCANIST_SWAP_MAX_GB:-8}"
  if ! is_positive_int "${reserve_gb}" || ! is_positive_int "${max_gb}"; then
    log_stage "swap_skip reason=invalid_config reserve_gb=${reserve_gb} max_gb=${max_gb}"
    return 0
  fi

  local swap_gb avail_gb=""
  if [ -n "${ARCANIST_SWAP_SIZE_GB:-}" ]; then
    if ! is_positive_int "${ARCANIST_SWAP_SIZE_GB}"; then
      log_stage "swap_skip reason=invalid_config size_gb=${ARCANIST_SWAP_SIZE_GB}"
      return 0
    fi
    swap_gb="${ARCANIST_SWAP_SIZE_GB}"
  else
    # GNU df: integer GiB available on the swapfile's filesystem. Leave
    # reserve_gb free so docker images/build artifacts are not starved.
    avail_gb="$(df -BG --output=avail "$(dirname "${SWAPFILE_PATH}")" 2>/dev/null | tail -1 | tr -dc '0-9')"
    swap_gb=$(( ${avail_gb:-0} - reserve_gb ))
    if [ "${swap_gb}" -gt "${max_gb}" ]; then swap_gb="${max_gb}"; fi
  fi
  if [ "${swap_gb}" -lt 2 ]; then
    if [ -n "${ARCANIST_SWAP_SIZE_GB:-}" ]; then
      log_stage "swap_skip reason=size_below_floor size_gb=${swap_gb}"
    else
      log_stage "swap_skip reason=insufficient_disk avail_gb=${avail_gb:-unknown} reserve_gb=${reserve_gb}"
    fi
    return 0
  fi

  if ! sudo fallocate -l "${swap_gb}G" "${SWAPFILE_PATH}" 2>/dev/null; then
    if ! sudo dd if=/dev/zero of="${SWAPFILE_PATH}" bs=1M count=$(( swap_gb * 1024 )) status=none 2>/dev/null; then
      log_error "[start-bridge] swap_allocate_failed size_gb=${swap_gb}"
      sudo rm -f "${SWAPFILE_PATH}" 2>/dev/null || true
      return 0
    fi
  fi
  sudo chmod 600 "${SWAPFILE_PATH}" 2>/dev/null || true
  if sudo mkswap "${SWAPFILE_PATH}" >/dev/null 2>&1 && sudo swapon "${SWAPFILE_PATH}" 2>/dev/null; then
    log_stage "swap_enabled size_gb=${swap_gb} path=${SWAPFILE_PATH}"
  else
    log_error "[start-bridge] swap_enable_failed size_gb=${swap_gb}"
    sudo rm -f "${SWAPFILE_PATH}" 2>/dev/null || true
  fi
  return 0
}

log_stage "swap_setup_start"
setup_swap || true

export REPO_PATH
export ARCANIST_WORKSPACE_SETUP_PENDING_PATH="${WORKSPACE_SETUP_PENDING_PATH}"
export ARCANIST_WORKSPACE_SETUP_READY_PATH="${WORKSPACE_SETUP_READY_PATH}"
export ARCANIST_WORKSPACE_SETUP_FAILED_PATH="${WORKSPACE_SETUP_FAILED_PATH}"
export ARCANIST_CLI_AUTH_PENDING_PATH="${CLI_AUTH_PENDING_PATH}"
export ARCANIST_CLI_AUTH_READY_PATH="${CLI_AUTH_READY_PATH}"
export ARCANIST_CLI_AUTH_FAILED_PATH="${CLI_AUTH_FAILED_PATH}"

enforce_egress_if_configured() {
  if [ "${ARCANIST_SANDBOX_EGRESS_ENFORCEMENT:-1}" = "0" ]; then
    echo "[start-bridge] egress_enforcement_skip reason=disabled"
    return
  fi
  if [ -z "${ARCANIST_SANDBOX_EGRESS_ALLOWLIST:-}" ]; then
    return
  fi
  if [ ! -x /usr/local/sbin/cycloid-enforce-egress ]; then
    log_error "[start-bridge] egress_enforcement_missing"
    exit 2
  fi
  sudo /usr/local/sbin/cycloid-enforce-egress "${ARCANIST_SANDBOX_EGRESS_ALLOWLIST}"
}

log_stage "egress_configure_start"
enforce_egress_if_configured
log_stage "egress_configure_complete"

PUBLIC_REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
AUTH_REPO_URL="https://x-access-token:${GITHUB_CLONE_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"

redact_token() {
  sed "s/${GITHUB_CLONE_TOKEN}/[redacted]/g"
}

run_git() {
  local stderr_file status=0
  stderr_file="$(mktemp)"
  # `|| status=$?` both suppresses `set -e` for the call and captures the real
  # exit status. The previous `if "$@"; then ...; fi; status=$?` read `$?`
  # *after* the if, which is 0 when the condition fails with no else -- so
  # run_git always returned success and never propagated git failures (defeating
  # both the failure exit and this stderr capture).
  "$@" 2>"${stderr_file}" || status=$?
  if [ "${status}" -eq 0 ]; then
    rm -f "${stderr_file}"
    return 0
  fi
  redact_token <"${stderr_file}" | tee -a "${START_BRIDGE_LOG_PATH}" >&2 || true
  rm -f "${stderr_file}"
  return "${status}"
}

github_basic_auth_header() {
  printf "x-access-token:%s" "${GITHUB_CLONE_TOKEN}" | base64 | tr -d '\n'
}

git_auth() {
  git -C "${REPO_PATH}" \
    -c credential.helper= \
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(github_basic_auth_header)" \
    "$@"
}

assert_clean_remote() {
  local git_config_path
  git_config_path="$(git -C "${REPO_PATH}" rev-parse --git-path config 2>/dev/null || true)"
  if [ -z "${git_config_path}" ] || [ ! -f "${git_config_path}" ]; then
    return
  fi
  if grep -q "x-access-token" "${git_config_path}"; then
    log_error "credential-bearing git remote remains after clone"
    exit 1
  fi
  if [ -n "${GITHUB_CLONE_TOKEN:-}" ] && grep -Fq "${GITHUB_CLONE_TOKEN}" "${git_config_path}"; then
    log_error "credential-bearing git remote remains after clone"
    exit 1
  fi
}

scrub_origin_remote() {
  if git -C "${REPO_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "${REPO_PATH}" remote set-url origin "${PUBLIC_REPO_URL}"
  fi
  assert_clean_remote
}

target_branch() {
  if [ -n "${CHECKOUT_BRANCH:-}" ]; then
    printf "%s" "${CHECKOUT_BRANCH}"
  elif [ -n "${BRANCH:-}" ]; then
    printf "%s" "${BRANCH}"
  fi
}

empty_repo_checkout_branch() {
  if [ -n "${CHECKOUT_BRANCH:-}" ]; then
    printf "%s" "${CHECKOUT_BRANCH}"
    return
  fi
  printf "cycloid/session-work-%s" "${SESSION_ID}"
}

fetch_base_branch_if_needed() {
  local resolved_branch="$1"
  if [ -n "${CHECKOUT_BRANCH:-}" ] && [ -n "${BRANCH:-}" ] && [ "${resolved_branch}" != "${BRANCH}" ]; then
    # Explicit refspec so the fetch creates refs/remotes/origin/<base>; a plain
    # `fetch origin <branch>` only updates FETCH_HEAD, which left the bridge's
    # base-ref diff baseline (ARC-1192) unresolvable in every sandbox. Failure
    # stays non-fatal (the publish-branch baseline covers the prompt) but is
    # logged so a missing base ref is diagnosable.
    if ! run_git git_auth fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" --depth "${CLONE_DEPTH}"; then
      log_stage "repo_fetch_base_branch_failed base=${BRANCH}"
    fi
  fi
}

# ARC-1515: an adopted external PR (ARCANIST_STRICT_HEAD_CHECKOUT=1) must never fall
# back to the base branch when its head branch cannot be fetched/checked out — running
# on base would push a stray branch and touch the human's PR without changing its code.
# Fail the boot closed instead. Only ever true for mention-bootstrapped adopted sessions.
is_strict_head_checkout() {
  [ "${ARCANIST_STRICT_HEAD_CHECKOUT:-}" = "1" ]
}

clone_repo() {
  local branch="${1:-}"
  mkdir -p "$(dirname "${REPO_PATH}")"
  if [ -n "${branch}" ]; then
    if run_git git clone --depth "${CLONE_DEPTH}" --branch "${branch}" "${AUTH_REPO_URL}" "${REPO_PATH}"; then
      scrub_origin_remote
      fetch_base_branch_if_needed "${branch}"
      scrub_origin_remote
      return
    fi

    if is_strict_head_checkout && [ -n "${CHECKOUT_BRANCH:-}" ] && [ "${branch}" = "${CHECKOUT_BRANCH}" ]; then
      log_error "[start-bridge] repo_checkout_strict_no_base_fallback stage=clone branch=${branch} checkout_branch=${CHECKOUT_BRANCH} base=${BRANCH:-}"
      exit 1
    fi

    if [ -n "${CHECKOUT_BRANCH:-}" ] && [ "${branch}" = "${CHECKOUT_BRANCH}" ] && [ -n "${BRANCH:-}" ]; then
      rm -rf "${REPO_PATH}"
      if run_git git clone --depth "${CLONE_DEPTH}" --branch "${BRANCH}" "${AUTH_REPO_URL}" "${REPO_PATH}"; then
        scrub_origin_remote
        return
      fi
    fi

    # GitHub reports `default_branch` for zero-commit repositories, but no
    # refs/heads/<branch> exists yet. Fall back to a plain clone only when that
    # produces an unborn checkout so the agent can create the first commit.
    rm -rf "${REPO_PATH}"
    log_stage "repo_clone_branch_failed_try_empty_fallback branch=${branch}"
    if run_git git clone --depth "${CLONE_DEPTH}" "${AUTH_REPO_URL}" "${REPO_PATH}"; then
      scrub_origin_remote
      if git -C "${REPO_PATH}" rev-parse --verify HEAD >/dev/null 2>&1; then
        log_error "[start-bridge] repo_clone_branch_missing_non_empty branch=${branch}"
        exit 1
      fi
      local checkout_branch
      checkout_branch="$(empty_repo_checkout_branch)"
      log_stage "repo_clone_empty_fallback branch=${branch} checkout_branch=${checkout_branch}"
      run_git git -C "${REPO_PATH}" checkout -B "${checkout_branch}"
      return
    fi

    exit 1
  fi

  run_git git clone --depth "${CLONE_DEPTH}" "${AUTH_REPO_URL}" "${REPO_PATH}"
  scrub_origin_remote
}

prepare_existing_repo() {
  local branch="${1:-}"
  scrub_origin_remote
  if [ -z "${branch}" ]; then
    return
  fi

  local preserve_existing_branch_worktree="0"
  if [ -n "${CHECKOUT_BRANCH:-}" ] && [ "${branch}" = "${CHECKOUT_BRANCH}" ]; then
    preserve_existing_branch_worktree="1"
  fi

  # All git calls below route through run_git so a failure under `set -e`
  # records the (token-redacted) git stderr into the start-bridge log instead
  # of aborting silently -- repo-prepare failures here exit before the bridge
  # starts and otherwise surface only as spawn_deadline_no_bridge with no cause.
  # Explicit refspec so the fetch also creates refs/remotes/origin/<branch>:
  # the bridge diffs the working tree against that tracking ref to detect
  # publishable work, and the FETCH_HEAD-only form left it missing on the
  # existing-repo path (see the comment below).
  log_stage "repo_fetch_session_branch branch=${branch}"
  if run_git git_auth fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" --depth "${CLONE_DEPTH}"; then
    if [ "${preserve_existing_branch_worktree}" = "1" ]; then
      # Prefer checking out the existing local branch to preserve its worktree
      # state. On a cold/fresh template repo that local ref may not exist; a
      # plain `git checkout <branch>` can then fail with "pathspec did not
      # match" and the bridge never starts (surfacing only as
      # spawn_deadline_no_bridge). Fall back to materializing the branch from
      # the fetched FETCH_HEAD, the same ref the non-preserve path below uses.
      log_stage "repo_checkout_session_branch branch=${branch}"
      if ! run_git git -C "${REPO_PATH}" checkout "${branch}"; then
        log_stage "repo_checkout_session_branch_fetchhead_fallback branch=${branch}"
        run_git git -C "${REPO_PATH}" checkout -B "${branch}" FETCH_HEAD
      fi
    else
      local existing_status
      existing_status="$(git -C "${REPO_PATH}" status --porcelain --untracked-files=all 2>/dev/null || true)"
      if [ -n "${existing_status}" ]; then
        log_error "[start-bridge] repo_checkout_dirty_without_session_branch path=${REPO_PATH}"
        exit 1
      fi
      log_stage "repo_checkout_session_branch_fetchhead branch=${branch}"
      run_git git -C "${REPO_PATH}" checkout -B "${branch}" FETCH_HEAD
    fi
    fetch_base_branch_if_needed "${branch}"
    scrub_origin_remote
    return
  fi

  log_stage "repo_session_branch_fetch_failed branch=${branch} fallback_base=${BRANCH:-}"
  if is_strict_head_checkout && [ -n "${CHECKOUT_BRANCH:-}" ] && [ "${branch}" = "${CHECKOUT_BRANCH}" ]; then
    log_error "[start-bridge] repo_checkout_strict_no_base_fallback stage=prepare_existing branch=${branch} checkout_branch=${CHECKOUT_BRANCH} base=${BRANCH:-}"
    exit 1
  fi
  if [ -n "${CHECKOUT_BRANCH:-}" ] && [ "${branch}" = "${CHECKOUT_BRANCH}" ] && [ -n "${BRANCH:-}" ]; then
    log_stage "repo_fetch_base_branch base=${BRANCH}"
    run_git git_auth fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" --depth "${CLONE_DEPTH}"
    local existing_status
    existing_status="$(git -C "${REPO_PATH}" status --porcelain --untracked-files=all 2>/dev/null || true)"
    if [ -n "${existing_status}" ]; then
      log_error "[start-bridge] repo_checkout_dirty_without_session_branch path=${REPO_PATH}"
      exit 1
    fi
    log_stage "repo_checkout_base_branch base=${BRANCH}"
    run_git git -C "${REPO_PATH}" checkout -B "${BRANCH}" FETCH_HEAD
    scrub_origin_remote
    return
  fi
  log_error "[start-bridge] repo_prepare_existing_no_fallback branch=${branch} checkout_branch=${CHECKOUT_BRANCH:-} base=${BRANCH:-}"
  scrub_origin_remote
  exit 1
}

assert_repo_checkout_ready() {
  if [ ! -e "${REPO_PATH}/.git" ]; then
    log_error "[start-bridge] repo_checkout_missing path=${REPO_PATH}"
    exit 1
  fi
  if ! git -C "${REPO_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log_error "[start-bridge] repo_checkout_invalid path=${REPO_PATH}"
    exit 1
  fi
  # ARC-1515 strict adopted-PR checkout: confirm we actually landed on the session's
  # head branch (never a base-branch fallback) before the bridge starts.
  if is_strict_head_checkout && [ -n "${CHECKOUT_BRANCH:-}" ]; then
    local strict_head_branch
    strict_head_branch="$(git -C "${REPO_PATH}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    if [ "${strict_head_branch}" != "${CHECKOUT_BRANCH}" ]; then
      log_error "[start-bridge] repo_checkout_strict_branch_mismatch expected=${CHECKOUT_BRANCH} actual=${strict_head_branch}"
      exit 1
    fi
    log_stage "repo_checkout_strict_verified branch=${CHECKOUT_BRANCH}"
  fi
}

# Epoch milliseconds via GNU date (E2B image is Linux). Best-effort: any failure
# leaves the timing breadcrumb unwritten rather than aborting startup.
now_ms() {
  local ns seconds
  ns="$(date +%s%N 2>/dev/null)" || return 1
  case "${ns}" in
    '' | *[!0-9]*)
      seconds="$(date +%s 2>/dev/null)" || return 1
      printf '%s' "$((seconds * 1000))"
      return 0
      ;;
  esac
  printf '%s' "$((ns / 1000000))"
}

write_repo_prep_timing() {
  # $1 = clone|fetch, $2 = duration ms (integer)
  {
    mkdir -p "$(dirname "${REPO_PREP_TIMINGS_PATH}")" || return 0
    cat >"${REPO_PREP_TIMINGS_PATH}" <<EOF
repo_prep_path=$1
repo_prep_ms=$2
EOF
  } || true
}

write_setup_timing() {
  # $1 = kind label (fixed vocabulary, never untrusted), $2 = duration ms (int)
  {
    mkdir -p "$(dirname "${SETUP_TIMINGS_PATH}")" || return 0
    cat >"${SETUP_TIMINGS_PATH}" <<EOF
setup_kind=$1
setup_ms=$2
EOF
  } || true
}

TARGET_BRANCH="$(target_branch)"
# Best-effort: a now_ms failure leaves the var empty and skips the timing write
# below, but surface it in the log instead of silently swallowing it via `|| true`.
repo_prep_started_ms="$(now_ms)" || { repo_prep_started_ms=""; log_stage "repo_prep_timing_unavailable stage=start"; }
if [ -e "${REPO_PATH}/.git" ]; then
  log_stage "repo_prepare_existing_start branch=${TARGET_BRANCH:-}"
  prepare_existing_repo "${TARGET_BRANCH}"
  repo_prep_path="fetch"
else
  log_stage "repo_clone_start branch=${TARGET_BRANCH:-}"
  clone_repo "${TARGET_BRANCH}"
  repo_prep_path="clone"
fi
repo_prep_ended_ms="$(now_ms)" || { repo_prep_ended_ms=""; log_stage "repo_prep_timing_unavailable stage=end"; }
if [ -n "${repo_prep_started_ms:-}" ] && [ -n "${repo_prep_ended_ms:-}" ]; then
  write_repo_prep_timing "${repo_prep_path}" "$((repo_prep_ended_ms - repo_prep_started_ms))"
  log_stage "repo_prep_timing path=${repo_prep_path} ms=$((repo_prep_ended_ms - repo_prep_started_ms))"
fi

assert_repo_checkout_ready
log_stage "repo_ready path=${REPO_PATH}"
cd "${REPO_PATH}"

mark_workspace_setup_pending() {
  mkdir -p "$(dirname "${WORKSPACE_SETUP_PENDING_PATH}")" "$(dirname "${WORKSPACE_SETUP_READY_PATH}")"
  rm -f "${WORKSPACE_SETUP_READY_PATH}" "${WORKSPACE_SETUP_FAILED_PATH}"
  date +%s >"${WORKSPACE_SETUP_PENDING_PATH}"
}

mark_workspace_setup_ready() {
  rm -f "${WORKSPACE_SETUP_PENDING_PATH}"
  mkdir -p "$(dirname "${WORKSPACE_SETUP_READY_PATH}")"
  date +%s >"${WORKSPACE_SETUP_READY_PATH}"
}

# Failure marker: the pending/ready pair alone cannot distinguish "setup ran and
# failed" from "setup succeeded" (the bridge only observes pending+ready). When a
# repo-owned setup script exits non-zero or times out we still mark ready (the
# agent should keep working), but we also write this marker so the bridge's
# WorkspaceSetupTracker can surface the failure to the UI/transcript.
mark_workspace_setup_failed() {
  mkdir -p "$(dirname "${WORKSPACE_SETUP_FAILED_PATH}")"
  date +%s >"${WORKSPACE_SETUP_FAILED_PATH}"
}

mark_cycloid_cli_auth_pending() {
  mkdir -p "$(dirname "${CLI_AUTH_PENDING_PATH}")" "$(dirname "${CLI_AUTH_READY_PATH}")" "$(dirname "${CLI_AUTH_FAILED_PATH}")"
  rm -f "${CLI_AUTH_READY_PATH}" "${CLI_AUTH_FAILED_PATH}"
  date +%s >"${CLI_AUTH_PENDING_PATH}"
}

mark_cycloid_cli_auth_ready() {
  rm -f "${CLI_AUTH_PENDING_PATH}" "${CLI_AUTH_FAILED_PATH}"
  mkdir -p "$(dirname "${CLI_AUTH_READY_PATH}")"
  date +%s >"${CLI_AUTH_READY_PATH}"
}

mark_cycloid_cli_auth_failed() {
  rm -f "${CLI_AUTH_PENDING_PATH}" "${CLI_AUTH_READY_PATH}"
  mkdir -p "$(dirname "${CLI_AUTH_FAILED_PATH}")"
  date +%s >"${CLI_AUTH_FAILED_PATH}"
}

# Repo-owned setup script: if the checked-out repo ships `.cycloid/setup.sh`, the
# repo owns workspace setup end-to-end and we run it instead of the npm/pnpm/yarn
# auto-detection below. Returns 1 (no script) so the caller falls back to
# install_repo_deps_background. The script runs on every cold start (including
# cold-resumed sessions) and must be idempotent.
#
# Hardcoded timeout, kept below the bridge's first-prompt wait
# (WORKSPACE_SETUP_WAIT_TIMEOUT_MS = 10min) so the script always resolves the
# pending/ready markers before the bridge gives up waiting.
SETUP_TIMEOUT_S=540

# Poll granularity for wait_for_workspace_setup_ready. Prod uses the 1s default;
# tests set ARCANIST_SETUP_READY_POLL_INTERVAL_S to a fractional value so the
# near-instant fake setup is observed without burning a whole second. A bad value
# (non-numeric or <=0) would make `sleep` fail under `set -euo pipefail` and crash
# the wait loop before it writes the ready/failed markers, so fall back to 1.
SETUP_READY_POLL_INTERVAL_S="${ARCANIST_SETUP_READY_POLL_INTERVAL_S:-1}"
if ! is_positive_number "${SETUP_READY_POLL_INTERVAL_S}"; then
  log_stage "setup_ready_poll reason=invalid_config interval_s=${SETUP_READY_POLL_INTERVAL_S}"
  SETUP_READY_POLL_INTERVAL_S=1
fi

run_repo_setup_script_background() {
  local script="${REPO_PATH}/.cycloid/setup.sh"
  [ -f "${script}" ] || return 1
  mark_workspace_setup_pending
  workspace_setup_running="1"
  (
    set +e
    # log_stage (not plain echo) so the setup-script audit trail lands in the
    # persistent start-bridge log, matching the error events below.
    log_stage "repo_setup_start event=repo_setup_start"
    # `bash <script>` does NOT give the child set -euo pipefail; failure detection
    # relies on the script's final exit code, so customer scripts must propagate
    # failures (documented contract). `-k` forces SIGKILL if the script ignores
    # SIGTERM. UNTRUSTED_REPO_ENV_SCRUB is the shared scrub list for both
    # repo-controlled setup and dependency installation; GITHUB_CLONE_TOKEN stays
    # so private dependency installs still work.
    setup_started_ms="$(now_ms)" || setup_started_ms=""
    timeout -k 10s "${SETUP_TIMEOUT_S}" \
      env "${UNTRUSTED_REPO_ENV_SCRUB_ARGS[@]}" \
      bash "${script}"
    status=$?
    # Record actual setup wall time (all outcomes, including timeout) before the
    # ready marker so the bridge sees the timing when it observes completion.
    setup_ended_ms="$(now_ms)" || setup_ended_ms=""
    if [ -n "${setup_started_ms}" ] && [ -n "${setup_ended_ms}" ]; then
      setup_elapsed_ms=$((setup_ended_ms - setup_started_ms))
      write_setup_timing "repo_setup_script" "${setup_elapsed_ms}"
      log_stage "workspace_setup_timing setup_kind=repo_setup_script setup_ms=${setup_elapsed_ms}"
    fi
    # timeout exits 124 when SIGTERM kills the script, or 137 (128+SIGKILL) when
    # the `-k` grace period fires; treat both as a timeout.
    if [ "${status}" -eq 0 ]; then
      log_stage "repo_setup_complete event=repo_setup_complete"
    elif [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
      log_error "[start-bridge] repo_setup_timeout event=repo_setup_timeout timeout_s=${SETUP_TIMEOUT_S} exit_code=${status}"
      mark_workspace_setup_failed
    else
      log_error "[start-bridge] repo_setup_failed event=repo_setup_failed exit_code=${status}"
      mark_workspace_setup_failed
    fi
    mark_workspace_setup_ready
  ) &
}

# sha256 of a lockfile, portable across the sandbox image (sha256sum) and macOS
# dev/test runs (shasum). Empty output (no tool / unreadable file) tells callers
# "cannot judge drift" — they must fall back to today's reuse behavior, never block.
lockfile_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  fi
}

install_repo_deps_background() {
  local package_manager=""
  local install_log_label=""
  local install_command=()
  local lockfile_path=""

  if [ -f "${REPO_PATH}/package-lock.json" ]; then
    package_manager="npm"
    install_log_label="npm.ci"
    install_command=(npm ci)
    lockfile_path="${REPO_PATH}/package-lock.json"
  elif [ -f "${REPO_PATH}/pnpm-lock.yaml" ]; then
    package_manager="pnpm"
    install_log_label="pnpm.install"
    install_command=(pnpm install --frozen-lockfile)
    lockfile_path="${REPO_PATH}/pnpm-lock.yaml"
  elif [ -f "${REPO_PATH}/yarn.lock" ]; then
    package_manager="yarn"
    install_log_label="yarn.install"
    if [ -f "${REPO_PATH}/.yarnrc.yml" ]; then
      install_command=(yarn install --immutable)
    else
      install_command=(yarn install --frozen-lockfile)
    fi
    lockfile_path="${REPO_PATH}/yarn.lock"
  else
    return 0
  fi
  local install_reason="fresh_clone_background"
  local lockfile_hash_marker="${REPO_PATH}/node_modules/.cycloid-lockfile-hash"
  if [ -d "${REPO_PATH}/node_modules" ]; then
    # Prebaked images (per-repo snapshots) bake node_modules plus a lockfile-hash
    # marker (written by scripts/freestyle-build-repo-snapshot.mjs). Reuse only
    # while the lockfile still hashes to the marker; on drift the baked deps are
    # stale and a real install runs. No marker (pre-marker images, organically
    # grown node_modules) or no hash tool = cannot judge drift: keep today's
    # reuse behavior rather than pay an install on every boot.
    local baked_lockfile_hash=""
    if [ -f "${lockfile_hash_marker}" ]; then
      baked_lockfile_hash="$(tr -d '[:space:]' <"${lockfile_hash_marker}" 2>/dev/null)" || baked_lockfile_hash=""
    fi
    local current_lockfile_hash=""
    current_lockfile_hash="$(lockfile_hash "${lockfile_path}")" || current_lockfile_hash=""
    if [ -z "${baked_lockfile_hash}" ] || [ -z "${current_lockfile_hash}" ] ||
      [ "${baked_lockfile_hash}" = "${current_lockfile_hash}" ]; then
      echo "[start-bridge] ${install_log_label}_skip reason=existing_node_modules"
      # Existing-deps reuse: deps already present, so the install phase is effectively zero.
      # Recording it (rather than omitting) makes reuse-vs-fresh install attributable.
      write_setup_timing "${package_manager}_skip_existing" 0
      log_stage "workspace_setup_timing setup_kind=${package_manager}_skip_existing setup_ms=0"
      mark_workspace_setup_ready
      return
    fi
    install_reason="lockfile_drift"
    if [ "${package_manager}" = "npm" ]; then
      # npm ci DELETES node_modules before installing, so a failed reinstall would
      # leave the workspace with no deps at all — strictly worse than the stale
      # baked deps it replaced. npm install converges node_modules to the lockfile
      # in place (pnpm/yarn frozen installs are already incremental), so a failure
      # keeps the old deps usable while the failed marker surfaces the problem.
      install_log_label="npm.install"
      install_command=(npm install)
    fi
    echo "[start-bridge] ${install_log_label}_stale reason=lockfile_drift"
    log_stage "workspace_setup_lockfile_drift package_manager=${package_manager}"
  fi

  mark_workspace_setup_pending
  workspace_setup_running="1"
  (
    set +e
    echo "[start-bridge] ${install_log_label}_start reason=${install_reason}"
    install_started_ms="$(now_ms)" || install_started_ms=""
    # Keep this call site coupled to UNTRUSTED_REPO_ENV_SCRUB above.
    env "${UNTRUSTED_REPO_ENV_SCRUB_ARGS[@]}" "${install_command[@]}"
    status=$?
    install_ended_ms="$(now_ms)" || install_ended_ms=""
    if [ -n "${install_started_ms}" ] && [ -n "${install_ended_ms}" ]; then
      install_elapsed_ms=$((install_ended_ms - install_started_ms))
      write_setup_timing "${package_manager}" "${install_elapsed_ms}"
      log_stage "workspace_setup_timing setup_kind=${package_manager} setup_ms=${install_elapsed_ms}"
    fi
    if [ "${status}" -eq 0 ] && [ "${install_reason}" = "lockfile_drift" ] && [ "${package_manager}" = "npm" ]; then
      # npm install (unlike the frozen npm ci) REWRITES package-lock.json when it
      # disagrees with package.json — the broken state npm ci would surface via the
      # failed marker. Setup must never dirty the checkout or refresh the marker to
      # an uncommitted lockfile the agent would then publish: restore the lockfile
      # and report failure instead. diff rc 1 = modified; rc >1 (git error) = cannot
      # tell, keep the success path.
      git -C "${REPO_PATH}" diff --quiet -- package-lock.json 2>/dev/null
      lockfile_diff_rc=$?
      if [ "${lockfile_diff_rc}" -eq 1 ]; then
        log_error "[start-bridge] ${install_log_label}_lockfile_rewritten reason=package_json_lockfile_mismatch"
        git -C "${REPO_PATH}" checkout -- package-lock.json 2>/dev/null || true
        status=1
      fi
    fi
    if [ "${status}" -eq 0 ]; then
      # Refresh the marker so the next boot of this filesystem (cold resume, or a
      # snapshot derived from it) can judge drift against the just-installed state.
      if [ -d "${REPO_PATH}/node_modules" ]; then
        installed_lockfile_hash="$(lockfile_hash "${lockfile_path}")" || installed_lockfile_hash=""
        if [ -n "${installed_lockfile_hash}" ]; then
          printf '%s\n' "${installed_lockfile_hash}" >"${lockfile_hash_marker}" 2>/dev/null || true
        fi
      fi
      echo "[start-bridge] ${install_log_label}_complete reason=${install_reason}"
    else
      log_error "[start-bridge] ${install_log_label}_failed reason=${install_reason} package_manager=${package_manager} exit_code=${status}"
      # Same contract as the setup-script path: ready unblocks the agent, the
      # failed marker lets WorkspaceSetupTracker surface "deps did not install"
      # instead of reporting a ready workspace with no node_modules.
      mark_workspace_setup_failed
    fi
    mark_workspace_setup_ready
  ) &
}

json_escape_string() {
  local value="$1"
  local char replacement code
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  for code in {1..31} 127; do
    printf -v char "\\$(printf '%03o' "${code}")"
    printf -v replacement '\\u%04x' "${code}"
    value="${value//${char}/${replacement}}"
  done
  printf '%s' "${value}"
}

persist_cycloid_cli_config() {
  local api_url="$1"
  local token="$2"
  local config_dir="${HOME:-/home/user}/.cycloid"
  local config_file="${config_dir}/config.json"
  local escaped_api_url escaped_token
  local temp_config

  if ! mkdir -p "${config_dir}"; then
    log_error "[start-bridge] cycloid_cli_auth_failure reason=config_write_failed event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi
  chmod 0700 "${config_dir}" || true
  if ! temp_config="$(mktemp "${config_dir}/config.json.XXXXXX")"; then
    log_error "[start-bridge] cycloid_cli_auth_failure reason=config_write_failed event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi
  chmod 0600 "${temp_config}" || true

  escaped_api_url="$(json_escape_string "${api_url}")"
  escaped_token="$(json_escape_string "${token}")"
  if ! printf '{\n  "apiUrl": "%s",\n  "token": "%s"\n}\n' "${escaped_api_url}" "${escaped_token}" >"${temp_config}"; then
    rm -f "${temp_config}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=config_write_failed event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi
  unset escaped_api_url
  unset escaped_token

  if ! mv "${temp_config}" "${config_file}"; then
    rm -f "${temp_config}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=config_write_failed event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi
  chmod 0600 "${config_file}" || true
  return 0
}

wait_for_workspace_setup_ready() {
  local deadline
  deadline=$(($(date +%s) + SETUP_TIMEOUT_S + 30))
  while [ ! -f "${WORKSPACE_SETUP_READY_PATH}" ]; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      log_error "[start-bridge] repo_setup_wait_timeout event=repo_setup_wait_timeout timeout_s=$((SETUP_TIMEOUT_S + 30))"
      mark_workspace_setup_failed
      mark_workspace_setup_ready
      break
    fi
    sleep "${SETUP_READY_POLL_INTERVAL_S}"
  done
}

bootstrap_cycloid_cli_auth() {
  if [ -n "${ARCANIST_TOKEN:-}" ]; then
    export ARCANIST_API_URL="${ARCANIST_API_URL:-${CONTROL_PLANE_URL}}"
    if ! persist_cycloid_cli_config "${ARCANIST_API_URL}" "${ARCANIST_TOKEN}"; then
      return 1
    fi
    log_stage "cycloid_cli_auth_ready reason=existing"
    return 0
  fi
  if ! command -v cycloid >/dev/null 2>&1; then
    log_stage "cycloid_cli_auth_skip reason=cli_missing"
    return 0
  fi
  local response_path token_url token_status http_status token
  response_path="$(mktemp)"
  token_url="${CONTROL_PLANE_URL%/}/api/sessions/${SESSION_ID}/cli-auth-token"
  token_status=0
  http_status="$(curl -sS --connect-timeout 5 --max-time 15 \
    -H "Authorization: Bearer ${SANDBOX_AUTH_TOKEN}" \
    -H "Accept: application/json" \
    -o "${response_path}" \
    -w "%{http_code}" \
    "${token_url}")" || token_status=$?

  if [ "${token_status}" -ne 0 ] || [ -z "${http_status}" ]; then
    rm -f "${response_path}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=token_request_failed event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi

  if [ "${http_status}" = "403" ]; then
    rm -f "${response_path}"
    log_stage "cycloid_cli_auth_skip reason=disabled"
    return 0
  fi

  if [ "${http_status}" -lt 200 ] || [ "${http_status}" -ge 300 ]; then
    rm -f "${response_path}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=token_request_failed status=${http_status} event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    rm -f "${response_path}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=jq_missing event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi

  if ! token="$(jq -er 'select(.ok == true) | .token | select(type == "string" and length > 0)' "${response_path}")"; then
    rm -f "${response_path}"
    log_error "[start-bridge] cycloid_cli_auth_failure reason=invalid_token_response event=cycloid_cli_auth_failure session_id=${SESSION_ID}"
    return 1
  fi
  rm -f "${response_path}"

  export ARCANIST_API_URL="${ARCANIST_API_URL:-${CONTROL_PLANE_URL}}"
  export ARCANIST_TOKEN="${token}"
  if ! persist_cycloid_cli_config "${ARCANIST_API_URL}" "${ARCANIST_TOKEN}"; then
    unset token
    return 1
  fi
  unset token
  log_stage "cycloid_cli_auth_ready reason=minted"
  return 0
}

run_cycloid_cli_auth_bootstrap() {
  mark_cycloid_cli_auth_pending
  if bootstrap_cycloid_cli_auth; then
    mark_cycloid_cli_auth_ready
    return 0
  fi
  mark_cycloid_cli_auth_failed
  return 1
}

# Repo-owned setup scripts can run for minutes. Start the bridge immediately so
# WS connect, runtime warmup, and memory loading overlap that work, but keep the
# CLI auth config off disk until the setup markers say the untrusted script has
# finished. The subshell inherits the current env, so preexisting ARCANIST_TOKEN
# still works when already present; this path only defers the mint/persist step.
bootstrap_cycloid_cli_auth_after_workspace_setup_background() {
  log_stage "cycloid_cli_auth_deferred reason=repo_setup_pending"
  mark_cycloid_cli_auth_pending
  (
    wait_for_workspace_setup_ready
    if bootstrap_cycloid_cli_auth; then
      mark_cycloid_cli_auth_ready
    else
      mark_cycloid_cli_auth_failed
    fi
  ) &
}

# Auth bootstrap is per coding-agent backend. The backend is selected by the
# control plane via ARCANIST_AGENT_RUNTIME_BACKEND (independent of the sandbox
# provider). Both CLIs are installed in the shared image; only the selected one is
# authenticated here, and start-bridge fails closed when its credential is absent.
bootstrap_agent_runtime_auth() {
  AGENT_RUNTIME_BACKEND="${ARCANIST_AGENT_RUNTIME_BACKEND:-codex}"
  if [ "${AGENT_RUNTIME_BACKEND}" = "claude_code" ]; then
    # Claude Code authenticates from ANTHROPIC_API_KEY directly (no on-disk auth.json).
    # Accept the platform/internal key alias as a fallback.
    claude_api_key="${ANTHROPIC_API_KEY:-${ARCANIST_ANTHROPIC_API_KEY:-}}"
    if [ -z "${claude_api_key}" ]; then
      log_error "[start-bridge] sandbox_auth_failure reason=no_anthropic_key event=sandbox_auth_failure session_id=${SESSION_ID}"
      exit 1
    fi
    export ANTHROPIC_API_KEY="${claude_api_key}"
    unset claude_api_key
    log_stage "claude_auth_ready backend=claude_code"
  elif [ "${AGENT_RUNTIME_BACKEND}" = "opencode" ]; then
    baseten_api_key="${BASETEN_API_KEY:-}"
    if [ -z "${baseten_api_key}" ]; then
      log_error "[start-bridge] sandbox_auth_failure reason=no_baseten_key event=sandbox_auth_failure session_id=${SESSION_ID}"
      exit 1
    fi
    export BASETEN_API_KEY="${baseten_api_key}"
    unset baseten_api_key
    log_stage "opencode_auth_ready backend=opencode"
  else
    export CODEX_HOME="${CODEX_HOME:-/tmp/codex-home-${SESSION_ID}}"
    export CODEX_NO_LOGIN=1
    mkdir -p "${CODEX_HOME}"
    if [ -n "${ARCANIST_CODEX_AUTH_JSON:-}" ]; then
      log_stage "codex_auth_deferred source=session_auth_json"
    elif [ -n "${CODEX_API_KEY:-${OPENAI_API_KEY:-}}" ]; then
      log_stage "codex_auth_deferred source=session_api_key"
    elif [ -f "${CODEX_HOME}/auth.json" ]; then
      log_stage "codex_auth_deferred source=stored_auth"
    else
      log_error "[start-bridge] sandbox_auth_failure reason=openai_credential_missing event=sandbox_auth_failure session_id=${SESSION_ID}"
      exit 1
    fi
  fi
}
# Clear any failure marker left in /tmp by a prior boot before choosing a setup
# path. The marker is otherwise only reset inside mark_workspace_setup_pending,
# so the existing-node_modules skip and no-lockfile paths (which never mark
# pending) could leave a stale marker that makes the bridge report
# workspace_setup_failed on a reused sandbox or cold resume.
rm -f "${WORKSPACE_SETUP_FAILED_PATH}"
# A repo-owned .cycloid/setup.sh, when present, replaces the npm/pnpm/yarn
# auto-detection; otherwise fall back to it. Egress enforcement above is
# synchronous, so the background setup script cannot bypass the policy.
repo_owned_setup_running="0"
workspace_setup_running="0"
if run_repo_setup_script_background; then
  repo_owned_setup_running="1"
else
  install_repo_deps_background
fi
bootstrap_agent_runtime_auth
if [ "${workspace_setup_running}" = "1" ]; then
  bootstrap_cycloid_cli_auth_after_workspace_setup_background
else
  run_cycloid_cli_auth_bootstrap || exit 1
fi

unset ARCANIST_BASETEN_API_KEY
log_stage "bridge_exec bundle=${BRIDGE_BUNDLE}"
node "${BRIDGE_BUNDLE}"
