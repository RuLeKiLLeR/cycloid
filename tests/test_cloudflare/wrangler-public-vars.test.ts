import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const WRANGLER_TOML = "apps/control-plane-worker/wrangler.toml";

function parseTomlString(raw: string): string {
  return JSON.parse(`"${raw}"`) as string;
}

function readVarsSection(section: string): Record<string, string> {
  const text = readFileSync(WRANGLER_TOML, "utf8");
  const start = text.indexOf(`[${section}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const afterStart = text.slice(start).split("\n").slice(1);
  const vars: Record<string, string> = {};
  for (const line of afterStart) {
    if (/^\[[^\]]+\]/.test(line)) break;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*"((?:\\.|[^"])*)"\s*(?:#.*)?$/);
    if (match) vars[match[1]] = parseTomlString(match[2]);
  }
  return vars;
}

function readTopLevelBooleanSetting(key: string): boolean | null {
  const text = readFileSync(WRANGLER_TOML, "utf8");
  for (const line of text.split("\n")) {
    if (/^\[[^\]]+\]/.test(line)) break;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`));
    if (match) return match[1] === "true";
  }
  return null;
}

function readBooleanSetting(section: string, key: string): boolean | null {
  const text = readFileSync(WRANGLER_TOML, "utf8");
  const start = text.indexOf(`[${section}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const afterStart = text.slice(start).split("\n").slice(1);
  for (const line of afterStart) {
    if (/^\[[^\]]+\]/.test(line)) break;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`));
    if (match) return match[1] === "true";
  }
  return null;
}

function expectOnlyAllowedVarDifferences(prodVars: Record<string, string>, qaVars: Record<string, string>) {
  const prodKeys = new Set(Object.keys(prodVars));
  const qaKeys = new Set(Object.keys(qaVars));
  const prodOnly = [...prodKeys].filter((key) => !qaKeys.has(key));
  const qaOnly = [...qaKeys].filter((key) => !prodKeys.has(key));
  expect({ prodOnly, qaOnly }).toEqual({ prodOnly: [], qaOnly: [] });

  const allowedValueDifferences = new Set([
    // Environment identity must differ by deploy target.
    "WORKER_ENV",
    // Public hosts and OAuth callbacks must point at the matching UI/API host.
    "CONTROL_PLANE_URL",
    "FRONTEND_URL",
    // Prod allowlists the internal dogfood UI host for GitHub sign-in; QA has no
    // internal UI deploy, so it pins the var empty (resolver treats empty as absent).
    "INTERNAL_FRONTEND_URL",
    "GITHUB_CALLBACK_URL",
    "JIRA_OAUTH_CALLBACK_URL",
    "LINEAR_OAUTH_CALLBACK_URL",
    "NOTION_OAUTH_CALLBACK_URL",
    "SLACK_INSTALL_CALLBACK_URL",
    "SLACK_OAUTH_CALLBACK_URL",
    // QA disables synthetic health sessions to avoid background test sessions in pre-prod.
    "DATADOG_HEALTH_SYNTHETIC_ENABLED",
    "GITHUB_HEALTH_ENABLED",
    "SENTRY_HEALTH_SYNTHETIC_ENABLED",
    // QA uses the QA E2B template and intentionally has no prod repo snapshot pin.
    "E2B_SANDBOX_TEMPLATE",
    "E2B_REPO_SNAPSHOT_MAP_JSON",
    // Prod routes trycycloid-org sessions to Freestyle; QA stays on E2B (override
    // empty) and has no Freestyle snapshots pinned. Idle timeout matches, so only
    // these drift.
    "FREESTYLE_SANDBOX_BACKEND_OVERRIDE",
    "FREESTYLE_DEFAULT_SNAPSHOT_ID",
    "FREESTYLE_REPO_SNAPSHOT_MAP_JSON",
  ]);
  const unexpectedDifferences = [...prodKeys]
    .filter((key) => qaKeys.has(key))
    .filter((key) => prodVars[key] !== qaVars[key])
    .filter((key) => !allowedValueDifferences.has(key));
  expect(unexpectedDifferences).toEqual([]);
}

describe("wrangler public vars", () => {
  it("keeps Tier 1 non-secret prod config in wrangler vars", () => {
    expect(readVarsSection("vars")).toMatchObject({
      CONTROL_PLANE_URL: "https://api.trycycloid.com",
      JIRA_OAUTH_CALLBACK_URL: "https://app.trycycloid.com/auth/jira/callback",
      LINEAR_OAUTH_CALLBACK_URL: "https://app.trycycloid.com/auth/linear/callback",
      NOTION_OAUTH_CALLBACK_URL: "https://app.trycycloid.com/auth/notion/callback",
    });
  });

  it("keeps QA OAuth callbacks on the app host and the QA control plane on the API host", () => {
    expect(readVarsSection("env.qa.vars")).toMatchObject({
      CONTROL_PLANE_URL: "https://qa.trycycloid.com",
      JIRA_OAUTH_CALLBACK_URL: "https://qa.app.trycycloid.com/auth/jira/callback",
      LINEAR_OAUTH_CALLBACK_URL: "https://qa.app.trycycloid.com/auth/linear/callback",
      NOTION_OAUTH_CALLBACK_URL: "https://qa.app.trycycloid.com/auth/notion/callback",
    });
  });

  it("relies on the Datadog US5 fallback instead of a DD_SITE runtime var", () => {
    expect(readVarsSection("vars")).not.toHaveProperty("DD_SITE");
    expect(readVarsSection("env.qa.vars")).not.toHaveProperty("DD_SITE");
  });

  it("keeps prod and QA var surfaces in parity with only explained value drift", () => {
    const prodVars = readVarsSection("vars");
    const qaVars = readVarsSection("env.qa.vars");

    expect(prodVars.E2B_REPO_SNAPSHOT_MAP_JSON).toBe(
      '{"trycycloid/excalidraw-demo@main":{"snapshotId":"f5hkb65xmueiz9eme07e","allowPrivate":true}}',
    );
    expect(prodVars.FREESTYLE_REPO_SNAPSHOT_MAP_JSON).toBe(
      '{"trycycloid/cycloid":{"snapshotId":"sh-uxeq4e8pjym6o7zp5khx","allowPrivate":true}}',
    );
    expectOnlyAllowedVarDifferences(prodVars, qaVars);
  });

  it("keeps environment-specific hosts and worker identities explicit", () => {
    const prodVars = readVarsSection("vars");
    const qaVars = readVarsSection("env.qa.vars");

    expect(prodVars.WORKER_ENV).toBe("production");
    expect(qaVars.WORKER_ENV).toBe("qa");
    expect(prodVars.CONTROL_PLANE_URL).toBe("https://api.trycycloid.com");
    expect(prodVars.FRONTEND_URL).toBe("https://app.trycycloid.com");
    expect(qaVars.CONTROL_PLANE_URL).toBe("https://qa.trycycloid.com");
    expect(qaVars.FRONTEND_URL).toBe("https://qa.app.trycycloid.com");

    for (const key of Object.keys(prodVars).filter((varName) => varName.endsWith("_OAUTH_CALLBACK_URL"))) {
      expect(prodVars[key]).toContain("https://app.trycycloid.com/");
      expect(qaVars[key]).toContain("https://qa.app.trycycloid.com/");
    }
    expect(prodVars.GITHUB_CALLBACK_URL).toContain("https://app.trycycloid.com/");
    expect(qaVars.GITHUB_CALLBACK_URL).toContain("https://qa.app.trycycloid.com/");
    expect(prodVars.SLACK_INSTALL_CALLBACK_URL).toContain("https://app.trycycloid.com/");
    expect(qaVars.SLACK_INSTALL_CALLBACK_URL).toContain("https://qa.app.trycycloid.com/");
  });

  it("keeps production and QA control-plane logs enabled", () => {
    expect(readBooleanSetting("observability.logs", "enabled")).toBe(true);
    expect(readBooleanSetting("env.qa.observability.logs", "enabled")).toBe(true);
  });

  it("disables the workers.dev hostname for production and QA control-plane deploys", () => {
    expect(readTopLevelBooleanSetting("workers_dev")).toBe(false);
    expect(readBooleanSetting("env.qa", "workers_dev")).toBe(false);
  });

  // ARC-1480: enabling Freestyle routing without a snapshot id used to deploy
  // green and then cold-boot every routed session onto bare Debian (no bridge
  // bundle), failing them all at the 90s watchdog with no deploy-time signal.
  // The runtime now fails closed (buildRuntimeClientConfig throws), and this
  // check moves the signal to CI: the routing override and the snapshot id are
  // wrangler vars, invisible to validate-control-plane-secrets.mjs (SSM-only).
  it("requires a Freestyle snapshot id in any env that enables Freestyle routing", () => {
    for (const section of ["vars", "env.qa.vars"]) {
      const vars = readVarsSection(section);
      const overrideEnabled = (vars.FREESTYLE_SANDBOX_BACKEND_OVERRIDE ?? "").trim() !== "";
      if (overrideEnabled) {
        expect((vars.FREESTYLE_DEFAULT_SNAPSHOT_ID ?? "").trim(), `[${section}]`).not.toBe("");
      }
    }
  });
});
