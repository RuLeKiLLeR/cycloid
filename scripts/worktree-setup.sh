#!/usr/bin/env bash
# One-stop setup for local dev in a worktree.
# Installs workspace deps + config for the worktree, then applies D1 migrations.
# After this, run tests directly unless verification needs live API/UI.
#
# Usage: bash scripts/worktree-setup.sh
#   Run from inside any worktree directory.

set -euo pipefail

# Resolve the main repo root (the git common dir minus /.git)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null) || {
  echo "error: not inside a git repository" >&2
  exit 1
}
MAIN_REPO=$(cd "$GIT_COMMON" && cd .. && pwd)
WORKTREE=$(git rev-parse --show-toplevel)

if [ "$MAIN_REPO" = "$WORKTREE" ]; then
  echo "error: you're in the main repo, not a worktree" >&2
  exit 1
fi

echo "Main repo: $MAIN_REPO"
echo "Worktree:  $WORKTREE"

# --- Path helpers ---

remove_existing_path() {
  local rel="$1"
  local dst="$WORKTREE/$rel"
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    rm -rf "$dst"
  fi
}

# --- Copy helper (for files that can't be symlinked, e.g. wrangler reads relative) ---

symlink() {
  local rel="$1"
  local src="$MAIN_REPO/$rel"
  local dst="$WORKTREE/$rel"

  if [ ! -e "$src" ]; then
    echo "  skip $rel (not found in main repo)"
    return
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "  skip $rel (already exists)"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "  linked $rel"
}

copy_file() {
  local rel="$1"
  local src="$MAIN_REPO/$rel"
  local dst="$WORKTREE/$rel"

  if [ ! -e "$src" ]; then
    echo "  skip $rel (not found in main repo)"
    return
  fi
  if [ -e "$dst" ]; then
    echo "  skip $rel (already exists)"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  copied $rel"
}

link_graphite_config() {
  local src="$GIT_COMMON/.graphite_repo_config"
  local dst="$WORKTREE/.graphite_repo_config"

  if [ ! -e "$src" ]; then
    echo "  skip .graphite_repo_config (Graphite not initialized)"
    return
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "  skip .graphite_repo_config (already exists)"
    return
  fi
  ln -s "$src" "$dst"
  echo "  linked .graphite_repo_config"
}

set_dev_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.bak"
    return
  fi

  printf '\n%s=%s\n' "$key" "$value" >> "$file"
}

get_dev_var() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return
  fi
  sed -n "s|^${key}=||p" "$file" | tail -n 1
}

ensure_local_e2b_template() {
  local file="$1"
  local template="cycloid-sandbox-dev-${USER:-local}"
  local existing
  existing="$(get_dev_var "$file" "E2B_SANDBOX_TEMPLATE")"

  case "$existing" in
    ""|"cycloid-sandbox-dev-your-login"|"cycloid-sandbox-dev-<you>"|"cycloid-sandbox-dev-<your-login>")
      set_dev_var "$file" "E2B_SANDBOX_TEMPLATE" "$template"
      echo "  E2B_SANDBOX_TEMPLATE=$template"
      ;;
  esac
}

ensure_local_sandbox_callback_secret() {
  local file="$1"
  local existing
  existing="$(get_dev_var "$file" "SANDBOX_CALLBACK_SECRET")"
  if [ -z "$existing" ]; then
    set_dev_var "$file" "SANDBOX_CALLBACK_SECRET" "local-dev-sandbox-callback-secret"
    echo "  SANDBOX_CALLBACK_SECRET=<local-dev>"
  fi
}

# --- 1. Install workspace dependencies ---

echo ""
echo "Installing workspace dependencies..."
remove_existing_path "node_modules"
remove_existing_path "apps/ui/node_modules"
remove_existing_path "apps/sandbox-bridge/node_modules"
remove_existing_path "apps/control-plane-worker/node_modules"
NPM_CACHE_DIR="${NPM_CONFIG_CACHE:-$MAIN_REPO/.npm-cache}"
mkdir -p "$NPM_CACHE_DIR"
(
  cd "$WORKTREE"
  if ! NPM_CONFIG_CACHE="$NPM_CACHE_DIR" npm ci --no-audit --no-fund; then
    echo "npm ci failed — re-run 'bash scripts/worktree-setup.sh' after fixing the issue." >&2
    exit 1
  fi
)

# --- 2. Install and verify local Git hooks ---

echo ""
echo "Installing Git hooks..."
(
  cd "$WORKTREE"
  npm run prepare
  bash scripts/verify-git-hooks.sh
)

# --- 3. Copy gitignored config files ---

echo ""
echo "Copying config files..."
symlink ".env"
copy_file "apps/control-plane-worker/.dev.vars"
link_graphite_config
node "$WORKTREE/scripts/sync-codex-config.mjs" "$WORKTREE"
node "$WORKTREE/scripts/sync-agent-skills.mjs" "$WORKTREE"

(cd "$WORKTREE" && bash scripts/ensure-gh-auth.sh)

# --- 4. Apply D1 migrations ---

echo ""
echo "Applying D1 migrations..."
(cd "$WORKTREE/apps/control-plane-worker" && npx wrangler d1 migrations apply DB --local 2>&1) || {
  echo "  warning: D1 migrations failed (may already be applied)"
}

# --- 5. Seed local dev data ---

echo ""
echo "Seeding local dev data..."
(cd "$WORKTREE/apps/control-plane-worker" && bash scripts/seed-local.sh 2>&1) || {
  echo "  warning: seeding failed"
}

# --- 6. Assign unique ports for this worktree ---

echo ""
echo "Assigning worktree ports..."

# Scan sibling worktrees for used offsets
USED_OFFSETS=""
WORKTREE_DIR=$(dirname "$WORKTREE")
for ports_file in "$WORKTREE_DIR"/*/.worktree-ports; do
  [ -f "$ports_file" ] || continue
  # Extract offset: API_PORT - 3000
  api_port=$(grep '^API_PORT=' "$ports_file" | cut -d= -f2)
  if [ -n "$api_port" ]; then
    offset=$((api_port - 3000))
    USED_OFFSETS="$USED_OFFSETS $offset"
  fi
done

# Find next free offset starting at 1
OFFSET=1
while echo "$USED_OFFSETS" | grep -qw "$OFFSET"; do
  OFFSET=$((OFFSET + 1))
done

API_PORT=$((3000 + OFFSET))
UI_PORT=$((5173 + OFFSET))

cat > "$WORKTREE/.worktree-ports" <<EOF
API_PORT=$API_PORT
UI_PORT=$UI_PORT
EOF

if [ -f "$WORKTREE/apps/control-plane-worker/.dev.vars" ]; then
  set_dev_var "$WORKTREE/apps/control-plane-worker/.dev.vars" "GITHUB_CALLBACK_URL" "http://localhost:$UI_PORT/auth/callback"
  set_dev_var "$WORKTREE/apps/control-plane-worker/.dev.vars" "FRONTEND_URL" "http://localhost:$UI_PORT"
  ensure_local_e2b_template "$WORKTREE/apps/control-plane-worker/.dev.vars"
  ensure_local_sandbox_callback_secret "$WORKTREE/apps/control-plane-worker/.dev.vars"
fi

echo "  Offset: $OFFSET"
echo "  API_PORT=$API_PORT"
echo "  UI_PORT=$UI_PORT"

echo ""
echo "Minting local CLI token..."
if (cd "$WORKTREE" && npx tsx scripts/mint-local-cli-token.ts --write-config >/dev/null); then
  echo "  wrote .cycloid-cli.json"
else
  echo "  warning: local CLI token mint failed"
fi

echo ""
echo "Done. Run tests directly unless verification needs live API/UI, browser, webhook, or E2E."
echo "Use 'npm run dev:full' for that."
echo "Format commands:"
echo "  npm run format"
echo "  npm run format:check"
echo "  npm run lint:changed"
echo "  API: http://localhost:$API_PORT"
echo "  UI:  http://localhost:$UI_PORT"
