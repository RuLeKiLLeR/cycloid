import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SlackChannelAutomationAdminError } from "../../apps/control-plane-worker/src/automation/slack-channel-admin-service";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import { slackChannelAutomationRoutes } from "../../apps/control-plane-worker/src/routes/slack-channel-automation";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

const mockListRules = vi.fn();
const mockDetectSenders = vi.fn();
const mockSaveRule = vi.fn();
const mockRemoveRule = vi.fn();
const mockUpdateRule = vi.fn();

vi.mock("../../apps/control-plane-worker/src/automation/slack-channel-admin-service", () => {
  class SlackChannelAutomationAdminError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly publicMessage: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(`${code}: ${publicMessage}`);
      this.name = "SlackChannelAutomationAdminError";
    }
  }

  return {
    SlackChannelAutomationAdminError,
    listSlackAlertAutomationSettings: (...args: unknown[]) => mockListRules(...args),
    detectSlackAlertAutomationSenders: (...args: unknown[]) => mockDetectSenders(...args),
    saveSlackAlertAutomationRule: (...args: unknown[]) => mockSaveRule(...args),
    removeSlackAlertAutomationRule: (...args: unknown[]) => mockRemoveRule(...args),
    updateSlackAlertAutomationRule: (...args: unknown[]) => mockUpdateRule(...args),
  };
});

const BUSINESS_ID = "biz-1";

function createEnv(): { sqlite: Database.Database; env: Env } {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE business_members (
      business_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (business_id, user_id)
    );
  `);
  return { sqlite, env: { DB: new SqliteD1(sqlite) as unknown as D1Database } as Env };
}

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user",
    canAccessAllSessions: false,
    user: { businessId: BUSINESS_ID } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

function routeFor(method: string, path: string): Route {
  const route = slackChannelAutomationRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!route) throw new Error(`Route not found for ${method} ${path}`);
  return route;
}

async function invoke(params: {
  method: string;
  path: string;
  env: Env;
  auth?: AuthInfo | null;
  body?: string | Record<string, unknown>;
}): Promise<Response> {
  const route = routeFor(params.method, params.path.split("?")[0]!);
  const body = typeof params.body === "string" ? params.body : params.body ? JSON.stringify(params.body) : undefined;
  const request = new Request(`https://example.com${params.path}`, {
    method: params.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body,
  });
  const match = new URL(request.url).pathname.match(route.pattern);
  return route.handler(request, params.env, match!, params.auth ?? makeAuth());
}

describe("slack channel automation routes", () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ sqlite, env } = createEnv());
    sqlite
      .prepare("INSERT INTO business_members (business_id, user_id, role) VALUES (?, ?, ?)")
      .run(BUSINESS_ID, 42, "admin");
  });

  it("lists rules for a business admin", async () => {
    mockListRules.mockResolvedValueOnce([{ id: "rule-1" }]);

    const response = await invoke({
      method: "GET",
      path: `/api/admin/slack-channel-automation?business_id=${BUSINESS_ID}`,
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, rules: [{ id: "rule-1" }] });
    expect(mockListRules).toHaveBeenCalledWith(env.DB, BUSINESS_ID);
  });

  it("detects senders and maps service validation errors", async () => {
    mockDetectSenders.mockResolvedValueOnce([{ id: "B123", label: "Datadog" }]);

    const response = await invoke({
      method: "GET",
      path: `/api/admin/slack-channel-automation/detect-senders?business_id=${BUSINESS_ID}&team_id=T1&channel_id=C1&provider=datadog`,
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, candidates: [{ id: "B123", label: "Datadog" }] });
    expect(mockDetectSenders).toHaveBeenCalledWith(env, {
      businessId: BUSINESS_ID,
      teamId: "T1",
      channelId: "C1",
      provider: "datadog",
    });

    mockDetectSenders.mockRejectedValueOnce(
      new SlackChannelAutomationAdminError(400, "invalid_provider", "provider must be datadog or sentry", {
        provider: "pagerduty",
      }),
    );
    const errorResponse = await invoke({
      method: "GET",
      path: `/api/admin/slack-channel-automation/detect-senders?business_id=${BUSINESS_ID}&team_id=T1&channel_id=C1&provider=pagerduty`,
      env,
    });

    expect(errorResponse.status).toBe(400);
    await expect(errorResponse.json()).resolves.toMatchObject({
      error: "provider must be datadog or sentry",
      code: "invalid_provider",
      details: { provider: "pagerduty" },
    });
  });

  it("saves a rule, accepts snake_case body fields, and maps service errors", async () => {
    mockSaveRule.mockResolvedValueOnce({ id: "rule-1", enabled: true });

    const response = await invoke({
      method: "POST",
      path: "/api/admin/slack-channel-automation",
      env,
      body: {
        business_id: BUSINESS_ID,
        team_id: "T1",
        channel_id: "C1",
        provider: "sentry",
        app_ids: ["A1"],
        repo_owner: "trycycloid",
        repo_name: "cycloid",
        model_id: "gpt-5.1-codex",
        prompt_template: "Investigate.",
        name: "Sentry alerts",
        enabled: true,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, rule: { id: "rule-1", enabled: true } });
    expect(mockSaveRule).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        callerUserId: "42",
        businessId: BUSINESS_ID,
        teamId: "T1",
        channelId: "C1",
        provider: "sentry",
        appIds: ["A1"],
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    );

    mockSaveRule.mockRejectedValueOnce(
      new SlackChannelAutomationAdminError(
        404,
        "repo_not_available",
        "Repository is not available for alert automation.",
      ),
    );
    const errorResponse = await invoke({
      method: "POST",
      path: "/api/admin/slack-channel-automation",
      env,
      body: { business_id: BUSINESS_ID },
    });

    expect(errorResponse.status).toBe(404);
    await expect(errorResponse.json()).resolves.toMatchObject({
      error: "Repository is not available for alert automation.",
      code: "repo_not_available",
    });
  });

  it("removes a rule and maps remove errors", async () => {
    mockRemoveRule.mockResolvedValueOnce(undefined);

    const response = await invoke({
      method: "DELETE",
      path: `/api/admin/slack-channel-automation/rule-1?business_id=${BUSINESS_ID}`,
      env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockRemoveRule).toHaveBeenCalledWith(env.DB, { businessId: BUSINESS_ID, ruleId: "rule-1" });

    mockRemoveRule.mockRejectedValueOnce(
      new SlackChannelAutomationAdminError(404, "not_found", "Slack alert automation rule was not found."),
    );
    const errorResponse = await invoke({
      method: "DELETE",
      path: `/api/admin/slack-channel-automation/missing?business_id=${BUSINESS_ID}`,
      env,
    });

    expect(errorResponse.status).toBe(404);
    await expect(errorResponse.json()).resolves.toMatchObject({
      error: "Slack alert automation rule was not found.",
      code: "not_found",
    });
  });

  it("updates a rule by immutable id", async () => {
    mockUpdateRule.mockResolvedValueOnce({ id: "rule-1", enabled: false });
    const response = await invoke({
      method: "PATCH",
      path: "/api/admin/slack-channel-automation/rule-1",
      env,
      body: { business_id: BUSINESS_ID, enabled: false },
    });
    expect(response.status).toBe(200);
    expect(mockUpdateRule).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ businessId: BUSINESS_ID, ruleId: "rule-1", enabled: false }),
    );
  });

  it("rejects missing or invalid request inputs before service calls", async () => {
    await expect(
      invoke({ method: "GET", path: "/api/admin/slack-channel-automation", env }).then((response) => response.json()),
    ).resolves.toMatchObject({ error: "business_id is required" });

    const invalidJson = await invoke({
      method: "POST",
      path: "/api/admin/slack-channel-automation",
      env,
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({ error: expect.stringContaining("Invalid input") });

    const missingBusiness = await invoke({
      method: "POST",
      path: "/api/admin/slack-channel-automation",
      env,
      body: { provider: "datadog" },
    });
    expect(missingBusiness.status).toBe(400);
    await expect(missingBusiness.json()).resolves.toMatchObject({ error: "business_id is required" });
    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockSaveRule).not.toHaveBeenCalled();
  });

  it("fails closed for non-admin business members", async () => {
    sqlite
      .prepare("UPDATE business_members SET role = 'member' WHERE business_id = ? AND user_id = ?")
      .run(BUSINESS_ID, 42);

    const response = await invoke({
      method: "GET",
      path: `/api/admin/slack-channel-automation?business_id=${BUSINESS_ID}`,
      env,
    });

    expect(response.status).toBe(403);
    expect(mockListRules).not.toHaveBeenCalled();
  });
});
