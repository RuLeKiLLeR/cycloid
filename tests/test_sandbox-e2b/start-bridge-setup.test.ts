import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  baseEnv,
  cleanupTempDirs,
  CLONE_TOKEN,
  makeTempDir,
  setupScriptEnv,
  START_BRIDGE,
  writeFakeExecutable,
} from "./start-bridge-helpers";

afterEach(cleanupTempDirs);

describe("E2B start-bridge repo-owned setup script", () => {
  const scrubbedRepoEnv = [
    "SANDBOX_AUTH_TOKEN",
    "ARCANIST_TOKEN",
    "ARCANIST_ADMIN_TOKEN",
    "ARCANIST_RUNTIME_AUTH_PROOF",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ARCANIST_OPENAI_API_KEY",
    "ARCANIST_CODEX_AUTH_JSON",
    "ANTHROPIC_API_KEY",
    "ARCANIST_ANTHROPIC_API_KEY",
    "BASETEN_API_KEY",
    "ARCANIST_BASETEN_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_USER_TOKEN",
    "DD_API_KEY",
    "DD_APP_KEY",
    "BRAINTRUST_API_KEY",
    "SANDBOX_CALLBACK_SECRET",
    "SANDBOX_RUNTIME_CLEANUP_SECRET",
    "LINEAR_ACCESS_TOKEN",
    "JIRA_ACCESS_TOKEN",
    "NOTION_ACCESS_TOKEN",
    "SENTRY_ACCESS_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "LAUNCHDARKLY_ACCESS_TOKEN",
    "VERCEL_ACCESS_TOKEN",
    "STRIPE_SECRET_KEY",
    "ARCANIST_TERRAFORM_PLAN_TOKEN",
  ];

  function existingRepoWithDeps(dir: string): string {
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    // package-lock.json + node_modules => the npm fallback hits its skip branch,
    // so we can prove fallback selection without running a real npm install.
    writeFileSync(join(repoPath, "package-lock.json"), "{}\n");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    return repoPath;
  }

  function writeBridgeBundle(dir: string, source: string): string {
    const bundlePath = join(dir, "bridge-test.js");
    writeFileSync(bundlePath, source);
    return bundlePath;
  }

  it("runs .cycloid/setup.sh and skips the npm fallback when the script is present", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash\nset -euo pipefail\ntouch SETUP_RAN\n`,
    });

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    expect(output).toContain("[start-bridge] repo_setup_complete");
    // the repo owns setup end-to-end: the npm auto-detect fallback must not run
    expect(output).not.toContain("npm.ci_skip");
    expect(existsSync(join(repoPath, "SETUP_RAN"))).toBe(true);
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_READY_PATH!)).toBe(true);
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(false);
  });

  it("writes a setup-timing breadcrumb tagged repo_setup_script for the setup.sh path", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const timingsPath = join(dir, "setup-timings");
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash\nset -euo pipefail\ntouch SETUP_RAN\n`,
    });
    env.ARCANIST_SETUP_TIMINGS_PATH = timingsPath;

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] repo_setup_complete");
    const timings = readFileSync(timingsPath, "utf8");
    expect(timings).toContain("setup_kind=repo_setup_script");
    expect(timings).toMatch(/setup_ms=\d+/);
  });

  it("starts the bridge before a repo-owned setup script finishes", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const bridgeStartedPath = join(dir, "bridge-started");
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash
set -euo pipefail
i=0
while [ "$i" -lt 100 ]; do
  if [ -f "${bridgeStartedPath}" ]; then
    if [ -f "\${HOME}/.cycloid/config.json" ]; then
      echo bridge_started_with_cli_config_present > SETUP_ORDER
    else
      echo bridge_started_before_setup > SETUP_ORDER
    fi
    exit 0
  fi
  i=$((i + 1))
  sleep 0.02
done
echo bridge_not_started_before_setup > SETUP_ORDER
exit 1
`,
    });
    env.BRIDGE_BUNDLE = writeBridgeBundle(
      dir,
      `const fs = require('fs');
const { execSync } = require('child_process');
fs.writeFileSync(${JSON.stringify(bridgeStartedPath)}, 'started\\n');
console.log('bridge-started');
const ready = process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
const start = Date.now();
while (ready && !fs.existsSync(ready) && Date.now() - start < 5000) {
  try { execSync('sleep 0.05'); } catch {}
}
console.log('bridge-ok');
`,
    );

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-started");
    expect(output).toContain("bridge-ok");
    expect(output).toContain("[start-bridge] repo_setup_complete");
    expect(output).not.toContain("repo_setup_failed");
    expect(readFileSync(join(repoPath, "SETUP_ORDER"), "utf8").trim()).toBe("bridge_started_before_setup");
  });

  it("marks deferred Cycloid CLI auth pending before the bridge starts and ready after setup finishes", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const bridgeStartedPath = join(dir, "bridge-started");
    const snapshotPath = join(dir, "auth-marker-snapshot.json");
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash
set -euo pipefail
i=0
while [ "$i" -lt 100 ]; do
  if [ -f "${bridgeStartedPath}" ]; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.02
done
exit 1
`,
    });
    env.ARCANIST_TOKEN = "preexisting-cli-token";
    env.BRIDGE_BUNDLE = writeBridgeBundle(
      dir,
      `const fs = require('fs');
const { execSync } = require('child_process');
fs.writeFileSync(${JSON.stringify(bridgeStartedPath)}, 'started\\n');
fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
  pending: fs.existsSync(process.env.ARCANIST_CLI_AUTH_PENDING_PATH),
  ready: fs.existsSync(process.env.ARCANIST_CLI_AUTH_READY_PATH),
  failed: fs.existsSync(process.env.ARCANIST_CLI_AUTH_FAILED_PATH),
}));
const ready = process.env.ARCANIST_CLI_AUTH_READY_PATH;
const config = \`\${process.env.HOME}/.cycloid/config.json\`;
const start = Date.now();
while (Date.now() - start < 5000) {
  if (ready && fs.existsSync(ready) && fs.existsSync(config)) break;
  try { execSync('sleep 0.05'); } catch {}
}
console.log('bridge-ok');
`,
    );

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });
    const markerSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

    expect(output).toContain("bridge-ok");
    expect(markerSnapshot).toEqual({
      pending: true,
      ready: false,
      failed: false,
    });
    expect(existsSync(env.ARCANIST_CLI_AUTH_PENDING_PATH!)).toBe(false);
    expect(existsSync(env.ARCANIST_CLI_AUTH_READY_PATH!)).toBe(true);
    expect(existsSync(env.ARCANIST_CLI_AUTH_FAILED_PATH!)).toBe(false);
    const configPath = join(env.HOME!, ".cycloid", "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      apiUrl: "https://control.example.com",
      token: "preexisting-cli-token",
    });
  });

  it("scrubs Cycloid-owned credentials from the setup script environment", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const binDir = join(dir, "bin");
    const codexLog = join(dir, "codex.log");
    const codexHome = join(dir, "codex-home");
    const authJson = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}';
    const env = setupScriptEnv(dir, repoPath, {
      // Record which sensitive vars are visible to the script.
      scriptBody: `#!/usr/bin/env bash\n{\n  for name in ${scrubbedRepoEnv.join(" ")}; do echo "$name=\${!name:-UNSET}"; done\n  echo "GITHUB_CLONE_TOKEN=\${GITHUB_CLONE_TOKEN:-UNSET}"\n  if [ -f "\${CODEX_HOME}/auth.json" ]; then\n    echo "CODEX_AUTH_JSON_FILE=present"\n  else\n    echo "CODEX_AUTH_JSON_FILE=absent"\n  fi\n  if [ -f "\${HOME}/.cycloid/config.json" ]; then\n    echo "CYCLOID_CONFIG=present"\n  else\n    echo "CYCLOID_CONFIG=absent"\n  fi\n} > ENV_DUMP\n`,
    });
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${codexLog}"
printf 'codex-auth-json-var=%s\\n' "\${ARCANIST_CODEX_AUTH_JSON:-UNSET}" >> "${codexLog}"
`,
    );
    for (const name of scrubbedRepoEnv) env[name] = `sentinel-${name}`;
    env.ARCANIST_TOKEN = "preexisting-cli-token";
    env.ARCANIST_CODEX_AUTH_JSON = authJson;
    env.CODEX_HOME = codexHome;
    env.BRIDGE_BUNDLE = writeBridgeBundle(
      dir,
      `const fs = require('fs');
const { execSync } = require('child_process');
const ready = process.env.ARCANIST_WORKSPACE_SETUP_READY_PATH;
const config = \`\${process.env.HOME}/.cycloid/config.json\`;
const start = Date.now();
while (Date.now() - start < 5000) {
  if (ready && fs.existsSync(ready) && fs.existsSync(config)) break;
  try { execSync('sleep 0.05'); } catch {}
}
console.log('bridge-ok');
`,
    );

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const dump = readFileSync(join(repoPath, "ENV_DUMP"), "utf8");
    expect(output).toContain("bridge-ok");
    for (const name of scrubbedRepoEnv) expect(dump).toContain(`${name}=UNSET`);
    expect(dump).toContain("CODEX_AUTH_JSON_FILE=absent");
    // GITHUB_CLONE_TOKEN stays so private dependency installs still work.
    expect(dump).toContain(`GITHUB_CLONE_TOKEN=${CLONE_TOKEN}`);
    expect(dump).toContain("CYCLOID_CONFIG=absent");
    expect(existsSync(codexLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
    const configPath = join(env.HOME!, ".cycloid", "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      apiUrl: "https://control.example.com",
      token: "preexisting-cli-token",
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("writes a failed auth marker when deferred Cycloid CLI auth bootstrap fails", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const snapshotPath = join(dir, "auth-failure-snapshot.json");
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
    });
    env.FAKE_CURL_FAIL = "28";
    env.BRIDGE_BUNDLE = writeBridgeBundle(
      dir,
      `const fs = require('fs');
const { execSync } = require('child_process');
const failed = process.env.ARCANIST_CLI_AUTH_FAILED_PATH;
const ready = process.env.ARCANIST_CLI_AUTH_READY_PATH;
const start = Date.now();
while (Date.now() - start < 5000) {
  if ((failed && fs.existsSync(failed)) || (ready && fs.existsSync(ready))) break;
  try { execSync('sleep 0.05'); } catch {}
}
fs.writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
  ready: fs.existsSync(process.env.ARCANIST_CLI_AUTH_READY_PATH),
  failed: fs.existsSync(process.env.ARCANIST_CLI_AUTH_FAILED_PATH),
}));
`,
    );

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });
    const markerSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

    expect(result.status).toBe(0);
    expect(markerSnapshot).toEqual({
      ready: false,
      failed: true,
    });
    expect(existsSync(env.ARCANIST_CLI_AUTH_READY_PATH!)).toBe(false);
    expect(existsSync(env.ARCANIST_CLI_AUTH_FAILED_PATH!)).toBe(true);
    expect(existsSync(join(env.HOME!, ".cycloid", "config.json"))).toBe(false);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("cycloid_cli_auth_deferred reason=repo_setup_pending");
    expect(startupLog).toContain("cycloid_cli_auth_failure reason=token_request_failed");
  });

  it("falls back to npm dependency install when no setup script is present", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      ARCANIST_WORKSPACE_SETUP_PENDING_PATH: join(dir, "ws-pending"),
      ARCANIST_WORKSPACE_SETUP_READY_PATH: join(dir, "ws-ready"),
      ARCANIST_WORKSPACE_SETUP_FAILED_PATH: join(dir, "ws-failed"),
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("npm.ci_skip");
    expect(output).not.toContain("repo_setup_start");
  });

  it("writes the failure marker and logs the exit code when a strict setup script fails", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash\nset -euo pipefail\nexit 7\n`,
    });

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(0); // setup failure does not fail sandbox startup
    expect(result.stderr).toContain("[start-bridge] repo_setup_failed");
    expect(result.stderr).toContain("exit_code=7");
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(true);
    // still marks ready so the agent can run (warn-and-continue)
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_READY_PATH!)).toBe(true);
  });

  it("does not flag failure when a non-strict script masks an inner error (exit-status contract)", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env = setupScriptEnv(dir, repoPath, {
      // No `set -e`: the failing command is masked by the trailing echo, so the
      // script exits 0 and Cycloid cannot detect the failure. Documents why
      // customer scripts must propagate failures.
      scriptBody: `#!/usr/bin/env bash\nfalse\necho done\n`,
    });

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] repo_setup_complete");
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(false);
  });

  it("writes the failure marker and logs a timeout on the SIGTERM (124) timeout path", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env = setupScriptEnv(dir, repoPath, {
      scriptBody: `#!/usr/bin/env bash\nset -euo pipefail\nsleep 9999\n`,
      forceExit: 124,
    });

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[start-bridge] repo_setup_timeout");
    expect(result.stderr).not.toContain("repo_setup_failed");
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(true);
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_READY_PATH!)).toBe(true);
  });

  it("logs a timeout (not a generic failure) on the SIGKILL (137) grace-period path", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env = setupScriptEnv(dir, repoPath, {
      // A script that ignores SIGTERM is killed by the -k grace period; timeout
      // then exits 137 (128+SIGKILL), which must still be reported as a timeout.
      scriptBody: `#!/usr/bin/env bash\ntrap '' TERM\nsleep 9999\n`,
      forceExit: 137,
    });

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[start-bridge] repo_setup_timeout");
    expect(result.stderr).toContain("exit_code=137");
    expect(result.stderr).not.toContain("repo_setup_failed");
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(true);
  });

  it("clears a stale failure marker on boot when no setup script runs", () => {
    const dir = makeTempDir();
    const repoPath = existingRepoWithDeps(dir);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      ARCANIST_WORKSPACE_SETUP_PENDING_PATH: join(dir, "ws-pending"),
      ARCANIST_WORKSPACE_SETUP_READY_PATH: join(dir, "ws-ready"),
      ARCANIST_WORKSPACE_SETUP_FAILED_PATH: join(dir, "ws-failed"),
    };
    // Simulate a marker left over from a prior boot on a reused sandbox. The npm
    // skip path (node_modules present) never marks pending, so the boot must
    // clear this itself or the bridge would falsely report a failure.
    writeFileSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!, "stale\n");

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("npm.ci_skip");
    expect(existsSync(env.ARCANIST_WORKSPACE_SETUP_FAILED_PATH!)).toBe(false);
  });

  describe("swap setup", () => {
    // Best-effort swap fakes layered onto baseEnv's bin dir: sudo passthrough, a
    // df reporting a controllable available-GiB, and stub fallocate/mkswap/swapon
    // so the swap path is deterministic on both Linux CI and macOS dev machines.
    function swapEnv(
      dir: string,
      repoPath: string,
      opts: { availGb?: number; extra?: NodeJS.ProcessEnv } = {},
    ): NodeJS.ProcessEnv {
      const env = baseEnv(dir, repoPath);
      const binDir = join(dir, "bin");
      writeFakeExecutable(binDir, "sudo", `#!/usr/bin/env bash\nexec "$@"\n`);
      writeFakeExecutable(binDir, "df", `#!/usr/bin/env bash\necho "Avail"\necho "${opts.availGb ?? 30}G"\n`);
      writeFakeExecutable(binDir, "fallocate", `#!/usr/bin/env bash\n: > "$3"\n`);
      writeFakeExecutable(binDir, "mkswap", `#!/usr/bin/env bash\nexit 0\n`);
      const swaponLog = join(dir, "swapon.log");
      writeFakeExecutable(binDir, "swapon", `#!/usr/bin/env bash\necho "$@" >> "${swaponLog}"\nexit 0\n`);
      return {
        ...env,
        ARCANIST_SWAPFILE_PATH: join(dir, "swapfile"),
        FAKE_SWAPON_LOG: swaponLog,
        ...(opts.extra ?? {}),
      };
    }

    it("enables an adaptively-sized swapfile and caps it at the max", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      // avail 30G - 10G reserve = 20G, capped at the 8G max.
      const env = swapEnv(dir, repoPath, { availGb: 30 });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      const log = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
      expect(log).toContain("swap_enabled size_gb=8");
      expect(readFileSync(join(dir, "swapon.log"), "utf8")).toContain(join(dir, "swapfile"));
    });

    it("honors ARCANIST_SWAP_MAX_GB when capping adaptive swap", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      // avail 30G - 10G reserve = 20G, capped at the configured 2G max.
      const env = swapEnv(dir, repoPath, { availGb: 30, extra: { ARCANIST_SWAP_MAX_GB: "2" } });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      const log = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
      expect(log).toContain("swap_enabled size_gb=2");
      expect(readFileSync(join(dir, "swapon.log"), "utf8")).toContain(join(dir, "swapfile"));
    });

    it("honors a forced ARCANIST_SWAP_SIZE_GB", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      const env = swapEnv(dir, repoPath, { extra: { ARCANIST_SWAP_SIZE_GB: "4" } });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      expect(readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8")).toContain("swap_enabled size_gb=4");
    });

    it("skips swap when disabled", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      const env = swapEnv(dir, repoPath, { extra: { ARCANIST_SWAP_DISABLED: "1" } });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      expect(readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8")).toContain("swap_skip reason=disabled");
      expect(existsSync(join(dir, "swapon.log"))).toBe(false);
    });

    it("skips swap when disk headroom is insufficient", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      // avail 11G - 10G reserve = 1G, below the 2G floor.
      const env = swapEnv(dir, repoPath, { availGb: 11 });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      expect(readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8")).toContain("swap_skip reason=insufficient_disk");
      expect(existsSync(join(dir, "swapon.log"))).toBe(false);
    });

    it("skips a forced size below the floor with a distinct reason (not insufficient_disk)", () => {
      const dir = makeTempDir();
      const repoPath = join(dir, "workspace", "repo");
      const env = swapEnv(dir, repoPath, { extra: { ARCANIST_SWAP_SIZE_GB: "1" } });

      execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

      const log = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
      expect(log).toContain("swap_skip reason=size_below_floor");
      expect(log).not.toContain("reason=insufficient_disk");
      expect(existsSync(join(dir, "swapon.log"))).toBe(false);
    });
  });
});
