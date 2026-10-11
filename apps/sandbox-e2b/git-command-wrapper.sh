#!/usr/bin/env bash
set -euo pipefail

REAL_GIT="${ARCANIST_REAL_GIT_PATH:-/usr/local/lib/cycloid/real-bin/git}"
PERMANENTLY_BLOCKED="This command is permanently blocked -- do not retry."
HANDLED_AUTOMATICALLY="is handled automatically by Cycloid after your work is complete. Do not run it directly."

deny() {
  printf 'Policy block: %s\n' "$1" >&2
  exit 126
}

is_read_only_config() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --get|--get-all|--get-regexp|--get-urlmatch|--show-origin|--show-scope|-l|--list)
        return 0
        ;;
    esac
  done
  return 1
}

has_arg() {
  local wanted="$1"
  shift
  local arg
  for arg in "$@"; do
    if [ "$arg" = "$wanted" ]; then
      return 0
    fi
  done
  return 1
}

has_core_hooks_path_env() {
  local key value
  while IFS= read -r key; do
    case "$key" in
      GIT_CONFIG_KEY_[0-9]*)
        value="${!key-}"
        if printf '%s' "$value" | grep -Eiq '^core\.hooksPath$'; then
          return 0
        fi
        ;;
    esac
  done < <(compgen -e)
  return 1
}

if has_core_hooks_path_env; then
  deny "Setting core.hooksPath via GIT_CONFIG_* environment variables is blocked. ${PERMANENTLY_BLOCKED}"
fi

args=("$@")
subcommand=""
subcommand_index=-1
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    -c)
      if [ $((i + 1)) -lt "${#args[@]}" ]; then
        config_arg="${args[$((i + 1))]}"
        if printf '%s' "$config_arg" | grep -Eiq '^core\.hooksPath(=|$)'; then
          deny "git -c core.hooksPath is blocked. ${PERMANENTLY_BLOCKED}"
        fi
        i=$((i + 2))
        continue
      fi
      ;;
    -ccore.hooksPath|-ccore.hooksPath=*)
      deny "git -c core.hooksPath is blocked. ${PERMANENTLY_BLOCKED}"
      ;;
    --config)
      if [ $((i + 1)) -lt "${#args[@]}" ]; then
        config_arg="${args[$((i + 1))]}"
        if printf '%s' "$config_arg" | grep -Eiq '^core\.hooksPath(=|$)'; then
          deny "git --config core.hooksPath is blocked. ${PERMANENTLY_BLOCKED}"
        fi
        i=$((i + 2))
        continue
      fi
      ;;
    --config=*)
      config_arg="${arg#--config=}"
      if printf '%s' "$config_arg" | grep -Eiq '^core\.hooksPath(=|$)'; then
        deny "git --config core.hooksPath is blocked. ${PERMANENTLY_BLOCKED}"
      fi
      ;;
    -C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)
      i=$((i + 2))
      continue
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--exec-path=*|--super-prefix=*)
      i=$((i + 1))
      continue
      ;;
    --)
      i=$((i + 1))
      break
      ;;
    -*)
      i=$((i + 1))
      continue
      ;;
    *)
      subcommand="$arg"
      subcommand_index="$i"
      break
      ;;
  esac
done

remaining=()
if [ "$subcommand_index" -ge 0 ]; then
  remaining=("${args[@]:$((subcommand_index + 1))}")
fi

case "$subcommand" in
  push)
    deny "git push ${HANDLED_AUTOMATICALLY}"
    ;;
  commit)
    if has_arg "--no-verify" "${remaining[@]}" || has_arg "-n" "${remaining[@]}"; then
      deny "git commit --no-verify is blocked. ${PERMANENTLY_BLOCKED}"
    fi
    ;;
  checkout)
    if has_arg "-b" "${remaining[@]}" || has_arg "-B" "${remaining[@]}"; then
      deny "Branch creation ${HANDLED_AUTOMATICALLY}"
    fi
    ;;
  switch)
    if has_arg "-c" "${remaining[@]}" || has_arg "-C" "${remaining[@]}" || has_arg "--create" "${remaining[@]}"; then
      deny "Branch creation ${HANDLED_AUTOMATICALLY}"
    fi
    ;;
  rebase)
    if has_arg "-i" "${remaining[@]}" || has_arg "--interactive" "${remaining[@]}"; then
      deny "git rebase --interactive is blocked. ${PERMANENTLY_BLOCKED}"
    fi
    ;;
  worktree)
    worktree_verb=""
    for arg in "${remaining[@]}"; do
      case "$arg" in
        -*) ;;
        *)
          worktree_verb="$arg"
          break
          ;;
      esac
    done
    case "$worktree_verb" in
      add|remove|move|prune|lock|unlock|repair)
        deny "git worktree ${HANDLED_AUTOMATICALLY}"
        ;;
    esac
    ;;
  config)
    touches_hooks_path=0
    for arg in "${remaining[@]}"; do
      if printf '%s' "$arg" | grep -Eiq '^core\.hooksPath$'; then
        touches_hooks_path=1
      fi
    done
    if [ "$touches_hooks_path" -eq 1 ] && ! is_read_only_config "${remaining[@]}"; then
      deny "git config core.hooksPath is blocked. ${PERMANENTLY_BLOCKED}"
    fi
    ;;
esac

if [ ! -x "$REAL_GIT" ]; then
  printf 'Policy block: real git binary is unavailable at %s\n' "$REAL_GIT" >&2
  exit 127
fi

exec "$REAL_GIT" "$@"
