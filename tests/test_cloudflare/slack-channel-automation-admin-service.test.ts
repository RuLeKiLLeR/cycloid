import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGateGithubSessionStart = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: mockGateGithubSessionStart,
}));

import {
  defaultSlackAlertPrompt,
  saveSlackAlertAutomationRule,
  SlackChannelAutomationAdminError,
  updateSlackAlertAutomationRule,
} from "../../apps/control-plane-worker/src/automation/slack-channel-admin-service";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function buildEnv(sqlite: Database.Database): Env {
  return {
    DB: new SqliteD1(sqlite) as unknown as D1Database,
  } as Env;
}

describe("Slack channel automation admin service", () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    env = buildEnv(sqlite);
    mockGateGithubSessionStart.mockReset();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 12345 });
  });

  it("uses triage-first defaults for Slack alert automation prompts", () => {
    expect(defaultSlackAlertPrompt("datadog")).toContain("Investigate this Datadog alert before making changes.");
    expect(defaultSlackAlertPrompt("datadog")).toContain("First determine whether the alert is still firing");
    expect(defaultSlackAlertPrompt("datadog")).toContain("propose monitor tuning");
    expect(defaultSlackAlertPrompt("datadog")).toContain(
      "implement it only if this repository manages its Datadog monitors as code",
    );
    expect(defaultSlackAlertPrompt("datadog")).toContain("use a PR title that describes the actual change");

    expect(defaultSlackAlertPrompt("sentry")).toContain("Investigate this Sentry alert before making changes.");
    expect(defaultSlackAlertPrompt("sentry")).toContain("First determine whether the issue is still active");
    expect(defaultSlackAlertPrompt("sentry")).toContain("propose alert tuning or deletion");
    expect(defaultSlackAlertPrompt("sentry")).toContain("use a PR title that describes the actual change");
  });

  it("saves a detected sender as an enabled Slack alert automation rule", async () => {
    await expect(
      saveSlackAlertAutomationRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        teamId: "T_ALERTS",
        channelId: "C_ALERTS",
        provider: "datadog",
        appIds: ["A_DATADOG"],
        botIds: ["B_DATADOG"],
        repoOwner: "trycycloid",
        repoName: "cycloid",
        modelId: "kimi-k2.7-code",
        nowMs: 2000,
      }),
    ).resolves.toMatchObject({
      businessId: "biz-a",
      configuredByUserId: "42",
      triggerProvider: "datadog",
      slackTeamId: "T_ALERTS",
      slackChannelId: "C_ALERTS",
      allowedSlackAppIds: ["A_DATADOG"],
      allowedSlackBotIds: ["B_DATADOG"],
      repoOwner: "trycycloid",
      repoName: "cycloid",
      installationId: 12345,
      modelId: "kimi-k2.7-code",
      enabled: true,
      promptTemplate: expect.stringContaining("First determine whether the alert is still firing"),
    });

    expect(mockGateGithubSessionStart).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: "42",
        businessId: "biz-a",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    );
    const row = sqlite.prepare("SELECT * FROM automation_rules WHERE business_id = ?").get("biz-a") as {
      configured_by_user_id: string;
      trigger_provider: string;
      allowed_slack_app_ids_json: string;
      allowed_slack_bot_ids_json: string;
      model_id: string;
      enabled: number;
    };
    expect(row).toMatchObject({
      configured_by_user_id: "42",
      trigger_provider: "datadog",
      allowed_slack_app_ids_json: JSON.stringify(["A_DATADOG"]),
      allowed_slack_bot_ids_json: JSON.stringify(["B_DATADOG"]),
      model_id: "kimi-k2.7-code",
      enabled: 1,
    });
  });

  it("rejects unsupported Slack alert automation models", async () => {
    await expect(
      saveSlackAlertAutomationRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        teamId: "T_ALERTS",
        channelId: "C_ALERTS",
        provider: "datadog",
        appIds: ["A_DATADOG"],
        botIds: ["B_DATADOG"],
        repoOwner: "trycycloid",
        repoName: "cycloid",
        modelId: "not-a-model",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_model",
    } satisfies Partial<SlackChannelAutomationAdminError>);

    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
  });

  it("rejects rules with no detected Slack sender IDs", async () => {
    await expect(
      saveSlackAlertAutomationRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        teamId: "T_ALERTS",
        channelId: "C_ALERTS",
        provider: "datadog",
        appIds: [],
        botIds: [],
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "missing_sender",
    } satisfies Partial<SlackChannelAutomationAdminError>);

    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
  });

  it("keeps createdAt stable when updating an existing rule", async () => {
    const first = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: ["B_DATADOG"],
      repoOwner: "trycycloid",
      repoName: "cycloid",
      nowMs: 2000,
    });
    const second = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: ["B_DATADOG_NEW"],
      repoOwner: "trycycloid",
      repoName: "cycloid",
      nowMs: 3000,
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(2000);
    expect(second.updatedAt).toBe(3000);
    expect(second.allowedSlackBotIds).toEqual(["B_DATADOG_NEW"]);
  });

  it("allows a different admin to disable a rule without changing its execution owner or gating the broken repo", async () => {
    const current = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: [],
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    mockGateGithubSessionStart.mockReset();
    mockGateGithubSessionStart.mockRejectedValue(new Error("repo unavailable"));

    await expect(
      updateSlackAlertAutomationRule(env, {
        callerUserId: "99",
        businessId: "biz-a",
        ruleId: current.id,
        enabled: false,
      }),
    ).resolves.toMatchObject({ configuredByUserId: "42", enabled: false, installationId: 12345 });
    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
  });

  it("gates a resumed rule using its original execution owner", async () => {
    const current = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: [],
      repoOwner: "trycycloid",
      repoName: "cycloid",
      enabled: false,
    });
    mockGateGithubSessionStart.mockClear();

    await updateSlackAlertAutomationRule(env, {
      callerUserId: "99",
      businessId: "biz-a",
      ruleId: current.id,
      enabled: true,
    });

    expect(mockGateGithubSessionStart).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ userId: "42", repoOwner: "trycycloid", repoName: "cycloid" }),
    );
  });

  it("does not collapse distinct repo identities into the same rule id", async () => {
    const first = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: [],
      repoOwner: "foo",
      repoName: "bar-baz",
      nowMs: 2000,
    });
    const second = await saveSlackAlertAutomationRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      teamId: "T_ALERTS",
      channelId: "C_ALERTS",
      provider: "datadog",
      appIds: ["A_DATADOG"],
      botIds: [],
      repoOwner: "foo-bar",
      repoName: "baz",
      nowMs: 3000,
    });

    expect(second.id).not.toBe(first.id);
    const rows = sqlite
      .prepare(
        "SELECT repo_owner, repo_name FROM automation_rules WHERE business_id = ? ORDER BY repo_owner, repo_name",
      )
      .all("biz-a");
    expect(rows).toEqual([
      { repo_owner: "foo", repo_name: "bar-baz" },
      { repo_owner: "foo-bar", repo_name: "baz" },
    ]);
  });

  it("fails closed when the selected repository cannot start sessions", async () => {
    mockGateGithubSessionStart.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: {
        ok: false,
        error: "integration_blocked",
        stage: "provider_probe",
        reasonCode: "repo_access_denied",
        userMessage: "Repo unavailable",
      },
    });

    await expect(
      saveSlackAlertAutomationRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        teamId: "T_ALERTS",
        channelId: "C_ALERTS",
        provider: "sentry",
        appIds: ["A_SENTRY"],
        botIds: [],
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "repo_not_available",
    } satisfies Partial<SlackChannelAutomationAdminError>);

    const count = sqlite.prepare("SELECT COUNT(*) as count FROM automation_rules").get() as { count: number };
    expect(count.count).toBe(2);
  });
});
