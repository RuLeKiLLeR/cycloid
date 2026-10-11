import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { baseEnv, cleanupTempDirs, makeTempDir, START_BRIDGE, writeFakeExecutable } from "./start-bridge-helpers";

afterEach(cleanupTempDirs);

describe("E2B start-bridge script", () => {
  it("defers Codex subscription auth.json to the bridge", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexLog = join(dir, "codex.log");
    const codexHome = join(dir, "codex-home");
    const authJson = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}';
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${codexLog}"
exit 99
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'bridge-auth-json-var=%s\\n' "\${ARCANIST_CODEX_AUTH_JSON:-UNSET}"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      ARCANIST_CODEX_AUTH_JSON: authJson,
      OPENAI_API_KEY: "sk-session-test",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain(`bridge-auth-json-var=${authJson}`);
    expect(existsSync(codexLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("does not validate Codex subscription auth.json before starting the bridge", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexLog = join(dir, "codex.log");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${codexLog}"
exit 1
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      ARCANIST_CODEX_AUTH_JSON: '{"auth_mode":"chatgpt","tokens":{"refresh_token":"bad"}}',
      OPENAI_API_KEY: "sk-session-test",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bridge-ok");
    expect(existsSync(codexLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("defers session API-key auth to the bridge", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexLog = join(dir, "codex.log");
    const codexStdinLog = join(dir, "codex-stdin.log");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${codexLog}"
cat > "${codexStdinLog}"
mkdir -p "${codexHome}"
printf '{"source":"api-key-login"}\n' > "${codexHome}/auth.json"
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "sk-session-test",
      ARCANIST_OPENAI_API_KEY: "sk-platform-test",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    expect(existsSync(codexLog)).toBe(false);
    expect(existsSync(codexStdinLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("exports minted Cycloid CLI auth to the bridge environment", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'bridge-token=%s\\n' "\${ARCANIST_TOKEN:-}"
printf 'bridge-api-url=%s\\n' "\${ARCANIST_API_URL:-}"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_CYCLOID_CLI_TOKEN: "sandbox-cli-session-token",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-token=sandbox-cli-session-token");
    expect(output).toContain("bridge-api-url=https://control.example.com");
    const configPath = join(env.HOME!, ".cycloid", "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      apiUrl: "https://control.example.com",
      token: "sandbox-cli-session-token",
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("cycloid_cli_auth_ready reason=minted");
    expect(startupLog).not.toContain("sandbox-cli-session-token");
  });

  it("fails closed and leaves a failed marker when synchronous Cycloid CLI auth minting fails", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_CURL_FAIL: "28",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("bridge-ok");
    expect(existsSync(env.ARCANIST_CLI_AUTH_PENDING_PATH!)).toBe(false);
    expect(existsSync(env.ARCANIST_CLI_AUTH_READY_PATH!)).toBe(false);
    expect(existsSync(env.ARCANIST_CLI_AUTH_FAILED_PATH!)).toBe(true);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("cycloid_cli_auth_failure reason=token_request_failed");
    expect(startupLog).toContain("[start-bridge] exit status=1");
  });

  it("continues bridge startup when sandbox CLI auth minting is disabled", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'bridge-token=%s\\n' "\${ARCANIST_TOKEN:-}"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_CYCLOID_CLI_AUTH_STATUS: "403",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-token=");
    const configPath = join(env.HOME!, ".cycloid", "config.json");
    expect(existsSync(configPath)).toBe(false);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("cycloid_cli_auth_skip reason=disabled");
    expect(startupLog).toContain("[start-bridge] bridge_exec");
  });

  it("writes parseable Cycloid CLI config when token text contains JSON escapes", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const token = `preexisting"\\${String.fromCharCode(1, 31, 127)}token`;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      ARCANIST_TOKEN: token,
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const configPath = join(env.HOME!, ".cycloid", "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      apiUrl: "https://control.example.com",
      token,
    });
  });

  it("fails closed when no customer session key exists", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexStdinLog = join(dir, "codex-stdin.log");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
cat > "${codexStdinLog}"
mkdir -p "${codexHome}"
printf '{"source":"api-key-login"}\n' > "${codexHome}/auth.json"
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "",
      ARCANIST_OPENAI_API_KEY: "sk-platform-test",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("bridge-ok");
    expect(result.stderr).toContain("sandbox_auth_failure reason=openai_credential_missing event=sandbox_auth_failure");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("sandbox_auth_failure reason=openai_credential_missing event=sandbox_auth_failure");
    expect(startupLog).toContain("[start-bridge] exit status=1");
    expect(existsSync(codexStdinLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("authenticates the claude_code backend from ANTHROPIC_API_KEY without codex auth.json", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    // No fake `codex` executable: the claude_code path must not invoke codex.
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      ARCANIST_AGENT_RUNTIME_BACKEND: "claude_code",
      ANTHROPIC_API_KEY: "sk-ant-session",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("claude_auth_ready backend=claude_code");
    // The Codex auth.json path is skipped entirely for the claude_code backend.
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("fails closed for the claude_code backend when no Anthropic key is present", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_AGENT_RUNTIME_BACKEND: "claude_code",
      ANTHROPIC_API_KEY: "",
      ARCANIST_ANTHROPIC_API_KEY: "",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("bridge-ok");
    expect(result.stderr).toContain("sandbox_auth_failure reason=no_anthropic_key event=sandbox_auth_failure");
  });

  it("authenticates the opencode backend from BASETEN_API_KEY without codex auth.json", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'bridge-baseten=%s\\n' "\${BASETEN_API_KEY:-}"
printf 'bridge-platform-baseten=%s\\n' "\${ARCANIST_BASETEN_API_KEY:-UNSET}"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      ARCANIST_AGENT_RUNTIME_BACKEND: "opencode",
      BASETEN_API_KEY: "baseten_session_key",
      ARCANIST_BASETEN_API_KEY: "platform_baseten_key_must_not_leak",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-baseten=baseten_session_key");
    expect(output).toContain("bridge-platform-baseten=UNSET");
    expect(output).not.toContain("platform_baseten_key_must_not_leak");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("opencode_auth_ready backend=opencode");
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("fails closed for the opencode backend when no Baseten key is present", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_AGENT_RUNTIME_BACKEND: "opencode",
      BASETEN_API_KEY: "",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("bridge-ok");
    expect(result.stderr).toContain("sandbox_auth_failure reason=no_baseten_key event=sandbox_auth_failure");
  });

  it("does not invoke codex login before starting the bridge", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexStdinLog = join(dir, "codex-stdin.log");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
set -euo pipefail
cat > "${codexStdinLog}"
exit 17
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "sk-session-test",
    };
    const output = execFileSync("bash", [START_BRIDGE], {
      env,
      encoding: "utf8",
    });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("codex_auth_deferred source=session_api_key");
    expect(existsSync(codexStdinLog)).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  it("ignores legacy auth blobs and still fails closed without a customer key", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const codexHome = join(dir, "codex-home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
echo "bridge-ok"
`,
    );

    const result = spawnSync("bash", [START_BRIDGE], {
      env: {
        ...baseEnv(dir, repoPath),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "",
        CODEX_AUTH_JSON_BASE64: Buffer.from('{"source":"blob"}').toString("base64"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("bridge-ok");
    expect(result.stderr).toContain("sandbox_auth_failure reason=openai_credential_missing event=sandbox_auth_failure");
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });
});
