import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/ensure-gh-auth.sh");

function fakeGhScript(options: { tokenPersists: boolean }): string {
  return `#!/usr/bin/env bash
set -euo pipefail

case "$1:$2" in
  auth:token)
    hosts="\${GH_CONFIG_DIR}/hosts.yml"
    if ${options.tokenPersists ? "true" : "false"} && [ -f "$hosts" ]; then
      sed -n 's/^.*oauth_token: //p' "$hosts" | head -1
      exit 0
    fi
    exit 1
    ;;
  api:user)
    if [ -n "\${GH_TOKEN:-}" ]; then
      printf 'kv-varun\\n'
      exit 0
    fi
    exit 1
    ;;
  auth:login)
    echo "unexpected gh auth login" >&2
    exit 99
    ;;
esac

exit 1
`;
}

describe("ensure-gh-auth.sh", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function runWithFakeGh(options: { tokenPersists: boolean }) {
    tempDir = mkdtempSync(join(tmpdir(), "ensure-gh-auth-"));
    const binDir = join(tempDir, "bin");
    const configDir = join(tempDir, "gh-config");
    const fakeGh = join(binDir, "gh");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(fakeGh, fakeGhScript(options), { mode: 0o755 });

    const output = execFileSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_CONFIG_DIR: configDir,
        GH_AUTH_VERIFY_RETRY_SLEEP_SECONDS: "0",
        GITHUB_USER_TOKEN: "gho_user_token",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output, configDir };
  }

  it("seeds gh hosts config from GITHUB_USER_TOKEN without gh auth login", () => {
    const { output, configDir } = runWithFakeGh({ tokenPersists: true });

    expect(output).toContain("Authenticated gh from GITHUB_USER_TOKEN");
    const hosts = readFileSync(join(configDir, "hosts.yml"), "utf8");
    expect(hosts).toContain("github.com:");
    expect(hosts).toContain("user: kv-varun");
    expect(hosts).toContain("oauth_token: gho_user_token");
  });

  it("fails when gh auth token stays empty after seeding", () => {
    let error: { stdout?: Buffer } | undefined;
    try {
      runWithFakeGh({ tokenPersists: false });
    } catch (err) {
      error = err as { stdout?: Buffer };
    }

    expect(error?.stdout?.toString()).toContain("gh auth token is still empty");
  });
});
