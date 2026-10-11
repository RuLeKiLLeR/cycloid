import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackInteractionKind } from "../../apps/control-plane-worker/src/enums/slack-interaction.js";
import { insertInteractionRequest } from "../../apps/control-plane-worker/src/slack/interaction-requests-db.js";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createSlackLinkSchema, SqliteD1 } from "./sqlite-d1-helper";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/verify", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/webhooks/verify")>(
    "../../apps/control-plane-worker/src/webhooks/verify",
  );
  return { ...actual, verifySlackWebhookSignature: vi.fn().mockResolvedValue(true) };
});

const sessionStateMocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  approveSessionPlan: vi.fn(),
  resumeSession: vi.fn(),
  retrySessionPrompt: vi.fn(),
}));

const repoGateMocks = vi.hoisted(() => ({
  verifyRepoAccessAndInstallation: vi.fn(),
}));

const rateLimitMocks = vi.hoisted(() => ({
  checkSessionResumeRateLimit: vi.fn(),
}));

const cardUpdateMocks = vi.hoisted(() => ({
  updateSlackStatusCardFromSessionState: vi.fn(),
}));

const planApprovalInteractionMocks = vi.hoisted(() => ({
  replacePlanApprovalInteractionRequest: vi.fn(),
  updatePlanApprovalInteractionMessage: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: sessionStateMocks.getSessionState,
    approveSessionPlan: sessionStateMocks.approveSessionPlan,
    resumeSession: sessionStateMocks.resumeSession,
    retrySessionPrompt: sessionStateMocks.retrySessionPrompt,
  };
});

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: repoGateMocks.verifyRepoAccessAndInstallation,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-resume-rate-limiter", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/services/session-resume-rate-limiter")
  >("../../apps/control-plane-worker/src/services/session-resume-rate-limiter");
  return { ...actual, checkSessionResumeRateLimit: rateLimitMocks.checkSessionResumeRateLimit };
});

vi.mock("../../apps/control-plane-worker/src/slack/phase-updates", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/slack/phase-updates")>(
    "../../apps/control-plane-worker/src/slack/phase-updates",
  );
  return { ...actual, updateSlackStatusCardFromSessionState: cardUpdateMocks.updateSlackStatusCardFromSessionState };
});

vi.mock("../../apps/control-plane-worker/src/slack/plan-approval-interactions", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/slack/plan-approval-interactions")
  >("../../apps/control-plane-worker/src/slack/plan-approval-interactions");
  return {
    ...actual,
    replacePlanApprovalInteractionRequest: planApprovalInteractionMocks.replacePlanApprovalInteractionRequest,
    updatePlanApprovalInteractionMessage: planApprovalInteractionMocks.updatePlanApprovalInteractionMessage,
  };
});

const MIGRATION_SQL = readFileSync(
  new URL("../../apps/control-plane-worker/migrations/0244_slack_interaction_requests.sql", import.meta.url),
  "utf8",
);

type HandleSlackInteractionsWebhook = (request: Request, env: Env, ctx?: ExecutionContext) => Promise<Response>;

let handleSlackInteractionsWebhook: HandleSlackInteractionsWebhook;
let sqlite: Database.Database;
let db: D1Database;
let env: Env;
let fetchCalls: Array<{ url: string; body: string }>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let triggerSeq = 0;
const originalFetch = globalThis.fetch;

function seedUser(id: number, login: string, businessId: string | null): void {
  sqlite.prepare("INSERT INTO users (id, login, business_id) VALUES (?, ?, ?)").run(id, login, businessId);
}

function seedSlackLink(userId: number, slackUserId: string, teamId: string): void {
  sqlite
    .prepare(
      `INSERT INTO user_integrations
       (user_id, integration_id, external_user_id, external_team_id, encrypted, connected_at, updated_at)
       VALUES (?, 'slack', ?, ?, 0, 1, 1)`,
    )
    .run(userId, slackUserId, teamId);
}

async function seedRequest(overrides: Partial<Parameters<typeof insertInteractionRequest>[1]> = {}): Promise<string> {
  return insertInteractionRequest(db, {
    businessId: "biz-1",
    sessionId: "sess-1",
    kind: SlackInteractionKind.ResumeSession,
    payloadJson: JSON.stringify({ marker: "never-logged" }),
    slackTeamId: "T1",
    slackChannelId: "C1",
    messageTs: "1000.0",
    expiresAt: null,
    ...overrides,
  });
}

function requestRow(id: string): { status: string; consumed_by_user_id: string | null } {
  return sqlite.prepare("SELECT status, consumed_by_user_id FROM slack_interaction_requests WHERE id = ?").get(id) as {
    status: string;
    consumed_by_user_id: string | null;
  };
}

function buildClick(actionId: string, overrides: Record<string, unknown> = {}): Request {
  triggerSeq += 1;
  const body = new URLSearchParams({
    payload: JSON.stringify({
      trigger_id: `trig_${triggerSeq}`,
      team: { id: "T1" },
      user: { id: "U1" },
      response_url: "https://hooks.slack.com/actions/T1/123/abc",
      actions: [{ action_id: actionId }],
      ...overrides,
    }),
  }).toString();
  return new Request("https://test/api/webhooks/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=test",
    },
    body,
  });
}

function loggedEntries(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const call of [...consoleLogSpy.mock.calls, ...consoleWarnSpy.mock.calls]) {
    const line = call[0];
    if (typeof line !== "string") continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Non-JSON console output from unrelated code paths.
    }
  }
  return entries;
}

function consumeAttemptLogs(): Array<Record<string, unknown>> {
  return loggedEntries().filter((entry) => entry.action === "slack.interaction.consume_attempt");
}

async function flushEphemeral(): Promise<void> {
  // The response_url ephemeral post is fire-and-forget; yield the microtask
  // queue and a macrotask so the tracedFetch promise settles.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  createSlackLinkSchema(sqlite);
  sqlite.exec(MIGRATION_SQL);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS webhook_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload_hash TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = { DB: db, SLACK_SIGNING_SECRET: "test-secret" } as unknown as Env;

  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const mod = await import("../../apps/control-plane-worker/src/webhooks/slack-interactions");
  handleSlackInteractionsWebhook = mod.handleSlackInteractionsWebhook as HandleSlackInteractionsWebhook;

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Default authorized actor: user 1 in biz-1, linked as U1 in workspace T1.
  seedUser(1, "alice", "biz-1");
  seedSlackLink(1, "U1", "T1");

  sessionStateMocks.getSessionState.mockReset();
  sessionStateMocks.approveSessionPlan.mockReset();
  sessionStateMocks.resumeSession.mockReset();
  sessionStateMocks.retrySessionPrompt.mockReset();
  repoGateMocks.verifyRepoAccessAndInstallation.mockReset();
  rateLimitMocks.checkSessionResumeRateLimit.mockReset();
  cardUpdateMocks.updateSlackStatusCardFromSessionState.mockReset();
  planApprovalInteractionMocks.replacePlanApprovalInteractionRequest.mockReset();
  planApprovalInteractionMocks.updatePlanApprovalInteractionMessage.mockReset();

  // Happy-path defaults: a stopped, repo-bound Slack session owned by biz-1.
  sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession());
  sessionStateMocks.approveSessionPlan.mockResolvedValue({
    status: 200,
    ok: true,
    payload: { ok: true, revision: 3, implementationPromptId: "p-4", idempotent: false },
    error: null,
    reason: null,
    errorDetails: null,
  });
  sessionStateMocks.resumeSession.mockResolvedValue({ ok: true, status: "spawning" });
  sessionStateMocks.retrySessionPrompt.mockResolvedValue({ ok: true, status: "running" });
  repoGateMocks.verifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 7 });
  rateLimitMocks.checkSessionResumeRateLimit.mockResolvedValue({ limited: false });
  cardUpdateMocks.updateSlackStatusCardFromSessionState.mockResolvedValue(true);
  planApprovalInteractionMocks.replacePlanApprovalInteractionRequest.mockResolvedValue("replacement-id");
  planApprovalInteractionMocks.updatePlanApprovalInteractionMessage.mockResolvedValue(undefined);
});

function makeDoSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    ownerUserId: "1",
    businessId: "biz-1",
    phase: "stopped",
    repoOwner: "acme",
    repoName: "widgets",
    createdAt: "2026-01-01T00:00:00.000Z",
    prUrl: null,
    verificationState: null,
    verificationResult: null,
    planApprovalPending: true,
    planRevision: 3,
    planStatus: "pending",
    callbackContext: {
      source: "slack",
      channel: "C1",
      threadTs: "1000.0",
      slackTeamId: "T1",
      statusMessageTs: "1000.1",
    },
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

function buildExecutionContext(): {
  ctx: ExecutionContext;
  tasks: Promise<unknown>[];
  flush: () => Promise<void>;
} {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        tasks.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext,
    tasks,
    flush: async () => {
      await Promise.all(tasks);
    },
  };
}

describe("Slack interaction request dispatch", () => {
  it("consumes a valid click, records the actor, and no-ops on an unwired kind", async () => {
    // answer_question stays unwired until PR 2.4 — the placeholder no-op path.
    const id = await seedRequest({ kind: SlackInteractionKind.AnswerQuestion });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:answer_question:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, consumed: true, handled: false, kind: "answer_question" });
    expect(requestRow(id)).toEqual({ status: "consumed", consumed_by_user_id: "1" });

    const attempts = consumeAttemptLogs();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      kind: "answer_question",
      requestId: id,
      sessionId: "sess-1",
      businessId: "biz-1",
      userId: 1,
      outcome: "consumed",
    });
    // Metadata only: the stored payload_json must never reach the logs.
    for (const call of [...consoleLogSpy.mock.calls, ...consoleWarnSpy.mock.calls]) {
      expect(String(call[0])).not.toContain("never-logged");
    }
    const unwired = loggedEntries().find((entry) => entry.action === "slack.interaction.handler_unwired");
    expect(unwired).toMatchObject({ kind: "answer_question", requestId: id });
  });

  it("rejects a cross-business actor and leaves the row untouched (IDOR)", async () => {
    seedUser(2, "mallory", "biz-2");
    seedSlackLink(2, "U2", "T1");
    const id = await seedRequest({ businessId: "biz-1" });

    const res = await handleSlackInteractionsWebhook(
      buildClick(`cycloid:resume_session:${id}`, { user: { id: "U2" } }),
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "actor_not_authorized" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "denied_authz", reason: "business_mismatch", userId: 2 });
  });

  it("rejects a click from a workspace other than the row's workspace", async () => {
    const id = await seedRequest({ slackTeamId: "T1" });

    const res = await handleSlackInteractionsWebhook(
      buildClick(`cycloid:resume_session:${id}`, { team: { id: "T2" } }),
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "actor_not_authorized" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "denied_authz", reason: "team_mismatch" });
  });

  it("rejects the same Slack user id string linked in a different workspace", async () => {
    // The request legitimately lives in workspace T2, but the only Cycloid
    // link for "U1" was bound in T1 — the team-scoped lookup must not resolve.
    const id = await seedRequest({ slackTeamId: "T2" });

    const res = await handleSlackInteractionsWebhook(
      buildClick(`cycloid:resume_session:${id}`, { team: { id: "T2" } }),
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "actor_not_authorized" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "denied_authz", reason: "unknown_actor" });
  });

  it("answers a replay after consume with an already-handled ephemeral", async () => {
    const id = await seedRequest();
    const first = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await first.json()) as Record<string, unknown>).handled).toBe(true);

    const replay = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await replay.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "already_handled" });
    expect(requestRow(id)).toEqual({ status: "consumed", consumed_by_user_id: "1" });
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("Already handled.");
    expect(ephemeral?.body).toContain('"response_type":"ephemeral"');
    const outcomes = consumeAttemptLogs().map((entry) => entry.outcome);
    expect(outcomes).toEqual(["consumed", "replay"]);
  });

  it("classifies a click on an expired request as expired without consuming it", async () => {
    const id = await seedRequest({ expiresAt: Date.now() - 1_000 });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "expired" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "expired", userId: 1 });
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("expired");
  });

  it("treats an unknown request id as already handled", async () => {
    const res = await handleSlackInteractionsWebhook(
      buildClick("cycloid:resume_session:00000000-0000-0000-0000-000000000000"),
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "request_not_found" });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "replay", reason: "request_not_found", userId: null });
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("Already handled.");
  });

  it("safely no-ops on an unknown kind without touching the database", async () => {
    const id = await seedRequest();

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:launch_missiles:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "invalid_action_id" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()).toHaveLength(0);
  });

  it("safely no-ops on malformed action ids", async () => {
    for (const actionId of ["cycloid:resume_session", "cycloid::x", "cycloid:resume_session:", "cycloid:a:b:c"]) {
      const res = await handleSlackInteractionsWebhook(buildClick(actionId), env);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, skipped: true, reason: "invalid_action_id" });
    }
    expect(consumeAttemptLogs()).toHaveLength(0);
  });

  it("rejects an action id whose kind disagrees with the stored row", async () => {
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:answer_question:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "actor_not_authorized" });
    expect(requestRow(id)).toEqual({ status: "pending", consumed_by_user_id: null });
    expect(consumeAttemptLogs()[0]).toMatchObject({ outcome: "denied_authz", reason: "kind_mismatch" });
  });
});

describe("resume/retry session-control handlers", () => {
  function controlStatuses(kind: string): string[] {
    return (
      sqlite
        .prepare("SELECT status FROM slack_interaction_requests WHERE kind = ? ORDER BY created_at, id")
        .all(kind) as Array<{ status: string }>
    ).map((row) => row.status);
  }

  it("resume: consume → service call with the resolved actor context, then in-place ack", async () => {
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, handled: true, kind: "resume_session", outcome: "executed" });
    expect(requestRow(id)).toEqual({ status: "consumed", consumed_by_user_id: "1" });
    expect(sessionStateMocks.resumeSession).toHaveBeenCalledWith(env, "sess-1");
    // Repo access re-proven for the CLICKER (dispatcher only proves membership).
    expect(repoGateMocks.verifyRepoAccessAndInstallation).toHaveBeenCalledWith(
      db,
      { userId: "1", canAccessAllSessions: false, businessRole: null },
      "acme",
      "widgets",
      expect.objectContaining({ sessionId: "sess-1" }),
    );
    // The card acks in place ("Resuming…") — no new thread post.
    expect(cardUpdateMocks.updateSlackStatusCardFromSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "running", narrationLine: "Resuming…" }),
    );
  });

  it("retry: consume → retry service on a failed session, ack says retrying", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ phase: "failed" }));
    const id = await seedRequest({ kind: SlackInteractionKind.RetrySession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:retry_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, handled: true, outcome: "executed" });
    expect(sessionStateMocks.retrySessionPrompt).toHaveBeenCalledWith(env, "sess-1");
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
    expect(cardUpdateMocks.updateSlackStatusCardFromSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "running", narrationLine: "Retrying the last prompt…" }),
    );
  });

  it("repo-access denied: fail closed — denied, no service call, row STAYS consumed", async () => {
    // Documented decision: the one-shot row is consumed before the handler
    // runs and a denial does not release it; the next phase-change render
    // mints a fresh row. Fail-closed beats a replayable row.
    repoGateMocks.verifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "repo_access_denied",
      response: new Response("no", { status: 403 }),
    });
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, handled: false, outcome: "denied_repo_access" });
    expect(requestRow(id)).toEqual({ status: "consumed", consumed_by_user_id: "1" });
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("access");
    const denied = loggedEntries().find(
      (entry) => entry.action === "slack.interaction.session_control" && entry.outcome === "denied_repo_access",
    );
    expect(denied).toMatchObject({ requestId: id, sessionId: "sess-1", userId: 1 });
  });

  it("missing repo context fails closed like a denial", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ repoOwner: null, repoName: null }));
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await res.json()) as Record<string, unknown>).outcome).toBe("denied_repo_access");
    expect(repoGateMocks.verifyRepoAccessAndInstallation).not.toHaveBeenCalled();
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
  });

  it("stale click after a phase change: friendly no-longer-applicable + card refresh, no action", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ phase: "running" }));
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, handled: false, outcome: "stale_phase" });
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
    expect(requestRow(id)).toEqual({ status: "consumed", consumed_by_user_id: "1" });
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("no longer applies");
    // Card refreshed to the CURRENT stage so the dead button disappears.
    expect(cardUpdateMocks.updateSlackStatusCardFromSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "running" }),
    );
  });

  it("retry click on a stopped session passes the eligibility floor (isRetryAvailable admits stopped)", async () => {
    // The card only OFFERS Retry on failed/blocked, but the canonical predicate
    // is the gate here — isRetryAvailable(stopped) is true, so a stale button
    // click on a now-stopped session still executes rather than dead-ending.
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ phase: "stopped" }));
    const id = await seedRequest({ kind: SlackInteractionKind.RetrySession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:retry_session:${id}`), env);
    expect(((await res.json()) as Record<string, unknown>).outcome).toBe("executed");
    expect(sessionStateMocks.retrySessionPrompt).toHaveBeenCalled();
  });

  it("rate-limited clicks are refused before any repo or service work", async () => {
    rateLimitMocks.checkSessionResumeRateLimit.mockResolvedValue({ limited: true });
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await res.json()) as Record<string, unknown>).outcome).toBe("rate_limited");
    expect(repoGateMocks.verifyRepoAccessAndInstallation).not.toHaveBeenCalled();
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
  });

  it("fails closed when the DO session's business disagrees with the request row", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ businessId: "biz-2" }));
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await res.json()) as Record<string, unknown>).outcome).toBe("business_mismatch");
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
  });

  it("surfaces the DO's retry_in_progress idempotency rejection without a double clone", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ phase: "failed" }));
    sessionStateMocks.retrySessionPrompt.mockResolvedValue({
      ok: false,
      error: "session_not_retryable",
      reason: "retry_in_progress",
    });
    const id = await seedRequest({ kind: SlackInteractionKind.RetrySession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:retry_session:${id}`), env);
    const body = (await res.json()) as Record<string, unknown>;
    await flushEphemeral();

    expect(body).toMatchObject({ ok: true, handled: false, outcome: "service_failed" });
    const ephemeral = fetchCalls.find((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(ephemeral?.body).toContain("already in flight");
  });

  it("double-click: exactly one resume — the loser gets already-handled and no second service call", async () => {
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const first = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await first.json()) as Record<string, unknown>).outcome).toBe("executed");
    const second = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    const body = (await second.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ ok: true, skipped: true, reason: "already_handled" });
    expect(sessionStateMocks.resumeSession).toHaveBeenCalledTimes(1);
  });

  it("ack render supersedes lingering control rows for the new stage", async () => {
    const clicked = await seedRequest({ kind: SlackInteractionKind.ResumeSession });
    // A stale retry row from an earlier failed render is still pending.
    await seedRequest({ kind: SlackInteractionKind.RetrySession });

    await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${clicked}`), env);

    // Post-resume ack renders at stage "running": neither control applies, so
    // the pending retry row is superseded (clicked row was consumed already).
    expect(controlStatuses(SlackInteractionKind.RetrySession)).toEqual(["superseded"]);
  });

  it("session gone: friendly ephemeral, nothing dispatched", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(null);
    const id = await seedRequest({ kind: SlackInteractionKind.ResumeSession });

    const res = await handleSlackInteractionsWebhook(buildClick(`cycloid:resume_session:${id}`), env);
    expect(((await res.json()) as Record<string, unknown>).outcome).toBe("session_not_found");
    expect(sessionStateMocks.resumeSession).not.toHaveBeenCalled();
  });
});

describe("approve-plan interaction handler", () => {
  async function seedApprovePlanRequest(revision = 3): Promise<string> {
    return seedRequest({
      kind: SlackInteractionKind.ApprovePlan,
      payloadJson: JSON.stringify({ revision }),
      expiresAt: null,
    });
  }

  it("acks before a slow approval dependency settles and keeps the work in waitUntil", async () => {
    let resolveApproval: ((value: unknown) => void) | null = null;
    sessionStateMocks.approveSessionPlan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const id = await seedApprovePlanRequest();
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, handled: true, outcome: "scheduled" });
    expect(execution.tasks).toHaveLength(1);
    await vi.waitFor(() => expect(sessionStateMocks.approveSessionPlan).toHaveBeenCalledTimes(1));
    expect(planApprovalInteractionMocks.updatePlanApprovalInteractionMessage).not.toHaveBeenCalled();

    resolveApproval?.({
      status: 200,
      ok: true,
      payload: { ok: true, revision: 3, implementationPromptId: "p-4", idempotent: false },
      error: null,
      reason: null,
      errorDetails: null,
    });
    await execution.flush();
    expect(planApprovalInteractionMocks.updatePlanApprovalInteractionMessage).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id }),
      "approved",
    );
  });

  it("re-runs the revision CAS and turns a stale button into a friendly DM update", async () => {
    sessionStateMocks.approveSessionPlan.mockResolvedValue({
      status: 409,
      ok: false,
      payload: null,
      error: "stale_revision",
      reason: null,
      errorDetails: null,
    });
    const id = await seedApprovePlanRequest(2);
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);
    expect(response.status).toBe(200);
    await execution.flush();

    expect(sessionStateMocks.approveSessionPlan).toHaveBeenCalledWith(
      env,
      "sess-1",
      null,
      expect.objectContaining({
        userId: "1",
        businessId: "biz-1",
        repoAccessVerifiedSessionId: "sess-1",
      }),
      { revision: 2, actorUserId: "1", source: "slack" },
    );
    expect(planApprovalInteractionMocks.updatePlanApprovalInteractionMessage).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id }),
      "stale",
    );
    expect(planApprovalInteractionMocks.replacePlanApprovalInteractionRequest).not.toHaveBeenCalled();
  });

  it("fails closed on a session-business mismatch before repo access or approval", async () => {
    sessionStateMocks.getSessionState.mockResolvedValue(makeDoSession({ businessId: "biz-2" }));
    const id = await seedApprovePlanRequest();
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);
    expect(response.status).toBe(200);
    await execution.flush();

    expect(repoGateMocks.verifyRepoAccessAndInstallation).not.toHaveBeenCalled();
    expect(sessionStateMocks.approveSessionPlan).not.toHaveBeenCalled();
    expect(planApprovalInteractionMocks.updatePlanApprovalInteractionMessage).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id }),
      "unavailable",
    );
  });

  it("fails closed on repo-access denial before approval", async () => {
    repoGateMocks.verifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "repo_access_denied",
      response: new Response("no", { status: 403 }),
    });
    const id = await seedApprovePlanRequest();
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);
    expect(response.status).toBe(200);
    await execution.flush();

    expect(sessionStateMocks.approveSessionPlan).not.toHaveBeenCalled();
    expect(planApprovalInteractionMocks.updatePlanApprovalInteractionMessage).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id }),
      "unavailable",
    );
  });

  it("replaces the burned request when repo access cannot be verified before approval", async () => {
    repoGateMocks.verifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "access_unverifiable",
      response: new Response("retry", { status: 503 }),
    });
    const id = await seedApprovePlanRequest();
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);
    expect(response.status).toBe(200);
    await execution.flush();

    expect(sessionStateMocks.approveSessionPlan).not.toHaveBeenCalled();
    expect(planApprovalInteractionMocks.replacePlanApprovalInteractionRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id }),
    );
  });

  it("mints and publishes a replacement after a pre-commit approval failure", async () => {
    sessionStateMocks.approveSessionPlan.mockRejectedValue(new Error("DO unavailable before commit"));
    const id = await seedApprovePlanRequest();
    const execution = buildExecutionContext();

    const response = await handleSlackInteractionsWebhook(buildClick(`cycloid:approve_plan:${id}`), env, execution.ctx);
    expect(response.status).toBe(200);
    await execution.flush();

    expect(planApprovalInteractionMocks.replacePlanApprovalInteractionRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id, payloadJson: JSON.stringify({ revision: 3 }) }),
    );
  });

  it("consumes an approve request once and schedules only one approval on replay", async () => {
    const id = await seedApprovePlanRequest();
    const firstExecution = buildExecutionContext();
    const first = await handleSlackInteractionsWebhook(
      buildClick(`cycloid:approve_plan:${id}`),
      env,
      firstExecution.ctx,
    );
    expect(first.status).toBe(200);
    const replay = await handleSlackInteractionsWebhook(
      buildClick(`cycloid:approve_plan:${id}`),
      env,
      buildExecutionContext().ctx,
    );
    expect(await replay.json()).toMatchObject({ ok: true, skipped: true, reason: "already_handled" });
    await firstExecution.flush();
    expect(sessionStateMocks.approveSessionPlan).toHaveBeenCalledTimes(1);
  });
});
