#!/usr/bin/env bash
set -euo pipefail

export VITE_API_PORT="${API_PORT:-3000}"
export VITE_UI_PORT="${UI_PORT:-5173}"
npm run -w cycloid-ui dev
