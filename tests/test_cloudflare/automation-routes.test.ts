// Route-layer tests for DELETE /api/automation/schedules/:id. Calls
// the handler directly with synthesized auth + an in-memory D1.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTOMATION_MAX_RULES_PER_BUSINESS } from "../../apps/control-plane-worker/src/constants/automation";

const mockGate = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGate(...args),
}));

const mockRunManualAutomationSlotJob = vi.fn(async (_env: unknown, job: Record<string, unknown>) => ({
  ...job,
  phase: "prompt_enqueued",
  terminalOutcome: "fired",
}));
vi.mock("../../apps/control-plane-worker/src/automation/scheduler", () => ({
  runManualAutomationSlotJob: (...args: unknown[]) => mockRunManualAutomationSlotJob(...args),
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

import {
  insertScheduledRuleIfBusinessUnderEnabledCap,
  type InsertScheduledRuleInput,
} from "../../apps/control-plane-worker/src/automation/db";
import { automationScheduleRoutes } from "../../apps/control-plane-worker/src/routes/automation-schedules";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

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

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user",
    canAccessAllSessions: false,
    user: { businessId: "biz-a" } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

function getDeleteRoute(): Route {
  const route = automationScheduleRoutes.find(
    (r) => r.method === "DELETE" && r.pattern.test("/api/automation/schedules/rule-1"),
  );
  if (!route) throw new Error("DELETE route not registered");
  return route;
}

function getListRoute(): Route {
  const route = automationScheduleRoutes.find((r) => r.method === "GET" && r.pattern.test("/api/automation/schedules"));
  if (!route) throw new Error("GET route not registered");
  return route;
}

// Setup helper: seed a rule unconditionally with an effectively unlimited cap.
async function insertScheduledRule(db: D1Database, input: InsertScheduledRuleInput): Promise<void> {
  await insertScheduledRuleIfBusinessUnderEnabledCap(db, input, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

async function seedRule(env: Env, id: string, businessId: string, configuredByUserId = "42") {
  await insertScheduledRule(env.DB, {
    id,
    businessId,
    configuredByUserId,
    repoOwner: "acme",
    repoName: `repo-${id}`,
    installationId: 12345,
    promptTemplate: "Run tests.",
    cronExpression: "0 14 * * 1-5",
    normalizedCron: "0 14 * * 1,2,3,4,5",
    name: null,
    nextFireAt: Date.UTC(2026, 0, 7, 14, 0, 0),
    createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
  });
}

async function invokeDelete(env: Env, auth: AuthInfo | null, ruleId: string) {
  const route = getDeleteRoute();
  const url = `https://example.com/api/automation/schedules/${ruleId}`;
  const request = new Request(url, { method: "DELETE" });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

async function invokeList(env: Env, auth: AuthInfo | null) {
  const route = getListRoute();
  const url = "https://example.com/api/automation/schedules";
  const request = new Request(url, { method: "GET" });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

function getPostRoute(): Route {
  const route = automationScheduleRoutes.find(
    (r) => r.method === "POST" && r.pattern.test("/api/automation/schedules"),
  );
  if (!route) throw new Error("POST route not registered");
  return route;
}

async function invokePost(env: Env, auth: AuthInfo | null, body: Record<string, unknown>) {
  const route = getPostRoute();
  const url = "https://example.com/api/automation/schedules";
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

async function invokeRuleRoute(
  env: Env,
  auth: AuthInfo | null,
  method: "PATCH" | "POST",
  path: string,
  body?: Record<string, unknown>,
) {
  const route = automationScheduleRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!route) throw new Error(`${method} ${path} route not registered`);
  const url = `https://example.com${path}`;
  const request = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

describe("DELETE /api/automation/schedules/:id", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
  });

  it("returns 204 and removes the row when the rule belongs to the caller's business", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeDelete(env, makeAuth(), "rule-1");
    expect(response.status).toBe(204);
    const stillThere = d1.sqlite.prepare("SELECT 1 FROM scheduled_rules WHERE id = ?").get("rule-1");
    expect(stillThere).toBeUndefined();
  });

  it("returns 404 not_found for an unknown id", async () => {
    const response = await invokeDelete(env, makeAuth(), "missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not_found" });
  });

  it("returns 404 not_found for a cross-business id and leaves the row intact", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeDelete(env, makeAuth({ user: { businessId: "biz-b" } as AuthInfo["user"] }), "rule-1");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not_found" });
    const stillThere = d1.sqlite.prepare("SELECT 1 FROM scheduled_rules WHERE id = ?").get("rule-1");
    expect(stillThere).toBeDefined();
  });

  it("returns 403 when the caller has no business membership", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeDelete(env, makeAuth({ user: undefined }), "rule-1");
    expect(response.status).toBe(403);
  });

  it("returns 204 when an admin (canAccessAllSessions) deletes another member's rule", async () => {
    await seedRule(env, "rule-1", "biz-a", "42");
    const response = await invokeDelete(env, makeAuth({ userId: "999", canAccessAllSessions: true }), "rule-1");
    expect(response.status).toBe(204);
    const stillThere = d1.sqlite.prepare("SELECT 1 FROM scheduled_rules WHERE id = ?").get("rule-1");
    expect(stillThere).toBeUndefined();
  });

  it("returns 403 forbidden when a non-creator member tries to delete the rule", async () => {
    await seedRule(env, "rule-1", "biz-a", "42");
    const response = await invokeDelete(env, makeAuth({ userId: "77" }), "rule-1");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "forbidden" });
    const stillThere = d1.sqlite.prepare("SELECT 1 FROM scheduled_rules WHERE id = ?").get("rule-1");
    expect(stillThere).toBeDefined();
  });

  it("registers the PATCH management route on the same path", () => {
    const patch = automationScheduleRoutes.find(
      (r) => r.method === "PATCH" && r.pattern.test("/api/automation/schedules/rule-1"),
    );
    expect(patch).toBeDefined();
  });
});

describe("GET /api/automation/schedules (canDelete)", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
  });

  async function listItems(auth: AuthInfo | null): Promise<Array<Record<string, unknown>>> {
    const response = await invokeList(env, auth);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { items: Array<Record<string, unknown>> } };
    return body.data.items;
  }

  it("marks canDelete=true only for the requester's own rules (non-admin member)", async () => {
    await seedRule(env, "own", "biz-a", "42");
    await seedRule(env, "other", "biz-a", "77");
    const items = await listItems(makeAuth({ userId: "42" }));
    const byId = new Map(items.map((item) => [item.id as string, item.canDelete as boolean]));
    expect(byId.get("own")).toBe(true);
    expect(byId.get("other")).toBe(false);
    expect(items.find((item) => item.id === "own")?.canManage).toBe(true);
    expect(items.find((item) => item.id === "other")?.canManage).toBe(false);
  });

  it("marks canDelete=true for every rule when the requester is an admin", async () => {
    await seedRule(env, "own", "biz-a", "42");
    await seedRule(env, "other", "biz-a", "77");
    const items = await listItems(makeAuth({ userId: "999", canAccessAllSessions: true }));
    expect(items.every((item) => item.canDelete === true)).toBe(true);
  });
});

describe("scheduled automation management routes", () => {
  let d1: SqliteD1;
  let env: Env;

  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
    mockRunManualAutomationSlotJob.mockClear();
  });

  it("updates a rule without replacing its run history", async () => {
    await seedRule(env, "rule-1", "biz-a");
    d1.sqlite
      .prepare(
        `INSERT INTO automation_slot_jobs (
          job_key, rule_id, slot_ms, session_id, prompt_template, installation_id, phase,
          terminal_outcome, retry_after_ms, created_at, updated_at
        ) VALUES ('old-job', 'rule-1', 1000, 'old-session', 'Run tests.', 12345,
          'prompt_enqueued', 'fired', 1000, 1000, 1000)`,
      )
      .run();

    const response = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      cron: "30 15 * * 1-5",
      prompt: "Run focused tests.",
      name: "Focused tests",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { id: "rule-1", cron: "30 15 * * 1-5", promptTemplate: "Run focused tests.", name: "Focused tests" },
    });
    expect(
      d1.sqlite.prepare("SELECT COUNT(*) AS count FROM automation_slot_jobs WHERE rule_id = ?").get("rule-1"),
    ).toEqual({ count: 1 });
  });

  it("applies a partial PATCH without disturbing the other fields", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      name: "Nightly",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { id: "rule-1", name: "Nightly", cron: "0 14 * * 1-5", promptTemplate: "Run tests." },
    });
  });

  it("rejects a PATCH with no updatable fields", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("rejects wrong-typed PATCH fields instead of coercing them", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const badCron = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      cron: 123,
    });
    expect(badCron.status).toBe(400);
    await expect(badCron.json()).resolves.toMatchObject({ ok: false, error: "invalid_cron" });

    const badPrompt = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      prompt: 42,
    });
    expect(badPrompt.status).toBe(400);
    await expect(badPrompt.json()).resolves.toMatchObject({ ok: false, error: "invalid_prompt" });
  });

  it("pauses and resumes using the existing enabled field", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const pause = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      enabled: false,
    });
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({ data: { enabled: false } });

    const resume = await invokeRuleRoute(env, makeAuth(), "PATCH", "/api/automation/schedules/rule-1", {
      enabled: true,
    });
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toMatchObject({ data: { enabled: true } });
  });

  it("duplicates an exact rule as paused", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeRuleRoute(env, makeAuth(), "POST", "/api/automation/schedules/rule-1/duplicate");
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string; enabled: boolean; promptTemplate: string } };
    expect(body.data).toMatchObject({ enabled: false, promptTemplate: "Run tests." });
    expect(body.data.id).not.toBe("rule-1");
  });

  it("refuses to duplicate once the total-rule cap is reached", async () => {
    // Fill the business to the total cap with paused rules (plus the source
    // rule), then assert duplicate is refused with the total-cap error.
    await seedRule(env, "rule-1", "biz-a");
    for (let i = 1; i < AUTOMATION_MAX_RULES_PER_BUSINESS; i++) {
      await seedRule(env, `filler-${i}`, "biz-a");
    }
    const response = await invokeRuleRoute(env, makeAuth(), "POST", "/api/automation/schedules/rule-1/duplicate");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "rule_total_cap_reached" });
  });

  it("creates a manual history row and runs it through the scheduler pipeline", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeRuleRoute(env, makeAuth(), "POST", "/api/automation/schedules/rule-1/run-now");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { outcome: "fired", phase: "prompt_enqueued" } });
    expect(mockRunManualAutomationSlotJob).toHaveBeenCalledOnce();
    const row = d1.sqlite
      .prepare("SELECT rule_id, prompt_template FROM automation_slot_jobs WHERE rule_id = ?")
      .get("rule-1");
    expect(row).toEqual({ rule_id: "rule-1", prompt_template: "Run tests." });
  });

  it.each([
    ["PATCH", "/api/automation/schedules/rule-1", { enabled: false }],
    ["POST", "/api/automation/schedules/rule-1/duplicate", undefined],
    ["POST", "/api/automation/schedules/rule-1/run-now", undefined],
  ] as const)("denies non-creators for %s %s", async (method, path, body) => {
    await seedRule(env, "rule-1", "biz-a", "42");
    const response = await invokeRuleRoute(env, makeAuth({ userId: "77" }), method, path, body);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("POST /api/automation/schedules", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
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
    mockGetWorkspaceMetadata.mockReset();
    mockGetWorkspaceMetadata.mockResolvedValue({ teamId: "T123", businessId: "biz-a", botUserId: "U1" });
  });

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    repoOwner: "acme",
    repoName: "webapp",
    cron: "0 14 * * 1-5",
    prompt: "Review failing tests.",
    ...overrides,
  });

  it("creates a rule with no Slack delivery and returns null delivery fields", async () => {
    const response = await invokePost(env, makeAuth(), validBody());
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({
      slackTeamId: null,
      slackChannelId: null,
      lastDeliveredAt: null,
      lastDeliveryError: null,
    });
    expect(mockResolveBotToken).not.toHaveBeenCalled();
  });

  it("rejects invalid request-body field types before the service runs", async () => {
    const response = await invokePost(env, makeAuth(), validBody({ name: 123 }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "name must be a string or null",
    });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("forwards a Slack delivery target and returns it in the API shape", async () => {
    const response = await invokePost(env, makeAuth(), validBody({ slackTeamId: "T123", slackChannelId: "C456" }));
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { data: Record<string, unknown> };
    expect(payload.data).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });
    expect(mockGetConversationInfo).toHaveBeenCalledWith("xoxb-test-token", "C456");
  });

  it("surfaces the fail-closed membership error as a 400 through the route", async () => {
    mockGetConversationInfo.mockResolvedValueOnce({
      id: "C456",
      name: "changelog",
      isChannel: true,
      isPrivate: false,
      isIm: false,
      isMpim: false,
      isMember: false,
    });
    const response = await invokePost(env, makeAuth(), validBody({ slackTeamId: "T123", slackChannelId: "C456" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "slack_bot_not_in_channel" });
  });

  it("returns 403 when the caller has no business membership", async () => {
    const response = await invokePost(env, makeAuth({ user: undefined }), validBody());
    expect(response.status).toBe(403);
  });
});

describe("GET /api/automation/schedules/:id/runs", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
  });

  function getRunsRoute(): Route {
    const route = automationScheduleRoutes.find(
      (r) => r.method === "GET" && r.pattern.test("/api/automation/schedules/rule-1/runs"),
    );
    if (!route) throw new Error("GET runs route not registered");
    return route;
  }

  async function invokeRuns(auth: AuthInfo | null, ruleId: string, query = "") {
    const route = getRunsRoute();
    const url = `https://example.com/api/automation/schedules/${ruleId}/runs${query}`;
    const request = new Request(url, { method: "GET" });
    const match = new URL(url).pathname.match(route.pattern);
    return route.handler(request, env, match!, auth);
  }

  function seedSlotJob(ruleId: string, slotMs: number, terminalOutcome: string | null, failureReason: string | null) {
    d1.sqlite
      .prepare(
        `INSERT INTO automation_slot_jobs (
           job_key, rule_id, slot_ms, session_id, prompt_template, installation_id,
           phase, terminal_outcome, failure_reason, retry_after_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'Run tests.', 12345, 'slot_claimed', ?, ?, ?, ?, ?)`,
      )
      .run(
        `automation:${ruleId}:${slotMs}`,
        ruleId,
        slotMs,
        `automation-${ruleId}-${slotMs}`,
        terminalOutcome,
        failureReason,
        slotMs,
        slotMs,
        slotMs,
      );
  }

  it("returns runs newest-first with stats for a rule in the caller's business", async () => {
    await seedRule(env, "rule-1", "biz-a");
    seedSlotJob("rule-1", 1000, "fired", null);
    seedSlotJob("rule-1", 2000, "failed", "session_create_projection");
    d1.sqlite
      .prepare(
        `INSERT INTO session_index (session_id, owner_user_id, business_id, status, created_at, updated_at, rich_status)
         VALUES (?, 42, 'biz-a', 'active', 1000, 1000, 'completed')`,
      )
      .run("automation-rule-1-1000");

    const response = await invokeRuns(makeAuth(), "rule-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
        stats: { last24h: Record<string, number>; last7d: Record<string, number> };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.items.map((item) => item.slotMs)).toEqual([2000, 1000]);
    expect(body.data.items[0]).toMatchObject({
      outcome: "failed",
      failureReason: "session_create_projection",
      sessionId: null,
    });
    expect(body.data.items[1]).toMatchObject({
      outcome: "fired",
      sessionId: "automation-rule-1-1000",
      sessionRichStatus: "completed",
    });
    // Seed timestamps are far outside both rolling windows relative to now.
    expect(body.data.stats.last24h).toEqual({ fired: 0, failed: 0, skipped: 0 });
    expect(body.data.stats.last7d).toEqual({ fired: 0, failed: 0, skipped: 0 });
    expect(body.data.nextCursor).toBeNull();
  });

  it("counts recent outcomes inside the rolling windows", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const now = Date.now();
    seedSlotJob("rule-1", now - 1000, "fired", null);
    seedSlotJob("rule-1", now - 2000, "skipped_overlap", null);

    const response = await invokeRuns(makeAuth(), "rule-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { stats: { last24h: Record<string, number>; last7d: Record<string, number> } };
    };
    expect(body.data.stats.last24h).toEqual({ fired: 1, failed: 0, skipped: 1 });
    expect(body.data.stats.last7d).toEqual({ fired: 1, failed: 0, skipped: 1 });
  });

  it("respects the limit query and returns a cursor for the next page", async () => {
    await seedRule(env, "rule-1", "biz-a");
    seedSlotJob("rule-1", 1000, "fired", null);
    seedSlotJob("rule-1", 2000, "fired", null);
    const response = await invokeRuns(makeAuth(), "rule-1", "?limit=1");
    const body = (await response.json()) as { data: { items: Array<Record<string, unknown>>; nextCursor: string } };
    expect(body.data.items.map((item) => item.slotMs)).toEqual([2000]);
    expect(body.data.nextCursor).toBe("2000");

    const secondPage = await invokeRuns(makeAuth(), "rule-1", `?limit=1&cursor=${body.data.nextCursor}`);
    const secondBody = (await secondPage.json()) as {
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };
    expect(secondBody.data.items.map((item) => item.slotMs)).toEqual([1000]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it("returns 404 not_found for an unknown id", async () => {
    const response = await invokeRuns(makeAuth(), "missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not_found" });
  });

  it("returns 404 not_found for a cross-business rule (fail closed)", async () => {
    await seedRule(env, "rule-1", "biz-a");
    seedSlotJob("rule-1", 1000, "fired", null);
    const response = await invokeRuns(makeAuth({ user: { businessId: "biz-b" } as AuthInfo["user"] }), "rule-1");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not_found" });
  });

  it("returns 403 when the caller has no business membership", async () => {
    await seedRule(env, "rule-1", "biz-a");
    const response = await invokeRuns(makeAuth({ user: undefined }), "rule-1");
    expect(response.status).toBe(403);
  });
});
