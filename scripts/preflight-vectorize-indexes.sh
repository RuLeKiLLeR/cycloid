#!/usr/bin/env bash
set -euo pipefail

# Verify every Vectorize index bound in wrangler.toml for the target
# environment already exists in the Cloudflare account.
#
# Vectorize indexes are not created by the deploy workflows or by Terraform;
# they are provisioned once via the `wrangler vectorize create` commands
# documented in apps/control-plane-worker/wrangler.toml. When a bound index is
# missing, `wrangler deploy` fails deep in the worker publish step with an
# opaque Cloudflare API error (code 10159: "index ... not found"). Running this
# before the mutating deploy steps turns that into a fast, actionable failure.
#
# Usage: preflight-vectorize-indexes.sh <wrangler.toml> [env]
#   env omitted / "" -> top-level [[vectorize]] blocks (production)
#   env "qa"          -> [[env.qa.vectorize]] blocks

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <wrangler.toml> [env]" >&2
  exit 64
fi

toml="$1"
env_name="${2-}"

if [ ! -f "$toml" ]; then
  echo "::error::wrangler.toml not found at '$toml'" >&2
  exit 1
fi

if [ -n "$env_name" ]; then
  target_header="[[env.${env_name}.vectorize]]"
else
  target_header="[[vectorize]]"
fi

# Collect index_name values inside the target env's vectorize array-of-tables.
# Mirrors the inline TOML section scan already used by the "Assert QA worker
# name" deploy step: toggle on at the exact header, toggle off at the next
# top-level table header.
index_names="$(awk -v target="$target_header" '
  /^[[:space:]]*\[/ {
    h = $0
    gsub(/[[:space:]]/, "", h)
    in_block = (h == target)
    next
  }
  in_block && /^[[:space:]]*index_name[[:space:]]*=/ {
    line = $0
    sub(/^[^"]*"/, "", line)
    sub(/".*$/, "", line)
    print line
  }
' "$toml")"

if [ -z "$index_names" ]; then
  echo "No Vectorize bindings for env='${env_name:-production}' in $toml; nothing to preflight."
  exit 0
fi

missing=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  # Capture output instead of swallowing it. Only a definitive Vectorize
  # "index not found" response (vectorize.index.not_found / code 3000) blocks
  # the deploy. Any other non-zero exit -- auth/permission on the API token,
  # network, API 5xx, wrangler-version quirk -- is treated as non-blocking:
  # `wrangler deploy` still validates the binding server-side (code 10159), so
  # a preflight that cannot positively confirm a missing index must fail open
  # rather than wedge the whole deploy pipeline on a false negative.
  if out="$(npx wrangler vectorize get "$name" 2>&1)"; then
    echo "Vectorize index '$name' exists."
    continue
  fi
  if printf '%s' "$out" | grep -qiE 'vectorize\.index\.not_found|\[code: 3000\]'; then
    echo "::error::Vectorize index '$name' is bound in wrangler.toml but does not exist in the Cloudflare account."
    echo "::error::Provision it before deploying (see the setup commands in apps/control-plane-worker/wrangler.toml), e.g.:"
    echo "::error::  wrangler vectorize create $name --dimensions=1536 --metric=cosine"
    missing=1
  else
    echo "::warning::Could not verify Vectorize index '$name' (not a 'not found' response). Treating as non-blocking; the worker deploy still validates the binding. If this is a token-permission gap, grant the deploy token Vectorize (Read). Raw wrangler output:"
    printf '%s\n' "$out" >&2
  fi
done <<< "$index_names"

exit "$missing"
