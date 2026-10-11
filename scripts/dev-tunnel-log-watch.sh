#!/usr/bin/env bash
set -euo pipefail

# Watches the ngrok agent log for agent-session loss/restoration and echoes
# operator-readable lines into the dev console. Used by scripts/dev-tunnel.sh.
#
# Usage:
#   dev-tunnel-log-watch.sh <logfile>   # follow the file (tail -F)
#   dev-tunnel-log-watch.sh             # read logfmt lines from stdin (tests)
#
# Match strings verified against ngrok 3.37.2 (binary strings + live logfmt
# output): agent session lines carry obj=tunnels.session with
# msg="session closed, starting reconnect loop" on loss and
# msg="client session established" on (re)connection. The same established
# message also logs once at clean startup, so restoration is only reported
# after a loss has been seen.

watch_ngrok_log_stream() {
  local lost=0 line
  while IFS= read -r line; do
    if [[ "$line" != *"obj=tunnels.session"* ]]; then
      continue
    fi
    if [[ "$line" == *"session closed, starting reconnect loop"* && $lost -eq 0 ]]; then
      echo "[tunnel] ngrok agent reconnecting -- expect session WS drops"
      lost=1
    elif [[ "$line" == *"client session established"* && $lost -eq 1 ]]; then
      echo "[tunnel] ngrok agent session restored"
      lost=0
    fi
  done
}

main() {
  local log_file="${1:-}"
  if [[ -z "$log_file" ]]; then
    watch_ngrok_log_stream
    return
  fi
  # Feed the follow through a FIFO instead of process substitution: procsub
  # children get an intermediate subshell parent (and an unreliable `$!` on
  # macOS bash 3.2), which makes the tail unkillable from here. A plain
  # background job's `$!` is dependable, so the trap can guarantee the tail
  # never outlives this watcher. TERM/INT route through exit so EXIT runs.
  local fifo_dir fifo
  fifo_dir=$(mktemp -d)
  fifo="$fifo_dir/ngrok-log.fifo"
  mkfifo "$fifo"
  tail -n 0 -F "$log_file" > "$fifo" 2>/dev/null &
  local tail_pid=$!
  trap 'exit 143' TERM INT
  trap 'kill "$tail_pid" 2>/dev/null || true; rm -rf "$fifo_dir"' EXIT
  watch_ngrok_log_stream < "$fifo"
}

main "$@"
