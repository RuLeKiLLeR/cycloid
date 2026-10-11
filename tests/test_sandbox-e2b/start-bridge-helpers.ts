import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Shared fixtures for the start-bridge.sh integration tests. The suite is split
// across several start-bridge-*.test.ts files so vitest distributes them over
// workers (it parallelizes across files, not within one); these helpers are the
// common fakes each file imports. Each test file registers
// `afterEach(cleanupTempDirs)` and the module-level `tempDirs` is per-file (each
// test file is its own module instance in its own worker), so the shared array
// never leaks across files.

export const REPO_ROOT = resolve(__dirname, "../..");
export const START_BRIDGE = resolve(REPO_ROOT, "apps/sandbox-e2b/start-bridge.sh");
export const TEMPLATE_TS = resolve(REPO_ROOT, "apps/sandbox-e2b/template.ts");
export const CLONE_TOKEN = "ghs_secret_clone_token";

const tempDirs: string[] = [];

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cycloid-e2b-start-"));
  tempDirs.push(dir);
  return dir;
}

export function writeFakeGit(binDir: string): void {
  const gitPath = join(binDir, "git");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_GIT_LOG"

repo=""
if [ "\${1:-}" = "-C" ]; then
  repo="$2"
  shift 2
fi

while [ "\${1:-}" = "-c" ]; do
  echo "-c $2" >> "$FAKE_GIT_LOG"
  shift 2
done

cmd="\${1:-}"
shift || true

case "$cmd" in
  clone)
    args=("$@")
    last_index=$(($# - 1))
    url_index=$(($# - 2))
    dest="\${args[$last_index]}"
    url="\${args[$url_index]}"
    branch=""
    for ((i = 0; i < $#; i++)); do
      if [ "\${args[$i]}" = "--branch" ]; then
        next=$((i + 1))
        branch="\${args[$next]:-}"
      fi
    done
    for missing_branch in \${FAKE_GIT_FAIL_BRANCH_CLONE:-}; do
      if [ "$branch" = "$missing_branch" ]; then
        echo "fatal: Remote branch $branch not found in upstream origin" >&2
        exit 128
      fi
    done
    if [ "\${FAKE_GIT_SKIP_GIT_DIR:-}" != "1" ] && [ "\${FAKE_GIT_WORKTREE_FILE:-}" != "1" ]; then
      mkdir -p "$dest/.git"
      printf '[remote "origin"]\\n\\turl = %s\\n' "$url" > "$dest/.git/config"
    elif [ "\${FAKE_GIT_WORKTREE_FILE:-}" = "1" ]; then
      mkdir -p "$dest/.git-common"
      printf 'gitdir: %s\\n' "$dest/.git-common" > "$dest/.git"
      printf '[remote "origin"]\\n\\turl = %s\\n' "$url" > "$dest/.git-common/config"
    else
      mkdir -p "$dest"
    fi
    ;;
  remote)
    if [ "\${1:-}" = "set-url" ] && [ "\${2:-}" = "origin" ]; then
      if [ "\${FAKE_GIT_NO_SCRUB:-}" = "1" ]; then
        exit 0
      fi
      config_path="$repo/.git/config"
      if [ -f "$repo/.git" ]; then
        gitdir_path="$(sed -n 's/^gitdir: //p' "$repo/.git")"
        config_path="$gitdir_path/config"
        mkdir -p "$gitdir_path"
      else
        mkdir -p "$repo/.git"
      fi
      printf '[remote "origin"]\\n\\turl = %s\\n' "$3" > "$config_path"
    fi
    ;;
  fetch)
    branch="\${2:-}"
    # start-bridge fetches with an explicit refspec so the tracking ref is
    # created; reduce it back to the bare branch name for the checks below.
    case "$branch" in
      +refs/heads/*:refs/remotes/origin/*)
        branch="\${branch#+refs/heads/}"
        branch="\${branch%%:*}"
        ;;
    esac
    if [ "\${FAKE_GIT_FAIL_CHECKOUT_BRANCH:-}" = "1" ] && [ "$branch" = "\${CHECKOUT_BRANCH:-}" ]; then
      echo "missing branch" >&2
      exit 1
    fi
    if [ "\${FAKE_GIT_FAIL_FETCH_BASE:-}" = "1" ] && [ "$branch" = "\${BRANCH:-}" ]; then
      echo "missing base branch" >&2
      exit 1
    fi
    echo "$branch" >> "$repo/FETCHED_BRANCHES"
    ;;
  checkout)
    if [ "\${FAKE_GIT_FAIL_CHECKOUT:-}" = "1" ]; then
      echo "fatal: checkout failed: ambiguous ref" >&2
      exit 1
    fi
    # Simulate a cold-VM repo with no local ref for the branch: a plain
    # \`checkout <branch>\` fails, but \`checkout -B <branch> FETCH_HEAD\` succeeds.
    if [ "\${FAKE_GIT_FAIL_PLAIN_CHECKOUT:-}" = "1" ] && [ "\${1:-}" != "-B" ]; then
      echo "error: pathspec '\${1:-}' did not match any file(s) known to git" >&2
      exit 1
    fi
    # Record the branch that is now HEAD. \`checkout -B <branch> FETCH_HEAD\` puts the
    # branch name in \$2; a plain \`checkout <branch>\` puts it in \$1.
    if [ "\${1:-}" = "-B" ]; then
      echo "\${2:-}" > "$repo/CHECKED_OUT"
    else
      echo "\${1:-}" > "$repo/CHECKED_OUT"
    fi
    ;;
  status)
    if [ "\${1:-}" = "--porcelain" ]; then
      printf '%s' "\${FAKE_GIT_STATUS_PORCELAIN:-}"
    fi
    ;;
  diff)
    # rc 1 = pathspec modified (mirrors real \`git diff --quiet\`); drives the npm
    # drift path's lockfile-rewrite guard.
    if [ "\${FAKE_GIT_LOCKFILE_DIRTY:-}" = "1" ]; then
      exit 1
    fi
    ;;
  rev-parse)
    if [ "\${1:-}" = "--is-inside-work-tree" ] && { [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; }; then
      echo true
    elif [ "\${1:-}" = "--git-path" ] && [ "\${2:-}" = "config" ]; then
      if [ -f "$repo/.git" ]; then
        printf '%s/config\\n' "$(sed -n 's/^gitdir: //p' "$repo/.git")"
      else
        printf '%s/.git/config\\n' "$repo"
      fi
    elif [ "\${1:-}" = "--verify" ] && [ "\${2:-}" = "HEAD" ]; then
      if [ "\${FAKE_GIT_EMPTY_CLONE:-}" = "1" ]; then
        exit 128
      fi
      echo "abc123"
    elif [ "\${1:-}" = "--abbrev-ref" ] && [ "\${2:-}" = "HEAD" ]; then
      if [ -f "$repo/CHECKED_OUT" ]; then
        cat "$repo/CHECKED_OUT"
      else
        echo "HEAD"
      fi
    else
      exit 128
    fi
    ;;
  *)
    ;;
esac
`,
  );
  chmodSync(gitPath, 0o755);
}

export function writeBridgeBundle(dir: string): string {
  const bundle = join(dir, "bridge.js");
  writeFileSync(bundle, "console.log('bridge-ok');\n");
  return bundle;
}

export function writeFakeExecutable(binDir: string, name: string, contents: string): string {
  const path = join(binDir, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

// `timeout` ships with coreutils in the Debian sandbox but is absent on macOS
// dev machines, so stub it for hermetic cross-platform tests. It parses
// `[-k DUR] DUR CMD...`, then execs CMD — or exits FAKE_TIMEOUT_FORCE_EXIT when
// set, simulating the real timeout's kill statuses (124 = SIGTERM, 137 = the
// SIGKILL delivered after the `-k` grace period).
export function writeFakeTimeout(binDir: string): void {
  writeFakeExecutable(
    binDir,
    "timeout",
    `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-k" ]; then shift 2; fi
shift  # drop the duration
if [ -n "\${FAKE_TIMEOUT_FORCE_EXIT:-}" ]; then exit "\${FAKE_TIMEOUT_FORCE_EXIT}"; fi
exec "$@"
`,
  );
}

// A bridge bundle that blocks until the workspace-setup ready marker appears (up
// to 5s) before printing bridge-ok. The real bridge runs forever, so the
// backgrounded setup job completes while it runs; the fake bridge would
// otherwise exit immediately and race the background job.
export function writeReadyWaitingBridgeBundle(dir: string): string {
  const bundle = join(dir, "bridge-wait.js");
  writeFileSync(
    bundle,
    `const fs = require('fs');
const { execSync } = require('child_process');
const ready = process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
const start = Date.now();
while (ready && !fs.existsSync(ready) && Date.now() - start < 5000) {
  try { execSync('sleep 0.05'); } catch (e) {}
}
console.log('bridge-ok');
`,
  );
  return bundle;
}

// Build an env for exercising the repo-owned .cycloid/setup.sh path: writes the
// script, points the marker files at the temp dir (so tests never touch global
// /tmp state), stubs timeout, and uses the ready-waiting bridge bundle.
export function setupScriptEnv(
  dir: string,
  repoPath: string,
  opts: { scriptBody: string; forceExit?: number },
): NodeJS.ProcessEnv {
  const env = baseEnv(dir, repoPath);
  writeFakeTimeout(join(dir, "bin"));
  mkdirSync(join(repoPath, ".cycloid"), { recursive: true });
  writeFileSync(join(repoPath, ".cycloid", "setup.sh"), opts.scriptBody);
  return {
    ...env,
    BRIDGE_BUNDLE: writeReadyWaitingBridgeBundle(dir),
    ARCANIST_WORKSPACE_SETUP_PENDING_PATH: join(dir, "ws-pending"),
    ARCANIST_WORKSPACE_SETUP_READY_PATH: join(dir, "ws-ready"),
    ARCANIST_WORKSPACE_SETUP_FAILED_PATH: join(dir, "ws-failed"),
    // The fake setup script finishes near-instantly; tighten the ready-poll
    // granularity so the wait loop doesn't burn a full 1s default per test.
    ARCANIST_SETUP_READY_POLL_INTERVAL_S: "0.02",
    ...(opts.forceExit !== undefined ? { FAKE_TIMEOUT_FORCE_EXIT: String(opts.forceExit) } : {}),
  };
}

export function baseEnv(dir: string, repoPath: string): NodeJS.ProcessEnv {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGit(binDir);
  const fakeGitPath = join(binDir, "git");
  if (!existsSync(join(binDir, "codex"))) {
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${CODEX_HOME:?}"
cat >/dev/null
printf '{"source":"api-key-login"}\n' > "\${CODEX_HOME}/auth.json"
`,
    );
  }
  if (!existsSync(join(binDir, "cycloid"))) {
    writeFakeExecutable(
      binDir,
      "cycloid",
      `#!/usr/bin/env bash
set -euo pipefail
echo "cycloid-test"
`,
    );
  }
  if (!existsSync(join(binDir, "cycloid-desktop-supervisor"))) {
    writeFakeExecutable(
      binDir,
      "cycloid-desktop-supervisor",
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s DISPLAY=%s\\n' "\${1:-}" "\${DISPLAY:-}" >> "\${FAKE_DESKTOP_SUPERVISOR_LOG:?}"
`,
    );
  }
  if (!existsSync(join(binDir, "curl"))) {
    writeFakeExecutable(
      binDir,
      "curl",
      `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${FAKE_CURL_FAIL:-}" ]; then
  exit "\${FAKE_CURL_FAIL}"
fi
output_path=""
write_out=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    -o)
      i=$((i + 1))
      output_path="\${args[$i]}"
      ;;
    -w)
      i=$((i + 1))
      write_out="\${args[$i]}"
      ;;
  esac
done
for arg in "$@"; do
  case "$arg" in
    */api/sessions/*/cli-auth-token)
      status="\${FAKE_CYCLOID_CLI_AUTH_STATUS:-200}"
      body="\${FAKE_CYCLOID_CLI_AUTH_BODY:-}"
      if [ -z "\${body}" ]; then
        if [ "\${status}" = "200" ]; then
          body="$(printf '{"ok":true,"token":"%s","expiresInMs":21600000}\\n' "\${FAKE_CYCLOID_CLI_TOKEN:-sandbox-cli-session-token}")"
        else
          body="$(printf '{"ok":false,"error":"CLI auth token minting is disabled"}\\n')"
        fi
      fi
      if [ -n "\${output_path}" ]; then
        printf '%s' "\${body}" > "\${output_path}"
      else
        printf '%s' "\${body}"
      fi
      if [ -n "\${write_out}" ]; then
        printf '%s' "\${write_out//\\%\\{http_code\\}/\${status}}"
      fi
      exit 0
      ;;
  esac
done
echo "unexpected curl invocation: $*" >&2
exit 22
`,
    );
  }
  if (!existsSync(join(binDir, "jq"))) {
    writeFakeExecutable(
      binDir,
      "jq",
      `#!/usr/bin/env bash
set -euo pipefail
input="\${@: -1}"
body="$(tr -d '\\n' < "$input")"
case "$body" in
  *'"ok":true'*|*'"ok": true'*)
    ;;
  *)
    exit 1
    ;;
esac
token="$(printf '%s\\n' "$body" | sed -E 's/.*"token"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/')"
if [ -z "$token" ] || [ "$token" = "$body" ]; then
  exit 1
fi
printf '%s\\n' "$token"
`,
    );
  }
  // A developer shell often carries real Cycloid CLI auth/config; any
  // inherited ARCANIST_* variable (token, API URL, runtime backend, provider
  // keys) can flip branch logic in start-bridge.sh or leak into assertions.
  // Empty string reads as unset through the script's `${VAR:-}` checks.
  const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (key.startsWith("ARCANIST_")) inheritedEnv[key] = "";
  }
  inheritedEnv.BRANCH = "";
  inheritedEnv.CHECKOUT_BRANCH = "";
  return {
    ...inheritedEnv,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    // start-bridge.sh resolves its boot git as
    // `${ARCANIST_REAL_GIT_PATH:-/usr/local/lib/cycloid/real-bin/git}`, so it
    // ignores the fake git on PATH whenever the baked real-bin git exists —
    // which it does when this suite runs inside a Cycloid sandbox image,
    // making the script attempt a real clone and fail with repo_checkout_invalid.
    // Pin it to the fake git so the harness is hermetic regardless of host.
    ARCANIST_REAL_GIT_PATH: fakeGitPath,
    BRIDGE_BUNDLE: writeBridgeBundle(dir),
    CLONE_DEPTH: "1",
    CONTROL_PLANE_URL: "https://control.example.com",
    SESSION_ID: "sess-1",
    SANDBOX_ID: "sandbox-1",
    SANDBOX_AUTH_TOKEN: "sandbox-token",
    REPO_OWNER: "acme",
    REPO_NAME: "widget",
    GITHUB_CLONE_TOKEN: CLONE_TOKEN,
    HOME: join(dir, "home"),
    CODEX_HOME: join(dir, "codex-home"),
    CODEX_API_KEY: "",
    OPENAI_API_KEY: "sk-session-test",
    ANTHROPIC_API_KEY: "",
    ARCANIST_CLI_AUTH_PENDING_PATH: join(dir, "cli-auth-pending"),
    ARCANIST_CLI_AUTH_READY_PATH: join(dir, "cli-auth-ready"),
    ARCANIST_CLI_AUTH_FAILED_PATH: join(dir, "cli-auth-failed"),
    REPO_PATH: repoPath,
    FAKE_GIT_LOG: join(dir, "git.log"),
    FAKE_DESKTOP_SUPERVISOR_LOG: join(dir, "desktop-supervisor.log"),
    ARCANIST_START_BRIDGE_LOG_PATH: join(dir, "start-bridge.log"),
  };
}
