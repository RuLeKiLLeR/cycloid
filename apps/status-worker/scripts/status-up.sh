#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set." >&2
  echo "Use the least-privilege status KV operator token, not a broad personal token." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKER_DIR="$REPO_ROOT/apps/status-worker"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

echo "Cloudflare operator context:"
npx wrangler whoami

STATUS_STATE="up" STATUS_MESSAGE="" node --input-type=module - "$TMP_FILE" <<'NODE'
import { writeFileSync } from "node:fs";

const outputPath = process.argv[2];
const state = process.env.STATUS_STATE;
const message = process.env.STATUS_MESSAGE ?? "";

if (state !== "up" && state !== "down") {
  throw new Error(`Invalid state: ${state}`);
}

writeFileSync(
  outputPath,
  `${JSON.stringify({
    state,
    message,
    updatedAt: Date.now(),
  })}\n`,
);
NODE

npx wrangler kv key put current --binding=STATUS_FLAG --remote --cwd "$WORKER_DIR" --path "$TMP_FILE"

echo "Effective status flag:"
npx wrangler kv key get current --binding=STATUS_FLAG --remote --cwd "$WORKER_DIR"
