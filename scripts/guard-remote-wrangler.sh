#!/usr/bin/env bash
set -euo pipefail

# Mistake net for local shell hooks that can inspect the top-level Bash command.
# This is not a security boundary: subprocesses such as `node scripts/x.mjs`
# invoking wrangler internally are outside the hook's visibility.

OVERRIDE_ENV="ARCANIST_ALLOW_REMOTE_WRANGLER"

usage() {
  cat <<'EOF'
Usage:
  scripts/guard-remote-wrangler.sh --check "<command>"
  scripts/guard-remote-wrangler.sh --claude-pretool
  scripts/guard-remote-wrangler.sh --self-test
EOF
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

emit_block_json() {
  local reason="$1"
  printf '{"decision":"block","reason":"%s"}\n' "$(json_escape "$reason")"
}

is_override_enabled() {
  [ "${!OVERRIDE_ENV:-}" = "1" ]
}

has_remote_flag() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:]])--remote([[:space:]]|=true|$) ]]
}

has_dry_run_flag() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:]])--dry-run([[:space:]]|=true|$) ]]
}

targets_qa_d1() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:]])(npx[[:space:]]+)?wrangler[[:space:]]+d1[[:space:]]+(execute|migrations[[:space:]]+apply|time-travel[[:space:]]+restore)[[:space:]]+cycloid-control-plane-qa([[:space:]]|$) ]]
}

has_chained_wrangler_invocation() {
  local command="$1"
  [[ "$command" =~ [\;\|\&][[:space:]]*(npx[[:space:]]+)?wrangler[[:space:]] ]]
}

has_wrangler_d1_execute() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+d1[[:space:]]+execute([[:space:]]|$) ]]
}

has_wrangler_d1_migrations_apply() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+d1[[:space:]]+migrations[[:space:]]+apply([[:space:]]|$) ]]
}

has_wrangler_d1_time_travel_restore() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+d1[[:space:]]+time-travel[[:space:]]+restore([[:space:]]|$) ]]
}

has_wrangler_deploy() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+deploy([[:space:]]|$) ]]
}

has_wrangler_versions_deploy() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+versions[[:space:]]+deploy([[:space:]]|$) ]]
}

has_wrangler_secret() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+secret([[:space:]]|$) ]]
}

has_wrangler_rollback() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+rollback([[:space:]]|$) ]]
}

has_wrangler_kv_remote() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:];|&])(npx[[:space:]]+)?wrangler[[:space:]]+kv([[:space:]]|$) ]] && has_remote_flag "$command"
}

has_file_flag() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:]])--file([[:space:]=]|$) ]]
}

has_command_flag() {
  local command="$1"
  [[ "$command" =~ (^|[[:space:]])--command([[:space:]=]|$) ]]
}

has_read_only_select_command() {
  local command="$1"
  local sql=""

  if [[ "$command" =~ --command=(.*)$ ]]; then
    sql="${BASH_REMATCH[1]}"
  elif [[ "$command" =~ --command[[:space:]]+(.*)$ ]]; then
    sql="${BASH_REMATCH[1]}"
  else
    return 1
  fi

  sql="${sql#\'}"
  sql="${sql%\'}"
  sql="${sql#\"}"
  sql="${sql%\"}"

  local upper
  upper=$(printf '%s' "$sql" | tr '[:lower:]' '[:upper:]')

  [[ "$upper" =~ ^[[:space:]]*SELECT[[:space:]] ]] || return 1
  [[ "$upper" != *";"* ]] || return 1
  [[ ! "$upper" =~ (^|[^A-Z])(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)([^A-Z]|$) ]] || return 1
}

deny_reason() {
  local command="$1"

  if is_override_enabled; then
    echo "::warning::${OVERRIDE_ENV}=1 bypassed remote wrangler guard for: ${command}" >&2
    return 1
  fi

  if has_wrangler_d1_execute "$command" && has_remote_flag "$command" && ! targets_qa_d1 "$command"; then
    if has_chained_wrangler_invocation "$command"; then
      printf 'Blocked chained remote D1 execution outside QA. Run a single inspected command at a time.'
      return 0
    fi
    if has_file_flag "$command"; then
      printf 'Blocked remote D1 file execution outside QA. Write a forward migration and let deploy apply it; see docs/database.md.'
      return 0
    fi
    if has_command_flag "$command" && ! has_read_only_select_command "$command"; then
      printf 'Blocked remote D1 command execution outside QA. Only a single read-only SELECT statement is allowed locally; write a forward migration for mutations.'
      return 0
    fi
  fi

  if has_wrangler_d1_migrations_apply "$command" && has_remote_flag "$command" && ! targets_qa_d1 "$command"; then
    printf 'Blocked remote D1 migrations apply outside QA. Production migrations must run through deploy.'
    return 0
  fi

  if has_wrangler_d1_time_travel_restore "$command" && ! targets_qa_d1 "$command"; then
    printf 'Blocked D1 time-travel restore outside QA. Recovery operations need deliberate human change management.'
    return 0
  fi

  if has_wrangler_deploy "$command" && ! has_dry_run_flag "$command"; then
    printf 'Blocked local wrangler deploy. Use CI deploys; set %s=1 only for a deliberate human override.' "$OVERRIDE_ENV"
    return 0
  fi

  if has_wrangler_versions_deploy "$command"; then
    printf 'Blocked local wrangler versions deploy. Use CI deploys; set %s=1 only for a deliberate human override.' "$OVERRIDE_ENV"
    return 0
  fi

  if has_wrangler_secret "$command"; then
    printf 'Blocked local wrangler secret mutation. Manage secrets through the documented deploy/rotation flow.'
    return 0
  fi

  if has_wrangler_rollback "$command"; then
    printf 'Blocked local wrangler rollback. Follow docs/rollback-runbook.md:24 for the deliberate human override path.'
    return 0
  fi

  if has_wrangler_kv_remote "$command"; then
    printf 'Blocked local remote KV mutation. Use CI or set %s=1 only for a deliberate human override.' "$OVERRIDE_ENV"
    return 0
  fi

  return 1
}

check_command() {
  local command="$1"
  local reason
  if reason=$(deny_reason "$command"); then
    printf '%s\n' "$reason" >&2
    return 1
  fi
  return 0
}

self_test_case() {
  local expected="$1"
  local command="$2"
  local status="allow"
  if ! check_command "$command" >/dev/null 2>&1; then
    status="deny"
  fi
  if [ "$status" != "$expected" ]; then
    echo "Expected ${expected}, got ${status}: ${command}" >&2
    return 1
  fi
}

self_test() {
  self_test_case allow "npx wrangler deploy --dry-run"
  self_test_case allow "wrangler d1 execute cycloid-control-plane-production --remote --command 'SELECT * FROM session_index LIMIT 1'"
  self_test_case allow "wrangler d1 execute cycloid-control-plane-qa --remote --file ./scratch.sql"
  self_test_case allow "wrangler d1 migrations apply cycloid-control-plane-qa --remote"
  self_test_case deny "wrangler d1 execute cycloid-control-plane-production --remote --command 'DELETE FROM session_index'"
  self_test_case deny "wrangler d1 execute cycloid-control-plane-production --remote --command 'SELECT 1; DELETE FROM session_index'"
  self_test_case deny "wrangler d1 execute cycloid-control-plane-production --remote --command 'SELECT 1'; wrangler d1 execute cycloid-control-plane-production --remote --command 'DELETE FROM session_index'"
  self_test_case deny "wrangler d1 execute cycloid-control-plane-production --remote --file ./cycloid-control-plane-qa-seed.sql"
  self_test_case deny "npx wrangler d1 execute cycloid-control-plane-production --remote=true --file ./danger.sql"
  self_test_case deny "wrangler d1 migrations apply cycloid-control-plane-production --remote"
  self_test_case deny "wrangler d1 time-travel restore cycloid-control-plane-production --bookmark abc"
  self_test_case deny "wrangler deploy"
  self_test_case deny "wrangler versions deploy abc"
  self_test_case deny "wrangler secret put API_KEY"
  self_test_case deny "wrangler rollback"
  self_test_case deny "wrangler kv key put foo bar --remote"
  echo "guard-remote-wrangler self-test passed."
}

case "${1:-}" in
  --check)
    shift
    check_command "$*"
    ;;
  --claude-pretool)
    input=$(cat)
    command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
    if reason=$(deny_reason "$command"); then
      emit_block_json "$reason"
    fi
    ;;
  --self-test)
    self_test
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
