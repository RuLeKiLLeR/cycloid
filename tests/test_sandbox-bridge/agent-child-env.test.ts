// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { buildAgentChildEnv, buildRepoCommandEnv } from "../../apps/sandbox-bridge/src/utils/sanitized-env.js";
import {
  ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV,
  isAgentVisibleRepoRuntimeEnvName,
  TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES,
} from "../../shared/constants/agent-child-env.js";
import {
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  LAUNCHDARKLY_ACCESS_TOKEN_ENV,
  LINEAR_ACCESS_TOKEN_ENV,
  NOTION_ACCESS_TOKEN_ENV,
  SENTRY_ACCESS_TOKEN_ENV,
  SENTRY_ORGANIZATION_SLUG_ENV,
} from "../../shared/constants/sandbox-env.js";

/** A realistic full bridge env carrying every class of secret. */
function fullBridgeEnv() {
  return {
    // Toolchain / OS (allowlisted)
    PATH: "/tmp/cycloid-gh-shim-s-1:/usr/bin",
    ARCANIST_GH_SHIM_DIR: "/tmp/cycloid-gh-shim-s-1",
    HOME: "/home/user",
    LANG: "C.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096",
    // Non-secret session/repo context (allowlisted)
    SESSION_ID: "s-1",
    CONTROL_PLANE_URL: "https://cp.example.com",
    REPO_OWNER: "acme",
    MODEL: "gpt-x",
    ARCANIST_RUNTIME_PROVIDER: "e2b",
    // Bridge-only operational secret
    SANDBOX_AUTH_TOKEN: "sess-token",
    ARCANIST_RUNTIME_AUTH_PROOF: "runtime-auth-proof",
    ARCANIST_REAL_GIT_PATH: "/usr/local/lib/cycloid/real-bin/git",
    ARCANIST_REAL_GH_PATH: "/usr/local/lib/cycloid/real-bin/gh",
    // Bridge-only integration token
    ARCANIST_TERRAFORM_PLAN_TOKEN: "tf-plan-token",
    STRIPE_SECRET_KEY: "stripe-secret",
    TF_TOKEN_app_terraform_io: "tf-standard-token",
    // Platform telemetry secrets (must be stripped)
    DD_API_KEY: "dd-secret",
    DD_SITE: "datadoghq.com",
    DD_APP_KEY: "dd-app",
    BRAINTRUST_API_KEY: "bt-secret",
    SENTRY_DSN: "https://x@sentry.io/1",
    // Transport / platform secrets
    SANDBOX_CALLBACK_SECRET: "cb",
    ARCANIST_ADMIN_TOKEN: "admin",
    ARCANIST_TOKEN: "tok",
    GITHUB_CLONE_TOKEN: "ghc",
    GITHUB_USER_TOKEN: "ghu",
    GH_TOKEN: "gh",
    // Customer integration tokens (stripped unless preserved)
    LINEAR_ACCESS_TOKEN: "lin",
    NOTION_ACCESS_TOKEN: "notion",
    CF_API_TOKEN: "cf",
    LAUNCHDARKLY_ACCESS_TOKEN: "ld",
    // Customer runtime cred spread directly into e2bEnvs
    MY_APP_DATABASE_URL: "postgres://secret",
    // Secret-bearing preview contract
    ARCANIST_PREVIEW_CONTRACT_JSON: JSON.stringify({ composeEnv: { DATABASE_URL: "postgres://x" } }),
    ARCANIST_LOGIN_PASSWORD: "pw",
    // Model provider keys (only reinjected explicitly)
    OPENAI_API_KEY: "oai",
    ANTHROPIC_API_KEY: "anth",
  };
}

describe("buildAgentChildEnv", () => {
  it("pins the reviewed trusted integration credential posture", () => {
    expect([...TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES].sort()).toEqual(
      [
        BRAINTRUST_INTEGRATION_API_KEY_ENV,
        BRAINTRUST_INTEGRATION_API_URL_ENV,
        CLOUDFLARE_ACCOUNT_ID_ENV,
        CLOUDFLARE_API_TOKEN_ENV,
        CLOUDFLARE_D1_DATABASE_ID_ENV,
        JIRA_ACCESS_TOKEN_ENV,
        JIRA_CLOUD_ID_ENV,
        JIRA_SITE_URL_ENV,
        LINEAR_ACCESS_TOKEN_ENV,
        NOTION_ACCESS_TOKEN_ENV,
        SENTRY_ACCESS_TOKEN_ENV,
        SENTRY_ORGANIZATION_SLUG_ENV,
        "SLACK_TOKEN",
        "SLACK_USER_TOKEN",
      ].sort(),
    );
  });

  it("strips platform/transport/integration secrets and keeps allowlisted operational vars", () => {
    const { env } = buildAgentChildEnv(fullBridgeEnv());

    // Allowlisted survive
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.SESSION_ID).toBe("s-1");
    expect(env.CONTROL_PLANE_URL).toBe("https://cp.example.com");
    expect(env.REPO_OWNER).toBe("acme");
    expect(env.MODEL).toBe("gpt-x");
    // Non-secret ARCANIST_* via prefix rule
    expect(env.ARCANIST_RUNTIME_PROVIDER).toBe("e2b");

    // Platform telemetry secrets stripped
    for (const k of [
      "DD_API_KEY",
      "DD_SITE",
      "DD_APP_KEY",
      "BRAINTRUST_API_KEY",
      LAUNCHDARKLY_ACCESS_TOKEN_ENV,
      "SENTRY_DSN",
      "VERCEL_ACCESS_TOKEN",
      "VERCEL_TEAM_ID",
      "STRIPE_SECRET_KEY",
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    // Transport / platform secrets stripped
    for (const k of [
      "SANDBOX_CALLBACK_SECRET",
      "SANDBOX_AUTH_TOKEN",
      "ARCANIST_RUNTIME_AUTH_PROOF",
      "ARCANIST_ADMIN_TOKEN",
      "ARCANIST_TOKEN",
      "GITHUB_CLONE_TOKEN",
      "GITHUB_USER_TOKEN",
      "GH_TOKEN",
      "ARCANIST_REAL_GIT_PATH",
      "ARCANIST_REAL_GH_PATH",
      "ARCANIST_GH_SHIM_DIR",
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    // Integration tokens stripped (none referenced)
    for (const k of ["LINEAR_ACCESS_TOKEN", "NOTION_ACCESS_TOKEN", "CF_API_TOKEN", "MY_APP_DATABASE_URL"]) {
      expect(env[k], k).toBeUndefined();
    }
    // Preview contract + login secrets stripped
    expect(env.ARCANIST_PREVIEW_CONTRACT_JSON).toBeUndefined();
    expect(env.ARCANIST_LOGIN_PASSWORD).toBeUndefined();
    // Provider keys not present unless injected
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Execution-control NODE_OPTIONS is not allowlisted
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ARCANIST_TERRAFORM_PLAN_TOKEN).toBeUndefined();
    expect(env.VERCEL_ACCESS_TOKEN).toBeUndefined();
    expect(env.VERCEL_TEAM_ID).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.TF_TOKEN_app_terraform_io).toBeUndefined();
  });

  it("injects provider keys explicitly and reports withheld platform names", () => {
    const { env, withheldPlatformNames } = buildAgentChildEnv(fullBridgeEnv(), {
      providerKeys: { ANTHROPIC_API_KEY: "anth", BASETEN_API_KEY: "baseten" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("anth");
    expect(env.BASETEN_API_KEY).toBe("baseten");
    expect(withheldPlatformNames).toContain("DD_API_KEY");
    expect(withheldPlatformNames).toContain("SENTRY_DSN");
    // Customer-named creds counted, not name-logged
    expect(withheldPlatformNames).not.toContain("MY_APP_DATABASE_URL");
  });

  it("rejects providerKeys not on the provider allowlist (cannot smuggle a platform secret)", () => {
    const { env } = buildAgentChildEnv(fullBridgeEnv(), {
      providerKeys: { DD_API_KEY: "smuggled", ARCANIST_TOKEN: "smuggled", OPENAI_API_KEY: "ok" },
    });
    expect(env.DD_API_KEY).toBeUndefined();
    expect(env.ARCANIST_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("ok");
  });

  it("preserves only trusted-allowlist names referenced by MCP, denying the rest", () => {
    const { env, deniedPreserveNames } = buildAgentChildEnv(fullBridgeEnv(), {
      preserveNames: ["LINEAR_ACCESS_TOKEN", "DD_API_KEY", "UNKNOWN_TOKEN"],
    });
    expect(env.LINEAR_ACCESS_TOKEN).toBe("lin"); // trusted + referenced
    expect(env.DD_API_KEY).toBeUndefined(); // platform name never preserved
    expect(deniedPreserveNames).toContain("DD_API_KEY");
    expect(deniedPreserveNames).toContain("UNKNOWN_TOKEN");
  });

  it("the final denylist removes a banned key even if pushed through preserveNames", () => {
    // Simulate a malicious MCP reference to a platform secret that somehow
    // passed the trusted check (it cannot, but assert structural safety).
    const { env } = buildAgentChildEnv(fullBridgeEnv(), { preserveNames: ["BRAINTRUST_API_KEY"] });
    expect(env.BRAINTRUST_API_KEY).toBeUndefined();
  });

  it("withholds a future/unknown DD_* secret via the suffix pattern and explicit names", () => {
    const { env } = buildAgentChildEnv({ ...fullBridgeEnv(), DD_NEW_LEAK_KEY: "future" });
    expect(env.DD_NEW_LEAK_KEY).toBeUndefined();
  });

  it("strips a top-level customer credential whose name is not allowlisted (runtimeCredentialEnvs spread)", () => {
    const { env } = buildAgentChildEnv({ ...fullBridgeEnv(), MY_APP_DATABASE_URL: "postgres://secret" });
    expect(env.MY_APP_DATABASE_URL).toBeUndefined();
  });

  it("preserves marked repo runtime env vars, including customer secret-shaped names", () => {
    const { env } = buildAgentChildEnv({
      ...fullBridgeEnv(),
      [ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV]: JSON.stringify([
        "NGROK_AUTH_TOKEN",
        "NGROK_DOMAIN",
        "GITHUB_APP_ID",
        "SANDBOX_AUTH_TOKEN",
        "NODE_OPTIONS",
        "CODEX_CLI_PATH",
        "CODEX_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "JAVA_TOOL_OPTIONS",
        "RUBYOPT",
        "PYTHONSTARTUP",
        "OPENAI_API_KEY",
      ]),
      NGROK_AUTH_TOKEN: "ngrok-secret",
      NGROK_DOMAIN: "dev.example.ngrok-free.dev",
      GITHUB_APP_ID: "123456",
      NODE_OPTIONS: "--require ./pwn.js",
      LD_PRELOAD: "/tmp/preload.so",
      DYLD_INSERT_LIBRARIES: "/tmp/insert.dylib",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/agent.jar",
      RUBYOPT: "-r/tmp/hook.rb",
      PYTHONSTARTUP: "/tmp/startup.py",
    });

    expect(env.NGROK_AUTH_TOKEN).toBe("ngrok-secret");
    expect(env.NGROK_DOMAIN).toBe("dev.example.ngrok-free.dev");
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.SANDBOX_AUTH_TOKEN).toBeUndefined();
    expect(env[ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV]).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(env.RUBYOPT).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("blocks execution-control names from the repo runtime env allow path", () => {
    for (const name of [
      "CODEX_CLI_PATH",
      "CODEX_PATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "JAVA_TOOL_OPTIONS",
      "RUBYOPT",
      "PYTHONSTARTUP",
      "ARCANIST_TERRAFORM_PLAN_TOKEN",
      "ARCANIST_REAL_GIT_PATH",
      "ARCANIST_REAL_GH_PATH",
    ]) {
      expect(isAgentVisibleRepoRuntimeEnvName(name), name).toBe(false);
    }
  });

  it("buildRepoCommandEnv yields the same allowlist with no provider key", () => {
    const env = buildRepoCommandEnv(fullBridgeEnv());
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DD_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ARCANIST_PREVIEW_CONTRACT_JSON).toBeUndefined();
    expect(env.SANDBOX_AUTH_TOKEN).toBeUndefined();
    expect(env.ARCANIST_REAL_GIT_PATH).toBeUndefined();
    expect(env.ARCANIST_REAL_GH_PATH).toBeUndefined();
  });
});
