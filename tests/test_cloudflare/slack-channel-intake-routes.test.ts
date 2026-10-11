import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import { slackChannelIntakeRoutes } from "../../apps/control-plane-worker/src/routes/slack-channel-intake";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

const mockSaveIntake = vi.fn();
const mockDisableIntake = vi.fn();
const mockGetSettings = vi.fn();
const mockGetChannels = vi.fn();

vi.mock("../../apps/control-plane-worker/src/company-memory/slack-channel-intake-service", () => ({
  saveSlackChannelMemoryIntake: (...args: unknown[]) => mockSaveIntake(...args),
  disableSlackChannelMemoryIntake: (...args: unknown[]) => mockDisableIntake(...args),
  getSlackChannelMemorySettings: (...args: unknown[]) => mockGetSettings(...args),
  getSlackWorkspaceMemoryChannels: (...args: unknown[]) => mockGetChannels(...args),
}));

const BUSINESS_ID = "biz-1";
const ADMIN_USER_ID = 42;

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
    userId: String(ADMIN_USER_ID),
    tokenSource: "session",
    authMode: "user",
    canAccessAllSessions: false,
    user: { businessId: BUSINESS_ID } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

function postRoute(): Route {
  const route = slackChannelIntakeRoutes.find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/admin/slack-channel-intake"),
  );
  if (!route) throw new Error("POST /api/admin/slack-channel-intake route not found");
  return route;
}

async function invokePost(params: { env: Env; body: Record<string, unknown>; auth?: AuthInfo }): Promise<Response> {
  const route = postRoute();
  const request = new Request("https://example.com/api/admin/slack-channel-intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params.body),
  });
  const match = new URL(request.url).pathname.match(route.pattern);
  return route.handler(request, params.env, match!, params.auth ?? makeAuth());
}

const BASE_BODY = { business_id: BUSINESS_ID, team_id: "T1", channel_id: "C1" };

describe("slack channel intake routes", () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ sqlite, env } = createEnv());
    sqlite
      .prepare("INSERT INTO business_members (business_id, user_id, role) VALUES (?, ?, ?)")
      .run(BUSINESS_ID, ADMIN_USER_ID, "admin");
    mockSaveIntake.mockResolvedValue({ id: "intake-1" });
  });

  for (const scopeType of ["customer", "incident", "support", "sales"]) {
    it(`rejects ${scopeType} scope without a scope_id`, async () => {
      const response = await invokePost({ env, body: { ...BASE_BODY, scope_type: scopeType } });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("scope_id") });
      expect(mockSaveIntake).not.toHaveBeenCalled();
    });
  }

  it("rejects a whitespace-only scope_id for a scoped type", async () => {
    const response = await invokePost({ env, body: { ...BASE_BODY, scope_type: "customer", scope_id: "   " } });

    expect(response.status).toBe(400);
    expect(mockSaveIntake).not.toHaveBeenCalled();
  });

  it("allows the generic scope with no scope_id and saves scopeId null", async () => {
    const response = await invokePost({ env, body: { ...BASE_BODY, scope_type: "generic" } });

    expect(response.status).toBe(200);
    expect(mockSaveIntake).toHaveBeenCalledTimes(1);
    expect(mockSaveIntake).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ scopeType: "generic", scopeId: null }),
    );
  });

  it("allows a scoped type when scope_id is present", async () => {
    const response = await invokePost({ env, body: { ...BASE_BODY, scope_type: "customer", scope_id: "acme" } });

    expect(response.status).toBe(200);
    expect(mockSaveIntake).toHaveBeenCalledTimes(1);
    expect(mockSaveIntake).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ scopeType: "customer", scopeId: "acme" }),
    );
  });

  it("still rejects an unknown scope_type before the scope_id check", async () => {
    const response = await invokePost({ env, body: { ...BASE_BODY, scope_type: "not-a-scope" } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid scope_type" });
    expect(mockSaveIntake).not.toHaveBeenCalled();
  });

  it("forbids a non-admin caller before validating scope", async () => {
    const response = await invokePost({
      env,
      body: { ...BASE_BODY, scope_type: "customer" },
      auth: makeAuth({ userId: "999" }),
    });

    expect(response.status).toBe(403);
    expect(mockSaveIntake).not.toHaveBeenCalled();
  });
});
