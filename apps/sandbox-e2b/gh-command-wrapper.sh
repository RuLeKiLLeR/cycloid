#!/usr/bin/env bash
set -euo pipefail

REAL_GH="${ARCANIST_REAL_GH_PATH:-/usr/local/lib/cycloid/real-bin/gh}"
PERMANENTLY_BLOCKED="This command is permanently blocked -- do not retry."
HANDLED_AUTOMATICALLY="is handled automatically by Cycloid after your work is complete. Do not run it directly."

deny() {
  printf 'Policy block: %s\n' "$1" >&2
  exit 126
}

has_web_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --web|-w)
        return 0
        ;;
    esac
  done
  return 1
}

args=("$@")
positionals=()
normalized_args=()
allowed=0
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    -R|--repo|--hostname)
      if [ "$arg" = "-R" ] || [ "$arg" = "--repo" ]; then normalized_args+=("--repo"); else normalized_args+=("$arg"); fi
      normalized_args+=("${args[$((i + 1))]}")
      i=$((i + 2))
      continue
      ;;
    --repo=*|--hostname=*)
      normalized_args+=("$arg")
      i=$((i + 1))
      continue
      ;;
    --title)
      normalized_args+=("--title" "${args[$((i + 1))]}")
      i=$((i + 2))
      continue
      ;;
    --)
      i=$((i + 1))
      while [ "$i" -lt "${#args[@]}" ]; do
        positionals+=("${args[$i]}")
        i=$((i + 1))
      done
      break
      ;;
    -*)
      normalized_args+=("$arg")
      i=$((i + 1))
      continue
      ;;
    *)
      positionals+=("$arg")
      normalized_args+=("$arg")
      i=$((i + 1))
      ;;
  esac
done

primary="${positionals[0]:-}"
secondary="${positionals[1]:-}"

if [ "$primary:$secondary" = "pr:close" ] || [ "$primary:$secondary" = "pr:reopen" ] || [ "$primary:$secondary" = "pr:edit" ]; then
  ACTION_AUTH_FILE="${ARCANIST_GITHUB_ACTION_AUTH_FILE:-/tmp/cycloid-github-action-auth-token}"
  if [ -z "${CONTROL_PLANE_URL:-}" ] || [ -z "${SESSION_ID:-}" ] || [ ! -r "$ACTION_AUTH_FILE" ]; then
    printf 'GitHub action unavailable: session capability is missing.\n' >&2
    exit 126
  fi
  payload="$(printf '%s\0' "${normalized_args[@]}" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify(s.split("\0").filter(Boolean))));')"
  base="$CONTROL_PLANE_URL"
  case "$base" in http://*|https://*) ;; *) base="https://$base" ;; esac
  response="$(curl -sS --connect-timeout 2 --max-time 5 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $(cat "$ACTION_AUTH_FILE")" --data "{\"argv\":$payload}" "$base/api/sessions/$SESSION_ID/github-action" 2>/dev/null || true)"
  if printf '%s' "$response" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { const j=JSON.parse(s); if (j && j.ok) { console.log(j.title || j.state || "ok"); process.exit(0); } } catch {} process.exit(1); });'; then exit 0; fi
  printf 'GitHub action failed: request was rejected or unavailable.\n' >&2
  exit 126
fi

case "$primary:$secondary" in
  pr:create)
    deny "PR creation ${HANDLED_AUTOMATICALLY}"
    ;;
  pr:merge)
    deny "PR management ${HANDLED_AUTOMATICALLY}"
    ;;
  issue:close|issue:reopen|issue:delete)
    deny "Issue management ${HANDLED_AUTOMATICALLY}"
    ;;
  pr:view|pr:list|pr:diff|pr:checks|repo:view|run:view|run:list|run:watch)
    if has_web_flag "$@"; then
      deny "Browser commands are not available in the sandbox. Output the URL as text instead. ${PERMANENTLY_BLOCKED}"
    fi
    allowed=1
    ;;
  browse:*)
    deny "Browser commands are not available in the sandbox. Output the URL as text instead. ${PERMANENTLY_BLOCKED}"
    ;;
  api:*)
    method=""
    implicit_post=0
    i=0
    while [ "$i" -lt "${#args[@]}" ]; do
      arg="${args[$i]}"
      case "$arg" in
        -f|-F|--field|--raw-field|--input)
          implicit_post=1
          i=$((i + 1))
          ;;
        -f*|-F*|--field=*|--raw-field=*|--input=*)
          implicit_post=1
          ;;
        -X|--method)
          if [ $((i + 1)) -lt "${#args[@]}" ]; then
            method="${args[$((i + 1))]}"
          fi
          ;;
        -X*|--method=*)
          method="${arg#-X}"
          method="${method#--method=}"
          ;;
      esac
      i=$((i + 1))
    done
    if [ "$secondary" = "graphql" ]; then
      implicit_post=1
    fi
    if [ -n "$method" ] && [ "$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')" != "GET" ]; then
      deny "Mutating GitHub API calls are not allowed. Use read-only gh commands instead. ${PERMANENTLY_BLOCKED}"
    fi
    if [ -z "$method" ] && [ "$implicit_post" -eq 1 ]; then
      deny "Mutating GitHub API calls are not allowed. Use read-only gh commands instead. ${PERMANENTLY_BLOCKED}"
    fi
    allowed=1
    ;;
esac

# Allow informational, subcommand-less invocations (`gh --version`, `gh --help`).
# These are read-only and are probed by ready-check.sh during template build;
# denying them makes the E2B ready command hang until timeout.
if [ "$allowed" -ne 1 ] && [ -z "$primary" ]; then
  for arg in "$@"; do
    case "$arg" in
      --version|-v|--help|-h) allowed=1 ;;
    esac
  done
fi

if [ "$allowed" -ne 1 ]; then
  deny "Unsupported gh command in the sandbox. Allowed commands are gh pr view/list/diff/checks, gh run view/list/watch, gh repo view, and gh api with GET. ${PERMANENTLY_BLOCKED}"
fi

if [ ! -x "$REAL_GH" ]; then
  printf 'Policy block: real gh binary is unavailable at %s\n' "$REAL_GH" >&2
  exit 127
fi

exec "$REAL_GH" "$@"
