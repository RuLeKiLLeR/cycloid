#!/usr/bin/env bash
set -euo pipefail

cd apps/control-plane-worker
npx wrangler dev --port "${API_PORT:-3000}"
