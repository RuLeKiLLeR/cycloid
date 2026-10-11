#!/usr/bin/env bash
set -euo pipefail

if [[ -f certs/localhost-key.pem && -f certs/localhost.pem ]]; then
  SSL_PROXY_TARGET="${API_PORT:-3000}" node scripts/ssl-proxy.mjs
else
  echo "[ssl] Skipping SSL proxy; certs not found"
fi
