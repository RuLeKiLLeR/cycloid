#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/apps/control-plane-worker"
LOG_DIR="${ARCANIST_MIGRATION_LOG_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$LOG_DIR"
LOG_FILE="$(mktemp "${LOG_DIR%/}/cycloid-db-migrate-local.XXXXXX")"
OUTPUT_PREVIEW_BYTES="${ARCANIST_MIGRATION_OUTPUT_PREVIEW_BYTES:-40000}"
if ! [[ "$OUTPUT_PREVIEW_BYTES" =~ ^[0-9]+$ ]] || [ "$OUTPUT_PREVIEW_BYTES" -le 0 ]; then
  echo "Invalid ARCANIST_MIGRATION_OUTPUT_PREVIEW_BYTES='$OUTPUT_PREVIEW_BYTES'; defaulting to 40000." >&2
  OUTPUT_PREVIEW_BYTES=40000
fi

echo "Applying local D1 migrations..."
echo "Full wrangler output: $LOG_FILE"

set +e
(
  cd "$WORKER_DIR" &&
    npx wrangler d1 migrations apply cycloid-control-plane-production --local
) >"$LOG_FILE" 2>&1
status=$?
set -e

line_count=$(wc -l <"$LOG_FILE" | tr -d ' ')
byte_count=$(wc -c <"$LOG_FILE" | tr -d ' ')
if [ "$status" -eq 0 ]; then
  echo "Local D1 migrations completed."
else
  echo "Local D1 migrations failed with exit code $status."
fi

if [ "$byte_count" -gt "$OUTPUT_PREVIEW_BYTES" ]; then
  omitted=$((byte_count - OUTPUT_PREVIEW_BYTES))
  echo "Showing last $OUTPUT_PREVIEW_BYTES of $byte_count output bytes ($omitted bytes omitted; $line_count total lines):"
  tail -c "$OUTPUT_PREVIEW_BYTES" "$LOG_FILE"
else
  cat "$LOG_FILE"
  if [ "$status" -eq 0 ]; then
    rm -f "$LOG_FILE"
    echo "Removed full wrangler output after successful untruncated run."
  fi
fi

exit "$status"
