#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <queue-name> [queue-name ...]" >&2
  exit 64
fi

for queue_name in "$@"; do
  output_file="$(mktemp)"
  if npx wrangler queues create "$queue_name" >"$output_file" 2>&1; then
    cat "$output_file"
    rm -f "$output_file"
    continue
  else
    status=$?
    if grep -Eiq "\"?code\"?:?[[:space:]]*11009|queue name '.*' is already taken|already exists|queue .* exists|queue.*already.*exist" "$output_file"; then
      cat "$output_file"
      echo "Cloudflare Queue already exists: $queue_name"
      rm -f "$output_file"
      continue
    fi

    cat "$output_file" >&2
    rm -f "$output_file"
    echo "::error::Failed to ensure Cloudflare Queue exists: $queue_name" >&2
    exit "$status"
  fi
done
