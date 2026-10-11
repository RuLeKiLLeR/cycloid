import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = path.resolve(import.meta.dirname, "../../scripts/validate-control-plane-secrets.mjs");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSecrets(secrets: Record<string, string>): string {
  const repoDir = mkdtempSync(path.join(tmpdir(), "control-plane-secrets-"));
  tempDirs.push(repoDir);
  const filePath = path.join(repoDir, "secrets.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(secrets));
  return filePath;
}

function baseSecrets(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    E2B_API_KEY: "cloud-key",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    JIRA_OAUTH_CLIENT_ID: "jira-client-id",
    JIRA_OAUTH_CLIENT_SECRET: "jira-client-secret",
    LINEAR_OAUTH_CLIENT_ID: "linear-client-id",
    LINEAR_OAUTH_CLIENT_SECRET: "linear-client-secret",
    NOTION_OAUTH_CLIENT_ID: "notion-client-id",
    NOTION_OAUTH_CLIENT_SECRET: "notion-client-secret",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    SANDBOX_RUNTIME_CLEANUP_SECRET: "cleanup-secret",
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    TURNSTILE_SITE_KEY: "turnstile-site-key",
    // Prod wrangler [vars] has FREESTYLE_SANDBOX_BACKEND_OVERRIDE set, so the
    // default --env=production validation requires a real Freestyle key.
    FREESTYLE_API_KEY: "freestyle-key",
    ...overrides,
  };
}

describe("control-plane secret validation", () => {
  it("accepts a complete set of base secrets", () => {
    const filePath = writeSecrets(baseSecrets());

    expect(() => execFileSync("node", [scriptPath, filePath], { encoding: "utf-8" })).not.toThrow();
  });

  it("requires all base secrets to be present", () => {
    const filePath = writeSecrets(
      baseSecrets({ SANDBOX_CALLBACK_SECRET: "", SANDBOX_RUNTIME_CLEANUP_SECRET: "CHANGE_ME" }),
    );

    let error: (Error & { stderr?: Buffer }) | undefined;
    try {
      execFileSync("node", [scriptPath, filePath], { encoding: "utf-8", stdio: "pipe" });
    } catch (err) {
      error = err as Error & { stderr?: Buffer };
    }

    expect(error).toBeDefined();
    const stderr = error?.stderr?.toString() ?? "";
    expect(stderr).toContain("SANDBOX_CALLBACK_SECRET");
    expect(stderr).toContain("SANDBOX_RUNTIME_CLEANUP_SECRET");
  });

  it("reports the public Turnstile site key as required config", () => {
    const filePath = writeSecrets(baseSecrets({ TURNSTILE_SITE_KEY: "" }));

    let error: (Error & { stderr?: Buffer }) | undefined;
    try {
      execFileSync("node", [scriptPath, filePath], { encoding: "utf-8", stdio: "pipe" });
    } catch (err) {
      error = err as Error & { stderr?: Buffer };
    }

    expect(error).toBeDefined();
    const stderr = error?.stderr?.toString() ?? "";
    expect(stderr).toContain("Missing required SSM-backed Worker config values: TURNSTILE_SITE_KEY");
    expect(stderr).not.toContain("Missing required SSM-backed Worker secrets: TURNSTILE_SITE_KEY");
  });

  it("requires OAuth client IDs and secrets for deployable control-plane config", () => {
    const filePath = writeSecrets(
      baseSecrets({
        GITHUB_CLIENT_ID: "",
        LINEAR_OAUTH_CLIENT_ID: "CHANGE_ME",
        SLACK_CLIENT_ID: " ",
      }),
    );

    let error: (Error & { stderr?: Buffer }) | undefined;
    try {
      execFileSync("node", [scriptPath, filePath], { encoding: "utf-8", stdio: "pipe" });
    } catch (err) {
      error = err as Error & { stderr?: Buffer };
    }

    expect(error).toBeDefined();
    const stderr = error?.stderr?.toString() ?? "";
    expect(stderr).toContain("Missing required SSM-backed OAuth config");
    expect(stderr).toContain("GITHUB_CLIENT_ID");
    expect(stderr).toContain("LINEAR_OAUTH_CLIENT_ID");
    expect(stderr).toContain("SLACK_CLIENT_ID");
  });

  it("can validate a limited OAuth provider set for QA rollout", () => {
    const filePath = writeSecrets(
      baseSecrets({
        JIRA_OAUTH_CLIENT_ID: "CHANGE_ME",
        JIRA_OAUTH_CLIENT_SECRET: "CHANGE_ME",
        NOTION_OAUTH_CLIENT_ID: "CHANGE_ME",
        NOTION_OAUTH_CLIENT_SECRET: "CHANGE_ME",
      }),
    );

    expect(() =>
      execFileSync("node", [scriptPath, filePath, "--oauth=github,linear,slack"], { encoding: "utf-8" }),
    ).not.toThrow();
  });

  it("still fails the limited QA OAuth provider set when one of those providers is missing", () => {
    const filePath = writeSecrets(
      baseSecrets({
        LINEAR_OAUTH_CLIENT_SECRET: "CHANGE_ME",
        JIRA_OAUTH_CLIENT_ID: "CHANGE_ME",
        JIRA_OAUTH_CLIENT_SECRET: "CHANGE_ME",
        NOTION_OAUTH_CLIENT_ID: "CHANGE_ME",
        NOTION_OAUTH_CLIENT_SECRET: "CHANGE_ME",
      }),
    );

    let error: (Error & { stderr?: Buffer }) | undefined;
    try {
      execFileSync("node", [scriptPath, filePath, "--oauth=github,linear,slack"], {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err) {
      error = err as Error & { stderr?: Buffer };
    }

    expect(error).toBeDefined();
    const stderr = error?.stderr?.toString() ?? "";
    expect(stderr).toContain("LINEAR_OAUTH_CLIENT_SECRET");
    expect(stderr).not.toContain("JIRA_OAUTH_CLIENT_ID");
    expect(stderr).not.toContain("NOTION_OAUTH_CLIENT_ID");
  });
});

describe("freestyle key requirement", () => {
  // Build a throwaway repo whose wrangler.toml drives the per-env override, then run
  // the validator with cwd set there (it reads apps/control-plane-worker/wrangler.toml
  // relative to cwd). Exercises the whole path: wrangler read -> conditional require.
  function fixtureRepo(
    prodOverride: string,
    qaOverride: string,
    { prodSnapshotId = "snap-prod", qaSnapshotId = "" }: { prodSnapshotId?: string; qaSnapshotId?: string } = {},
  ): string {
    const repo = mkdtempSync(path.join(tmpdir(), "cp-freestyle-"));
    tempDirs.push(repo);
    const tomlPath = path.join(repo, "apps", "control-plane-worker", "wrangler.toml");
    mkdirSync(path.dirname(tomlPath), { recursive: true });
    writeFileSync(
      tomlPath,
      [
        "[vars]",
        `FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "${prodOverride}"`,
        `FREESTYLE_DEFAULT_SNAPSHOT_ID = "${prodSnapshotId}"`,
        "",
        "[env.qa.vars]",
        `FREESTYLE_SANDBOX_BACKEND_OVERRIDE = "${qaOverride}"`,
        `FREESTYLE_DEFAULT_SNAPSHOT_ID = "${qaSnapshotId}"`,
        "",
      ].join("\n"),
    );
    return repo;
  }

  function run(secrets: Record<string, string>, args: string[], cwd: string): { ok: boolean; stderr: string } {
    const filePath = writeSecrets(secrets);
    try {
      execFileSync("node", [scriptPath, filePath, ...args], { encoding: "utf-8", stdio: "pipe", cwd });
      return { ok: true, stderr: "" };
    } catch (err) {
      const e = err as Error & { stderr?: Buffer };
      return { ok: false, stderr: e.stderr?.toString() ?? "" };
    }
  }

  it("fails prod validation when routing is on but the key is missing/placeholder", () => {
    const repo = fixtureRepo("org:trycycloid", "");
    const missing = run(baseSecrets({ FREESTYLE_API_KEY: "" }), ["--env=production"], repo);
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("FREESTYLE_API_KEY is missing");

    const placeholder = run(baseSecrets({ FREESTYLE_API_KEY: "CHANGE_ME" }), ["--env=production"], repo);
    expect(placeholder.ok).toBe(false);
    expect(placeholder.stderr).toContain("FREESTYLE_API_KEY is missing");
  });

  it("passes prod validation when routing is on and the key is real", () => {
    const repo = fixtureRepo("org:trycycloid", "");
    expect(run(baseSecrets({ FREESTYLE_API_KEY: "real-key" }), ["--env=production"], repo).ok).toBe(true);
  });

  it("does not require the key when the env override is unset (QA on E2B)", () => {
    const repo = fixtureRepo("org:trycycloid", "");
    expect(run(baseSecrets({ FREESTYLE_API_KEY: "" }), ["--env=qa", "--oauth=github,linear,slack"], repo).ok).toBe(
      true,
    );
  });

  it("fails prod validation when routing is on but the snapshot id is missing (ARC-1480)", () => {
    // A real key + no snapshot id used to deploy green and cold-boot every routed
    // session onto bare Debian. Same conditional as the key requirement.
    const repo = fixtureRepo("org:trycycloid", "", { prodSnapshotId: "" });
    const missing = run(baseSecrets(), ["--env=production"], repo);
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("FREESTYLE_DEFAULT_SNAPSHOT_ID is missing");

    const placeholder = fixtureRepo("org:trycycloid", "", { prodSnapshotId: "CHANGE_ME" });
    expect(run(baseSecrets(), ["--env=production"], placeholder).ok).toBe(false);
  });

  it("does not require the snapshot id when the env override is unset (QA on E2B)", () => {
    const repo = fixtureRepo("org:trycycloid", "", { prodSnapshotId: "snap-prod", qaSnapshotId: "" });
    expect(run(baseSecrets({ FREESTYLE_API_KEY: "" }), ["--env=qa", "--oauth=github,linear,slack"], repo).ok).toBe(
      true,
    );
  });

  it("--freestyle-only asserts the Freestyle checks with only FREESTYLE_API_KEY in hand", () => {
    // This mode feeds just { FREESTYLE_API_KEY } — no base/oauth/turnstile. Without
    // --freestyle-only that bundle would fail on the missing base secrets; with it,
    // only the routing-conditional Freestyle checks run. No workflow invokes the flag
    // since #7017 removed the always-on deploy step (IAM); the mode is kept for the
    // safe reimplementation tracked under ARC-1474, so its contract stays pinned here.
    const repo = fixtureRepo("org:trycycloid", "");
    // Routing on + key missing/placeholder => fail closed, and NOT because of base secrets.
    const missing = run({ FREESTYLE_API_KEY: "" }, ["--env=production", "--freestyle-only"], repo);
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("FREESTYLE_API_KEY is missing");
    expect(missing.stderr).not.toContain("Missing required SSM-backed Worker secrets");
    expect(run({ FREESTYLE_API_KEY: "CHANGE_ME" }, ["--env=production", "--freestyle-only"], repo).ok).toBe(false);
    // Routing on + real key => passes even though no other secrets are present.
    expect(run({ FREESTYLE_API_KEY: "real-key" }, ["--env=production", "--freestyle-only"], repo).ok).toBe(true);
    // Routing on + real key but no snapshot id => this mode also fails closed on
    // the cold-boot config gap (ARC-1480).
    const noSnapshotRepo = fixtureRepo("org:trycycloid", "", { prodSnapshotId: "" });
    const noSnapshot = run({ FREESTYLE_API_KEY: "real-key" }, ["--env=production", "--freestyle-only"], noSnapshotRepo);
    expect(noSnapshot.ok).toBe(false);
    expect(noSnapshot.stderr).toContain("FREESTYLE_DEFAULT_SNAPSHOT_ID is missing");
    // Routing off (override empty) => no-op pass with an empty bundle.
    const offRepo = fixtureRepo("", "", { prodSnapshotId: "" });
    expect(run({}, ["--env=production", "--freestyle-only"], offRepo).ok).toBe(true);
  });
});
