// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCodexEnv, extractMcpReferencedEnvNames } from "../../apps/sandbox-bridge/src/services/codex-server.js";

const tempDirs = [];
function tempCodexHome() {
  const dir = mkdtempSync(join(tmpdir(), "codex-env-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildCodexEnv", () => {
  it("sanitizes the child env: no telemetry/integration secrets, keeps CODEX_HOME and operational vars", () => {
    const codexHome = tempCodexHome();
    const { env } = buildCodexEnv(
      {
        PATH: "/tmp/cycloid-gh-shim-s-1:/usr/bin",
        SESSION_ID: "s-1",
        SANDBOX_AUTH_TOKEN: "sess",
        GH_TOKEN: "ghs_direct",
        GITHUB_CLONE_TOKEN: "ghs_clone",
        DD_API_KEY: "dd",
        BRAINTRUST_API_KEY: "bt",
        SENTRY_DSN: "https://x@sentry.io/1",
        LINEAR_ACCESS_TOKEN: "lin",
      },
      "oai-key",
      codexHome,
    );
    expect(env.CODEX_HOME).toBe(codexHome);
    expect(env.CODEX_NO_LOGIN).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SANDBOX_AUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_CLONE_TOKEN).toBeUndefined();
    expect(env.DD_API_KEY).toBeUndefined();
    expect(env.BRAINTRUST_API_KEY).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.LINEAR_ACCESS_TOKEN).toBeUndefined();
    // Provider key reinjected when no stored auth
    expect(env.OPENAI_API_KEY).toBe("oai-key");
    expect(env.CODEX_API_KEY).toBe("oai-key");
  });

  it("preserves a trusted integration token only when referenced by the MCP config", () => {
    const codexHome = tempCodexHome();
    const { env } = buildCodexEnv({ PATH: "/usr/bin", LINEAR_ACCESS_TOKEN: "lin", DD_API_KEY: "dd" }, "k", codexHome, {
      preserveNames: ["LINEAR_ACCESS_TOKEN", "DD_API_KEY"],
    });
    expect(env.LINEAR_ACCESS_TOKEN).toBe("lin");
    expect(env.DD_API_KEY).toBeUndefined();
  });

  it("preserves session-trusted managed MCP env names when referenced", () => {
    const codexHome = tempCodexHome();
    const { env, diagnostics } = buildCodexEnv(
      { PATH: "/usr/bin", DOCS_MCP_TOKEN: "docs", DD_API_KEY: "dd" },
      "k",
      codexHome,
      {
        preserveNames: ["DOCS_MCP_TOKEN", "DD_API_KEY"],
        trustedPreserveNames: ["DOCS_MCP_TOKEN", "DD_API_KEY"],
      },
    );
    expect(env.DOCS_MCP_TOKEN).toBe("docs");
    expect(env.DD_API_KEY).toBeUndefined();
    expect(diagnostics.deniedPreserveNames).toContain("DD_API_KEY");
  });

  it("extractMcpReferencedEnvNames pulls names from env_vars and env_http_headers", () => {
    const config = {
      model_provider: "openai",
      mcp_servers: {
        a: { command: "node", env_vars: ["LINEAR_ACCESS_TOKEN", "FOO"] },
        b: { url: "https://x", env_http_headers: { Authorization: "DD_APP_KEY" } },
      },
    };
    const names = extractMcpReferencedEnvNames(config);
    expect([...names].sort()).toEqual(["DD_APP_KEY", "FOO", "LINEAR_ACCESS_TOKEN"]);
  });

  it("extractMcpReferencedEnvNames skips disabled servers so their credentials are not preserved", () => {
    const config = {
      model_provider: "openai",
      mcp_servers: {
        a: { command: "node", env_vars: ["LINEAR_ACCESS_TOKEN"] },
        off: {
          command: "node",
          enabled: false,
          env_vars: ["NOTION_ACCESS_TOKEN"],
          env_http_headers: { Authorization: "SLACK_TOKEN" },
        },
      },
    };
    const names = extractMcpReferencedEnvNames(config);
    expect([...names]).toEqual(["LINEAR_ACCESS_TOKEN"]);
  });
});
