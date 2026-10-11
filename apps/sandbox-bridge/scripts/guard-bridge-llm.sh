#!/usr/bin/env bash
set -u

SRC_PATTERN='ARCANIST_OPENAI_API_KEY|CYCLOID_[A-Z_]+_API_KEY|queryOpenAIStructuredOutput|createPostExecutionLlmClient|from ['\''"]openai['\''"]|import\([^)]*['\''"]openai['\''"]'
PACKAGE_PATTERN='"openai"'

if rg -n --glob '!apps/sandbox-bridge/src/constants/observability.ts' -e "$SRC_PATTERN" apps/sandbox-bridge/src || rg -n -e "$PACKAGE_PATTERN" apps/sandbox-bridge/package.json; then
  echo "sandbox-bridge must use platform LLM broker capabilities instead of direct provider keys/clients" >&2
  exit 1
fi
