#!/usr/bin/env bash
set -euo pipefail

# Generates locally-trusted SSL certs for localhost using mkcert.
# One-time setup for Slack OAuth local testing.

CERT_DIR="certs"

if [[ -f "$CERT_DIR/localhost.pem" && -f "$CERT_DIR/localhost-key.pem" ]]; then
  echo "SSL certs already exist in $CERT_DIR/"
  exit 0
fi

if ! command -v mkcert &>/dev/null; then
  echo "mkcert not found. Install with: brew install mkcert && mkcert -install"
  exit 1
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"
mkcert localhost
echo "SSL certs created in $CERT_DIR/"
