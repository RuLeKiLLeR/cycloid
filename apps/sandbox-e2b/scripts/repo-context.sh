#!/usr/bin/env bash
# repo-context.sh -- Generate a concise repo context summary for the agent.
# Runs inside the sandbox at session start. Outputs plain text to stdout.
set -euo pipefail

# ---------------------------------------------------------------------------
# Early detection: package manager (used by later sections)
# ---------------------------------------------------------------------------
PKG_MGR=""
PKG_RUN=""
if [ -f "package.json" ]; then
  if [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PKG_MGR="bun"; PKG_RUN="bun run"
  elif [ -f "pnpm-lock.yaml" ]; then
    PKG_MGR="pnpm"; PKG_RUN="pnpm run"
  elif [ -f "yarn.lock" ]; then
    PKG_MGR="yarn"; PKG_RUN="yarn"
  elif [ -f "package-lock.json" ]; then
    PKG_MGR="npm"; PKG_RUN="npm run"
  else
    PKG_MGR="npm"; PKG_RUN="npm run"
  fi
fi

echo "## Repository Context"
echo ""

# ---------------------------------------------------------------------------
# Directory structure (top 2 levels, excludes noise)
# ---------------------------------------------------------------------------
if command -v tree &>/dev/null; then
  echo "### Directory Structure"
  tree -L 2 --dirsfirst -I 'node_modules|.git|__pycache__|.next|dist|build|.cache|coverage|.tox|.mypy_cache|.ruff_cache|vendor|target' 2>/dev/null || ls -la
  echo ""
fi

# ---------------------------------------------------------------------------
# Detect language/framework
# ---------------------------------------------------------------------------
echo "### Project Type"
detected=()
if [ -f "package.json" ]; then
  detected+=("Node.js/JavaScript")
  if [ -f "tsconfig.json" ]; then
    detected+=("TypeScript")
  fi
fi
if [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "requirements.txt" ]; then
  detected+=("Python")
fi
if [ -f "go.mod" ]; then
  detected+=("Go")
fi
if [ -f "Cargo.toml" ]; then
  detected+=("Rust")
fi
if [ -f "pom.xml" ] || [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
  detected+=("Java/JVM")
fi
if [ ${#detected[@]} -gt 0 ]; then
  echo "Detected: ${detected[*]}"
else
  echo "Detected: Unknown"
fi
echo ""

# ---------------------------------------------------------------------------
# Package manager
# ---------------------------------------------------------------------------
if [ -n "$PKG_MGR" ]; then
  echo "### Package Manager"
  echo "Detected: **$PKG_MGR**"
  if [ "$PKG_MGR" != "npm" ]; then
    echo "Use \`${PKG_MGR} install\` and \`${PKG_RUN} <script>\` instead of npm."
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Runtime version constraints
# ---------------------------------------------------------------------------
runtime_lines=()
if [ -f ".nvmrc" ]; then
  ver=$(head -1 .nvmrc 2>/dev/null | tr -d '[:space:]')
  [ -n "$ver" ] && runtime_lines+=("- Node.js: $ver (from .nvmrc)")
elif [ -f ".node-version" ]; then
  ver=$(head -1 .node-version 2>/dev/null | tr -d '[:space:]')
  [ -n "$ver" ] && runtime_lines+=("- Node.js: $ver (from .node-version)")
fi
if [ -f ".python-version" ]; then
  ver=$(head -1 .python-version 2>/dev/null | tr -d '[:space:]')
  [ -n "$ver" ] && runtime_lines+=("- Python: $ver (from .python-version)")
fi
if [ -f ".ruby-version" ]; then
  ver=$(head -1 .ruby-version 2>/dev/null | tr -d '[:space:]')
  [ -n "$ver" ] && runtime_lines+=("- Ruby: $ver (from .ruby-version)")
fi
if [ -f ".go-version" ]; then
  ver=$(head -1 .go-version 2>/dev/null | tr -d '[:space:]')
  [ -n "$ver" ] && runtime_lines+=("- Go: $ver (from .go-version)")
elif [ -f "go.mod" ]; then
  ver=$(grep -m1 '^go ' go.mod 2>/dev/null | awk '{print $2}' || true)
  [ -n "$ver" ] && runtime_lines+=("- Go: $ver (from go.mod)")
fi
if [ -f "rust-toolchain.toml" ]; then
  ver=$(grep -m1 'channel' rust-toolchain.toml 2>/dev/null | sed 's/.*=\s*"\?\([^"]*\)"\?/\1/' | tr -d '[:space:]' || true)
  [ -n "$ver" ] && runtime_lines+=("- Rust: $ver (from rust-toolchain.toml)")
fi
if [ -f ".tool-versions" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && runtime_lines+=("- $line (from .tool-versions)")
  done < <(head -20 .tool-versions 2>/dev/null || true)
fi
if [ ${#runtime_lines[@]} -gt 0 ]; then
  echo "### Runtime Versions"
  printf '%s\n' "${runtime_lines[@]}"
  echo ""
fi

# ---------------------------------------------------------------------------
# Monorepo workspaces
# ---------------------------------------------------------------------------
workspace_lines=()
monorepo_tool=""
if [ -f "package.json" ]; then
  if command -v jq &>/dev/null; then
    # package.json workspaces can be an array or { packages: [...] }
    ws=$(jq -r '(.workspaces // .workspaces.packages // empty) | if type == "array" then .[] else empty end' package.json 2>/dev/null || true)
  elif command -v node &>/dev/null; then
    ws=$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); let w=p.workspaces; if (Array.isArray(w)) { /* ok */ } else if (w && Array.isArray(w.packages)) { w=w.packages; } else { w=[]; } if (Array.isArray(w)) process.stdout.write(w.join("\n"));' 2>/dev/null || true)
  else
    ws=""
  fi
  if [ -n "$ws" ]; then
    monorepo_tool="npm/yarn/pnpm workspaces"
    while IFS= read -r w; do
      workspace_lines+=("$w")
    done <<< "$ws"
  fi
fi
if [ -f "pnpm-workspace.yaml" ] && [ -z "$monorepo_tool" ]; then
  monorepo_tool="pnpm workspaces"
  while IFS= read -r w; do
    [ -n "$w" ] && workspace_lines+=("$w")
  done < <(grep -E '^\s*-\s' pnpm-workspace.yaml 2>/dev/null | sed 's/^\s*-\s*//' | head -30 || true)
fi
if [ -z "$monorepo_tool" ]; then
  for cfg in "nx.json" "turbo.json" "lerna.json"; do
    if [ -f "$cfg" ]; then
      monorepo_tool="$cfg"
      break
    fi
  done
fi
if [ -n "$monorepo_tool" ]; then
  echo "### Monorepo Workspaces"
  echo "Tool: $monorepo_tool"
  if [ ${#workspace_lines[@]} -gt 0 ]; then
    count=${#workspace_lines[@]}
    for w in "${workspace_lines[@]:0:30}"; do
      echo "  - $w"
    done
    if [ "$count" -gt 30 ]; then
      echo "  - ... and $((count - 30)) more"
    fi
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Available commands (existing, updated to use $PKG_RUN)
# ---------------------------------------------------------------------------
echo "### Available Commands"
if [ -f "package.json" ] && [ -n "$PKG_MGR" ]; then
  echo "**$PKG_MGR scripts** (from package.json):"
  if command -v jq &>/dev/null; then
    keys=$(jq -r '.scripts // {} | keys[]' package.json 2>/dev/null || true)
  elif command -v node &>/dev/null; then
    keys=$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); const s=p.scripts ?? {}; process.stdout.write(Object.keys(s).join("\n"));' 2>/dev/null || true)
  else
    keys=""
  fi
  if [ -n "$keys" ]; then
    while IFS= read -r k; do
      [ -n "$k" ] && echo "  - ${PKG_RUN} ${k}"
    done <<< "$keys"
  fi
  echo ""
fi
if [ -f "Makefile" ]; then
  echo "**Makefile targets:**"
  grep -E '^[a-zA-Z_-]+:' Makefile 2>/dev/null | head -20 | sed 's/:.*$//' | sed 's/^/  - make /' || true
  echo ""
fi
if [ -f "pyproject.toml" ]; then
  echo "**Python project** (pyproject.toml found)"
  if grep -q '\[tool.pytest' pyproject.toml 2>/dev/null; then
    echo "  - pytest"
  fi
  if grep -q '\[tool.ruff' pyproject.toml 2>/dev/null; then
    echo "  - ruff check ."
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Test commands
# ---------------------------------------------------------------------------
test_cmds=()
if [ -f "package.json" ] && [ -n "$PKG_MGR" ] && (command -v jq &>/dev/null || command -v node &>/dev/null); then
  if command -v jq &>/dev/null; then
    for script in test test:unit test:integration test:e2e; do
      if jq -e ".scripts[\"$script\"]" package.json &>/dev/null; then
        test_cmds+=("$PKG_RUN $script")
      fi
    done
  else
    # jq-free fallback: determine which candidate scripts exist.
    found=$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); const s=p.scripts ?? {}; const c=["test","test:unit","test:integration","test:e2e"]; const out=c.filter(k=>Object.prototype.hasOwnProperty.call(s,k)); process.stdout.write(out.join("\n"));' 2>/dev/null || true)
    while IFS= read -r script; do
      [ -n "$script" ] && test_cmds+=("$PKG_RUN $script")
    done <<< "$found"
  fi
fi
if [ -f "pyproject.toml" ] && grep -q '\[tool.pytest' pyproject.toml 2>/dev/null; then
  test_cmds+=("pytest")
fi
if [ -f "go.mod" ]; then
  test_cmds+=("go test ./...")
fi
if [ -f "Cargo.toml" ]; then
  test_cmds+=("cargo test")
fi
if [ ${#test_cmds[@]} -gt 0 ]; then
  echo "### Test Commands"
  for cmd in "${test_cmds[@]}"; do
    echo "  - \`$cmd\`"
  done
  echo ""
fi

# ---------------------------------------------------------------------------
# Code quality tools (linters/formatters)
# ---------------------------------------------------------------------------
tools=()
# ESLint
for f in .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintrc.yaml; do
  if [ -f "$f" ]; then tools+=("ESLint"); break; fi
done
if [ ${#tools[@]} -eq 0 ] || [[ ! " ${tools[*]} " =~ " ESLint " ]]; then
  for f in eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts; do
    if [ -f "$f" ]; then tools+=("ESLint"); break; fi
  done
fi
# Prettier
for f in .prettierrc .prettierrc.js .prettierrc.cjs .prettierrc.json .prettierrc.yml .prettierrc.yaml .prettierrc.toml prettier.config.js prettier.config.cjs; do
  if [ -f "$f" ]; then tools+=("Prettier"); break; fi
done
# Biome
if [ -f "biome.json" ] || [ -f "biome.jsonc" ]; then tools+=("Biome"); fi
# Stylelint
for f in .stylelintrc .stylelintrc.js .stylelintrc.json .stylelintrc.yml; do
  if [ -f "$f" ]; then tools+=("Stylelint"); break; fi
done
# Python: ruff, black
if [ -f "ruff.toml" ]; then
  tools+=("Ruff")
elif [ -f "pyproject.toml" ] && grep -q '\[tool.ruff' pyproject.toml 2>/dev/null; then
  tools+=("Ruff")
fi
if [ -f "pyproject.toml" ] && grep -q '\[tool.black' pyproject.toml 2>/dev/null; then
  tools+=("Black")
fi
# Go
if [ -f ".golangci.yml" ] || [ -f ".golangci.yaml" ] || [ -f ".golangci.json" ]; then
  tools+=("golangci-lint")
fi
# Rust
if [ -f "rustfmt.toml" ] || [ -f ".rustfmt.toml" ]; then
  tools+=("rustfmt")
fi
# EditorConfig
if [ -f ".editorconfig" ]; then tools+=("EditorConfig"); fi

if [ ${#tools[@]} -gt 0 ]; then
  echo "### Code Quality Tools"
  echo "Configured: ${tools[*]}"
  echo ""
fi

# ---------------------------------------------------------------------------
# PR template
# ---------------------------------------------------------------------------
pr_template=""
for tpl in ".github/PULL_REQUEST_TEMPLATE.md" ".github/pull_request_template.md" "PULL_REQUEST_TEMPLATE.md" "pull_request_template.md"; do
  if [ -f "$tpl" ]; then
    pr_template="$tpl"
    break
  fi
done
if [ -d ".github/PULL_REQUEST_TEMPLATE" ]; then
  echo "### PR Template"
  echo "Multiple PR templates in \`.github/PULL_REQUEST_TEMPLATE/\`. Read before creating PRs."
  echo ""
elif [ -n "$pr_template" ]; then
  echo "### PR Template"
  echo "Found at \`$pr_template\`. Read it before creating PRs."
  echo ""
fi

# ---------------------------------------------------------------------------
# Environment variable template
# ---------------------------------------------------------------------------
env_template=""
for f in ".env.example" ".env.template" ".env.sample"; do
  if [ -f "$f" ]; then
    env_template="$f"
    break
  fi
done
if [ -n "$env_template" ]; then
  echo "### Environment Variables"
  echo "Template: \`$env_template\`"
  vars=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$env_template" 2>/dev/null | cut -d= -f1 | head -30 || true)
  if [ -n "$vars" ]; then
    echo "Variables:"
    echo "$vars" | sed 's/^/  - /'
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Git info
# ---------------------------------------------------------------------------
echo "### Git Info"
if git rev-parse --is-inside-work-tree &>/dev/null; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  echo "Branch: $branch"
  # Include GitHub repo info so the agent knows the correct org/repo for PRs
  if [ -n "${REPO_OWNER:-}" ] && [ -n "${REPO_NAME:-}" ]; then
    echo "GitHub repo: ${REPO_OWNER}/${REPO_NAME}"
    echo "Remote URL: https://github.com/${REPO_OWNER}/${REPO_NAME}"
  else
    remote_url=$(git remote get-url origin 2>/dev/null || true)
    if [ -n "$remote_url" ]; then
      echo "Remote: $remote_url"
    fi
  fi
  echo "Recent commits:"
  git log --oneline -5 2>/dev/null || true
fi
echo ""

# ---------------------------------------------------------------------------
# Check for project-level instructions
# ---------------------------------------------------------------------------
if [ -f "CLAUDE.md" ]; then
  echo "### Project Instructions"
  echo "Found CLAUDE.md -- injected as system instructions."
  echo ""
elif [ -f "agents.md" ]; then
  echo "### Project Instructions"
  echo "Found agents.md -- injected as system instructions."
  echo ""
fi
