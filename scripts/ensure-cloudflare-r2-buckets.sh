#!/usr/bin/env bash
set -euo pipefail

# Idempotent ensure-step for R2 buckets, mirroring ensure-cloudflare-queues.sh.
# Creating an existing bucket is treated as success so the deploy stays green.

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <bucket-name> [bucket-name ...]" >&2
  exit 64
fi

for bucket_name in "$@"; do
  output_file="$(mktemp)"
  if npx wrangler r2 bucket create "$bucket_name" >"$output_file" 2>&1; then
    cat "$output_file"
    rm -f "$output_file"
    continue
  else
    status=$?
    if grep -Eiq "\"?code\"?:?[[:space:]]*10004|already exists|already owned|bucket .* exists|name .* is already taken" "$output_file"; then
      cat "$output_file"
      echo "Cloudflare R2 bucket already exists: $bucket_name"
      rm -f "$output_file"
      continue
    fi

    cat "$output_file" >&2
    rm -f "$output_file"
    echo "::error::Failed to ensure Cloudflare R2 bucket exists: $bucket_name" >&2
    exit "$status"
  fi
done
