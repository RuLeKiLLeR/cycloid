// Service-layer tests for createScheduledRule: validation, repo gate fail-closed,
// rule-cap enforcement, cron normalization, name sanitization, duplicate handling.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGate = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGate(...args),
}));

const mockResolveBotToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/slack/tokens", () => ({
  resolveInstalledSlackBotToken: (...args: unknown[]) => mockResolveBotToken(...args),
}));

const mockGetConversationInfo = vi.fn();
vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  getConversationInfo: (...args: unknown[]) => mockGetConversationInfo(...args),
}));

const mockGetWorkspaceMetadata = vi.fn();
vi.mock("../../apps/control-plane-worker/src/slack/workspaces", () => ({
  getWorkspaceInstallMetadata: (...args: unknown[]) => mockGetWorkspaceMetadata(...args),
}));

const mockFetchRepoSkills = vi.fn();
vi.mock("../../apps/control-plane-worker/src/github/skills", () => ({
  fetchRepoSkills: (...args: unknown[]) => mockFetchRepoSkills(...args),
}));

import {
  getScheduledRuleById,
  insertScheduledRuleIfBusinessUnderEnabledCap,
  type InsertScheduledRuleInput,
} from "../../apps/control-plane-worker/src/automation/db";
import {
  canDeleteScheduledRule,
  createScheduledRule,
  deleteScheduledRule,
  listScheduledRulesForBusiness,
  ScheduledRuleServiceError,
} from "../../apps/control-plane-worker/src/automation/service";
import { AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS } from "../../apps/control-plane-worker/src/constants/automation";
import type { Env } from "../../apps/control-plane-worker/src/types";

// Setup helper: seed a rule unconditionally with an effectively unlimited cap.
async function insertScheduledRule(db: D1Database, input: InsertScheduledRuleInput): Promise<void> {
  await insertScheduledRuleIfBusinessUnderEnabledCap(db, input, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }
}

function makeEnv(d1: SqliteD1): Env {
  return { DB: d1 as unknown } as unknown as Env;
}

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // Thursday

const validInput = (overrides: Record<string, unknown> = {}) => ({
  callerUserId: "42",
  businessId: "biz-a",
  repoOwner: "acme",
  repoName: "webapp",
  cron: "0 14 * * 1-5",
  prompt: "Review failing tests and fix the safe ones.",
  ...overrides,
});

describe("createScheduledRule", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
    // Default Slack mocks to a healthy channel the bot belongs to; negative
    // Slack cases override per-test. Rules with no Slack target never call these.
    mockResolveBotToken.mockReset();
    mockResolveBotToken.mockResolvedValue("xoxb-test-token");
    mockGetConversationInfo.mockReset();
    mockGetConversationInfo.mockResolvedValue({
      id: "C456",
      name: "changelog",
      isChannel: true,
      isPrivate: false,
      isIm: false,
      isMpim: false,
      isMember: true,
    });
    // Default: the workspace for the target team belongs to the caller's business.
    mockGetWorkspaceMetadata.mockReset();
    mockGetWorkspaceMetadata.mockResolvedValue({ teamId: "T123", businessId: "biz-a", botUserId: "U1" });
    mockFetchRepoSkills.mockReset();
    mockFetchRepoSkills.mockResolvedValue([]);
  });

  it("persists a valid rule with normalized cron and next-fire-at computed", async () => {
    const rule = await createScheduledRule(env, validInput({ name: "Weekday tests" }), {
      now: () => NOW,
      idGenerator: () => "rule-1",
    });
    expect(rule.id).toBe("rule-1");
    expect(rule.normalizedCron).toBe("0 14 * * 1,2,3,4,5");
    expect(rule.name).toBe("Weekday tests");
    expect(rule.installationId).toBe(12345);
    expect(rule.enabled).toBe(true);
    // 2026-01-01 is Thursday 12:00; next 14:00 weekday is same day.
    expect(rule.nextFireAt).toBe(Date.UTC(2026, 0, 1, 14, 0, 0));

    expect(mockGate).toHaveBeenCalledOnce();
    const gateArgs = mockGate.mock.calls[0][1] as { userId: string; businessId: string };
    expect(gateArgs.userId).toBe("42");
    expect(gateArgs.businessId).toBe("biz-a");
  });

  it("defaults modelId to null when none is provided (backend default model)", async () => {
    const rule = await createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "rule-null" });
    expect(rule.modelId).toBeNull();
  });

  it("stores a codex-backend model id (no gating for the default backend)", async () => {
    const rule = await createScheduledRule(env, validInput({ modelId: "gpt-5.4" }), {
      now: () => NOW,
      idGenerator: () => "rule-codex",
    });
    expect(rule.modelId).toBe("gpt-5.4");
  });

  it("allows a Claude model for a non-internal business", async () => {
    const rule = await createScheduledRule(env, validInput({ modelId: "claude-opus-4-8" }), {
      now: () => NOW,
      idGenerator: () => "rule-opus",
    });
    expect(rule.modelId).toBe("claude-opus-4-8");
  });

  it("allows an opencode model for a non-internal business", async () => {
    const rule = await createScheduledRule(env, validInput({ modelId: "kimi-k2.7-code" }), {
      now: () => NOW,
      idGenerator: () => "rule-glm",
    });
    expect(rule.modelId).toBe("kimi-k2.7-code");
  });

  it("rejects an unknown model with 400 invalid_model", async () => {
    await expect(
      createScheduledRule(env, validInput({ modelId: "totally-made-up-model" }), { now: () => NOW }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_model" });
  });

  it("rejects sub-5-minute cron with 400 invalid_cron", async () => {
    await expect(createScheduledRule(env, validInput({ cron: "* * * * *" }), { now: () => NOW })).rejects.toMatchObject(
      { status: 400, code: "invalid_cron" },
    );
  });

  it("rejects a syntactically valid but never-occurring cron with 400, not a 500", async () => {
    // `0 0 30 2 *` (Feb 30) parses field-by-field but has no fire time. The raw
    // CronValidationError from computeNextFireAt must be translated to a 400
    // ScheduledRuleServiceError, not escape as an unexpected error (-> route 500),
    // and the GitHub preflight must not run for an unschedulable rule.
    await expect(
      createScheduledRule(env, validInput({ cron: "0 0 30 2 *" }), { now: () => NOW }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_cron" });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("rejects control characters in name", async () => {
    await expect(createScheduledRule(env, validInput({ name: "badname" }), { now: () => NOW })).rejects.toMatchObject({
      status: 400,
      code: "invalid_name",
    });
  });

  it("rejects names exceeding the max length", async () => {
    await expect(
      createScheduledRule(env, validInput({ name: "x".repeat(81) }), { now: () => NOW }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_name" });
  });

  it("rejects empty prompts", async () => {
    await expect(createScheduledRule(env, validInput({ prompt: "   " }), { now: () => NOW })).rejects.toMatchObject({
      status: 400,
      code: "invalid_prompt",
    });
  });

  it("accepts a leading repo skill command when the skill exists", async () => {
    mockFetchRepoSkills.mockResolvedValue([{ name: "audit-prod-docs", description: "", content: "" }]);

    const rule = await createScheduledRule(env, validInput({ prompt: "/audit-prod-docs" }), {
      now: () => NOW,
      idGenerator: () => "rule-skill",
    });

    expect(rule.promptTemplate).toBe("/audit-prod-docs");
    expect(mockFetchRepoSkills).toHaveBeenCalledWith(env, "42", "acme", "webapp");
  });

  it("rejects an unknown leading repo skill command", async () => {
    mockFetchRepoSkills.mockResolvedValue([{ name: "other-skill", description: "", content: "" }]);

    await expect(
      createScheduledRule(env, validInput({ prompt: "/audit-prod-docs" }), {
        now: () => NOW,
        idGenerator: () => "rule-bad-skill",
      }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_skill" });
  });

  it("rejects invalid repo segments", async () => {
    await expect(
      createScheduledRule(env, validInput({ repoOwner: "bad owner" }), { now: () => NOW }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_repo" });
  });

  it("returns 404 repo_not_available when the integration gate fails", async () => {
    mockGate.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: "provider_probe",
        reasonCode: "repo_not_accessible",
        userMessage: "no",
      },
    });
    await expect(createScheduledRule(env, validInput(), { now: () => NOW })).rejects.toMatchObject({
      status: 404,
      code: "repo_not_available",
    });
  });

  it("enforces the per-business rule cap", async () => {
    // Pre-seed up to the cap.
    for (let i = 0; i < AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS; i++) {
      await insertScheduledRule(env.DB, {
        id: `pre-${i}`,
        businessId: "biz-a",
        configuredByUserId: "42",
        repoOwner: "acme",
        repoName: `repo-${i}`,
        installationId: 1,
        promptTemplate: "x",
        cronExpression: "0 14 * * 1-5",
        normalizedCron: `0 14 * * ${i},2,3,4,5`,
        name: null,
        nextFireAt: NOW + 1000,
        createdAt: NOW,
      });
    }
    await expect(createScheduledRule(env, validInput(), { now: () => NOW })).rejects.toMatchObject({
      status: 409,
      code: "rule_cap_reached",
    });
    // Cap check happens before the gate is called.
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("enforces the per-business rule cap when another create fills the cap after preflight", async () => {
    mockGate.mockImplementationOnce(async () => {
      for (let i = 0; i < AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS; i++) {
        await insertScheduledRule(env.DB, {
          id: `concurrent-${i}`,
          businessId: "biz-a",
          configuredByUserId: "42",
          repoOwner: "acme",
          repoName: `concurrent-repo-${i}`,
          installationId: 1,
          promptTemplate: "x",
          cronExpression: "0 14 * * 1-5",
          normalizedCron: `0 14 * * ${i},2,3,4,5`,
          name: null,
          nextFireAt: NOW + 1000,
          createdAt: NOW,
        });
      }
      return { ok: true, installationId: 12345 };
    });

    await expect(
      createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "late-rule" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "rule_cap_reached",
    });
    expect(await getScheduledRuleById(env.DB, "late-rule", "biz-a")).toBeNull();
  });

  it("rejects duplicate active-identity inserts as 409 duplicate_rule", async () => {
    await createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "rule-1" });
    await expect(
      createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "rule-2" }),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_rule" });
  });

  it("uses the normalized cron for duplicate detection (named days collapse)", async () => {
    await createScheduledRule(env, validInput({ cron: "0 14 * * 1-5" }), {
      now: () => NOW,
      idGenerator: () => "rule-1",
    });
    await expect(
      createScheduledRule(env, validInput({ cron: "0 14 * * mon-fri" }), {
        now: () => NOW,
        idGenerator: () => "rule-2",
      }),
    ).rejects.toBeInstanceOf(ScheduledRuleServiceError);
  });

  describe("Slack delivery target", () => {
    const withSlack = (overrides: Record<string, unknown> = {}) =>
      validInput({ slackTeamId: "T123", slackChannelId: "C456", ...overrides });

    it("persists the delivery target when the bot is a channel member", async () => {
      const rule = await createScheduledRule(env, withSlack(), { now: () => NOW, idGenerator: () => "rule-1" });
      expect(rule).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });
      const stored = await getScheduledRuleById(env.DB, "rule-1", "biz-a");
      expect(stored).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });
      expect(mockResolveBotToken).toHaveBeenCalledWith(env, "T123");
      expect(mockGetConversationInfo).toHaveBeenCalledWith("xoxb-test-token", "C456");
    });

    it("rejects a delivery target whose workspace belongs to another business (tenancy fail-closed)", async () => {
      mockGetWorkspaceMetadata.mockResolvedValueOnce({ teamId: "T123", businessId: "biz-other", botUserId: "U1" });
      await expect(createScheduledRule(env, withSlack(), { now: () => NOW })).rejects.toMatchObject({
        status: 400,
        code: "slack_workspace_not_connected",
      });
      // Must fail before resolving or using the other business's bot token.
      expect(mockResolveBotToken).not.toHaveBeenCalled();
      expect(mockGetConversationInfo).not.toHaveBeenCalled();
    });

    it("rejects a delivery target for an unknown/uninstalled workspace", async () => {
      mockGetWorkspaceMetadata.mockResolvedValueOnce(null);
      await expect(createScheduledRule(env, withSlack(), { now: () => NOW })).rejects.toMatchObject({
        status: 400,
        code: "slack_workspace_not_connected",
      });
      expect(mockResolveBotToken).not.toHaveBeenCalled();
    });

    it("creates a rule with no delivery when neither team nor channel is given", async () => {
      const rule = await createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "rule-1" });
      expect(rule.slackTeamId).toBeNull();
      expect(rule.slackChannelId).toBeNull();
      expect(mockResolveBotToken).not.toHaveBeenCalled();
      expect(mockGetConversationInfo).not.toHaveBeenCalled();
    });

    it("rejects a channel without a team as 400 invalid_slack_target", async () => {
      await expect(
        createScheduledRule(env, withSlack({ slackTeamId: undefined }), { now: () => NOW }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_slack_target" });
      expect(mockResolveBotToken).not.toHaveBeenCalled();
    });

    it("rejects a team without a channel as 400 invalid_slack_target", async () => {
      await expect(
        createScheduledRule(env, withSlack({ slackChannelId: "   " }), { now: () => NOW }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_slack_target" });
    });

    it("fails closed when the workspace is not connected", async () => {
      mockResolveBotToken.mockResolvedValueOnce(null);
      await expect(createScheduledRule(env, withSlack(), { now: () => NOW })).rejects.toMatchObject({
        status: 400,
        code: "slack_workspace_not_connected",
      });
      expect(mockGetConversationInfo).not.toHaveBeenCalled();
    });

    it("fails closed when the channel is unavailable (unknown / private / API error)", async () => {
      mockGetConversationInfo.mockResolvedValueOnce(null);
      await expect(createScheduledRule(env, withSlack(), { now: () => NOW })).rejects.toMatchObject({
        status: 400,
        code: "slack_channel_unavailable",
      });
    });

    it("fails closed when the bot is not a member of the channel", async () => {
      mockGetConversationInfo.mockResolvedValueOnce({
        id: "C456",
        name: "changelog",
        isChannel: true,
        isPrivate: false,
        isIm: false,
        isMpim: false,
        isMember: false,
      });
      await expect(createScheduledRule(env, withSlack(), { now: () => NOW })).rejects.toMatchObject({
        status: 400,
        code: "slack_bot_not_in_channel",
      });
    });

    it("does not persist a rule when the Slack check fails closed", async () => {
      mockGetConversationInfo.mockResolvedValueOnce(null);
      await expect(
        createScheduledRule(env, withSlack(), { now: () => NOW, idGenerator: () => "rule-x" }),
      ).rejects.toMatchObject({ code: "slack_channel_unavailable" });
      expect(await getScheduledRuleById(env.DB, "rule-x", "biz-a")).toBeNull();
    });
  });
});

describe("deleteScheduledRule", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
  });

  it("lets the creator (non-admin) delete their own rule", async () => {
    await createScheduledRule(env, validInput({ callerUserId: "42" }), { now: () => NOW, idGenerator: () => "rule-1" });
    await deleteScheduledRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      ruleId: "rule-1",
      requesterIsBusinessAdmin: false,
    });
    expect(await getScheduledRuleById(env.DB, "rule-1", "biz-a")).toBeNull();
  });

  it("lets a business admin delete another member's rule", async () => {
    await createScheduledRule(env, validInput({ callerUserId: "42" }), { now: () => NOW, idGenerator: () => "rule-1" });
    await deleteScheduledRule(env, {
      callerUserId: "99",
      businessId: "biz-a",
      ruleId: "rule-1",
      requesterIsBusinessAdmin: true,
    });
    expect(await getScheduledRuleById(env.DB, "rule-1", "biz-a")).toBeNull();
  });

  it("denies a non-creator member with 403 forbidden and leaves the row intact", async () => {
    await createScheduledRule(env, validInput({ callerUserId: "42" }), { now: () => NOW, idGenerator: () => "rule-1" });
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "99",
        businessId: "biz-a",
        ruleId: "rule-1",
        requesterIsBusinessAdmin: false,
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await getScheduledRuleById(env.DB, "rule-1", "biz-a")).not.toBeNull();
  });

  it("throws 404 not_found for an unknown id", async () => {
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        ruleId: "missing",
        requesterIsBusinessAdmin: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("throws 404 not_found when the rule belongs to a different business", async () => {
    await createScheduledRule(env, validInput({ businessId: "biz-a" }), {
      now: () => NOW,
      idGenerator: () => "rule-1",
    });
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "99",
        businessId: "biz-b",
        ruleId: "rule-1",
        requesterIsBusinessAdmin: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await getScheduledRuleById(env.DB, "rule-1", "biz-a")).not.toBeNull();
  });

  it("does not let a cross-business admin delete another business's rule (404)", async () => {
    // Business scoping is enforced at the read: a `requesterIsBusinessAdmin` flag
    // for biz-b must not reach into biz-a's rule.
    await createScheduledRule(env, validInput({ businessId: "biz-a" }), {
      now: () => NOW,
      idGenerator: () => "rule-1",
    });
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "99",
        businessId: "biz-b",
        ruleId: "rule-1",
        requesterIsBusinessAdmin: true,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await getScheduledRuleById(env.DB, "rule-1", "biz-a")).not.toBeNull();
  });

  it("error class is ScheduledRuleServiceError", async () => {
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        ruleId: "missing",
        requesterIsBusinessAdmin: false,
      }),
    ).rejects.toBeInstanceOf(ScheduledRuleServiceError);
  });

  it("a second delete on the same id throws 404", async () => {
    // Guards against a future change replacing `changes === 1` with `>= 1`
    // in the DAO, which would silently make the second delete succeed.
    await createScheduledRule(env, validInput(), { now: () => NOW, idGenerator: () => "rule-1" });
    await deleteScheduledRule(env, {
      callerUserId: "42",
      businessId: "biz-a",
      ruleId: "rule-1",
      requesterIsBusinessAdmin: false,
    });
    await expect(
      deleteScheduledRule(env, {
        callerUserId: "42",
        businessId: "biz-a",
        ruleId: "rule-1",
        requesterIsBusinessAdmin: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("canDeleteScheduledRule", () => {
  it("allows a business admin regardless of creator", () => {
    expect(canDeleteScheduledRule({ configuredByUserId: "42" }, "99", true)).toBe(true);
  });

  it("allows the creator when not admin", () => {
    expect(canDeleteScheduledRule({ configuredByUserId: "42" }, "42", false)).toBe(true);
  });

  it("denies a non-creator member", () => {
    expect(canDeleteScheduledRule({ configuredByUserId: "42" }, "99", false)).toBe(false);
  });

  it("treats a null/empty creator as admin-delete-only (fail closed)", () => {
    expect(canDeleteScheduledRule({ configuredByUserId: null }, "42", false)).toBe(false);
    expect(canDeleteScheduledRule({ configuredByUserId: "" }, "42", false)).toBe(false);
    expect(canDeleteScheduledRule({ configuredByUserId: null }, "42", true)).toBe(true);
  });
});

describe("listScheduledRulesForBusiness", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
  });

  it("returns only rules for the requested business", async () => {
    await createScheduledRule(env, validInput({ businessId: "biz-a", repoName: "repo-1" }), {
      now: () => NOW,
      idGenerator: () => "a-1",
    });
    await createScheduledRule(env, validInput({ businessId: "biz-b", repoName: "repo-1" }), {
      now: () => NOW + 1,
      idGenerator: () => "b-1",
    });
    const result = await listScheduledRulesForBusiness(env, { businessId: "biz-a" });
    expect(result.items.map((r) => r.id)).toEqual(["a-1"]);
  });
});
