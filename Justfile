# Recipes shell out to existing npm scripts and scripts/* helpers; those
# already load the env files they need (.dev.vars, etc.). No dotenv-load
# here on purpose — `just`'s parser only understands bare KEY=VALUE and
# would silently drop shell-prefixed lines, so we never want to surprise
# a contributor who drops a root .env.

# Show all recipes with their one-line descriptions
default:
    @just --list

# --- Local dev ---

# Full local stack: migrations, seed, tunnel, API + UI
dev:
    npm run dev:full

# API only (wrangler, + local cron ticker)
dev-api:
    #!/usr/bin/env bash
    set -euo pipefail
    # Run the local cron ticker alongside so the scheduled() handler (review-loop
    # sweep, warm-pool reconcile, etc.) fires — wrangler dev registers crons but
    # never fires them, so without this organic RLA/verification never advances.
    # The npm script stays a pure passthrough for composing callers.
    bash scripts/dev-cron-ticker.sh "http://localhost:${API_PORT:-3000}" &
    ticker=$!
    trap 'kill "$ticker" 2>/dev/null || true' EXIT
    npm run dev:api

# UI only (vite)
dev-ui:
    npm run dev:ui

# Cloudflare tunnel for webhooks
dev-tunnel:
    npm run dev:tunnel

# Set up the current worktree (deps, ports, secrets, seeds, local D1 migrations)
worktree-setup:
    bash scripts/worktree-setup.sh

# Preflight local dev: validate required env, ngrok, free ports, certs
doctor:
    bash scripts/doctor.sh

# --- Quality gates ---

# Lint with auto-fix
lint:
    npm run lint

# Lint only files changed vs main
lint-changed:
    npm run lint:changed

# Type-check all workspaces
typecheck:
    npm run typecheck

# Run the full vitest suite
test:
    npm test

# Run a single vitest file or filter
test-one path:
    npx vitest run {{path}}

# Prettier write
format:
    npm run format

# Prettier check (no writes)
format-check:
    npm run format:check

# Build the UI
build:
    npm run build

# Verify required git hooks are installed
verify-hooks:
    npm run verify:git-hooks

# --- Database ---

# Apply migrations to local D1
db-migrate:
    npm run db:migrate:local

# Apply migrations to PRODUCTION D1 (prompts for confirmation; args mirror deploy-control-plane.yml)
db-migrate-prod:
    #!/usr/bin/env bash
    set -euo pipefail
    just _confirm "Run PRODUCTION D1 migration?"
    (cd apps/control-plane-worker && npx wrangler d1 migrations apply cycloid-control-plane-production --remote)

# --- E2B sandbox ---

# Build the E2B sandbox template locally
e2b-build:
    npm run build:e2b-template

# Deploy E2B sandbox template to PROD (prompts for confirmation)
e2b-deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    just _confirm "Deploy E2B sandbox template to PRODUCTION?"
    npm run deploy:e2b:sandbox

# Deploy E2B sandbox template to QA
e2b-deploy-qa:
    npm run deploy:e2b:sandbox:qa

# Run the E2B compat smoke test
e2b-smoke:
    npm run smoke:e2b:compat

# Run the E2B egress smoke test
e2b-smoke-egress:
    npm run smoke:e2b:egress

# Run the E2B baseline matrix
e2b-baseline:
    npm run baseline:e2b

# Verify an E2B session by ID
e2b-verify session_id:
    npm run verify:e2b-session -- {{session_id}}

# Drop into the E2B sandbox debug harness
e2b-debug:
    npm run debug:e2b:sandbox

# --- Secrets / security ---

# Validate a control-plane secrets JSON file (e.g. `just secrets-validate /tmp/secrets.json`)
secrets-validate path:
    node scripts/validate-control-plane-secrets.mjs {{path}}

# Check that no authenticated routes are unauthenticated by mistake
secrets-unauth-check:
    npm run security:unauth-exposure

# --- Cycloid CLI ---

# Cycloid CLI auth helper
auth:
    npm run cycloid:auth

# Run the Cycloid CLI with arbitrary args (e.g. `just cli sessions list`)
cli *args:
    npm run cli -- {{args}}

# --- Internal helpers (hidden from --list) ---

[private]
_confirm prompt:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r -p "{{prompt}} [y/N] " ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) echo "aborted"; exit 1 ;;
    esac
