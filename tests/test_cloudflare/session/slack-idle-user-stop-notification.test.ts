import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { SLACK_POST_RETRY_STAGES } from "../../../apps/control-plane-worker/src/session/slack-posts-db.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
} from "./helpers.ts";

const mockPostThreadReply = vi.hoisted(() => vi.fn(async () => ({ ok: true, ts: "200.100" })));
const mockResolveSlackBotTokenForCallback = vi.hoisted(() => vi.fn(async () => "xoxb-test-token"));
const mockReportSlackPostFailure = vi.hoisted(() => vi.fn(async () => undefined));
const mockUpdateSlackStatusStageInPlace = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../../apps/control-plane-worker/src/slack/notify.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/notify.ts")>();
  return {
    ...actual,
    postThreadReply: mockPostThreadReply,
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/tokens.ts")>();
  return {
    ...actual,
    resolveSlackBotTokenForCallback: (...args: unknown[]) => mockResolveSlackBotTokenForCallback(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/phase-updates.ts", () => ({
  updateSlackStatusStageInPlace: mockUpdateSlackStatusStageInPlace,
}));

vi.mock("../../../apps/control-plane-worker/src/observability/swallowed-failure.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../apps/control-plane-worker/src/observability/swallowed-failure.ts")>();
  return {
    ...actual,
    reportSlackPostFailure: (...args: unknown[]) => mockReportSlackPostFailure(...args),
  };
});

mockCloudflareWorkers();
mockSentryCloudflare();

type SlackPostRow = {
  status: "pending" | "sending" | "delivered" | "exhausted";
  channel: string | null;
  messageTs: string | null;
  nextAttemptAt: number | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
};

class SlackPostD1Statement {
  private bound: unknown[] = [];

  constructor(
    private readonly db: SlackPostD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.bound = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    if (this.query.includes("UPDATE session_index SET rich_status")) {
      return this.result(1);
    }

    if (this.query.includes("INSERT OR IGNORE INTO slack_posts")) {
      const [, sessionId, promptId, stage, channel, messageTs, , status, nextAttemptAt] = this.bound as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        SlackPostRow["status"],
        number | null,
      ];
      const key = this.db.key(sessionId, promptId, stage);
      if (this.db.slackPosts.has(key)) {
        return this.result(0);
      }
      this.db.slackPosts.set(key, {
        status,
        channel,
        messageTs,
        nextAttemptAt,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      });
      return this.result(1);
    }

    if (this.query.includes("SET status = 'pending'") && this.query.includes("status = 'sending'")) {
      const [sessionId, promptId, stage, now] = this.bound as [string, string, string, number];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (!row || row.status !== "sending" || (row.leaseExpiresAt ?? Number.POSITIVE_INFINITY) > now) {
        return this.result(0);
      }
      row.status = "pending";
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return this.result(1);
    }

    if (this.query.includes("SET status = 'exhausted'")) {
      const [sessionId, promptId, stage, maxAttempts] = this.bound as [string, string, string, number];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (!row || row.status !== "pending" || row.attemptCount < maxAttempts) {
        return this.result(0);
      }
      row.status = "exhausted";
      row.nextAttemptAt = null;
      row.lastError ??= "max_attempts_exhausted";
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return this.result(1);
    }

    if (this.query.includes("status = CASE WHEN attempt_count")) {
      const [maxAttempts, , nextAttemptAt, error, sessionId, promptId, stage] = this.bound as [
        number,
        number,
        number,
        string,
        string,
        string,
        string,
      ];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (!row || row.status !== "sending") {
        return this.result(0);
      }
      row.status = row.attemptCount >= maxAttempts ? "exhausted" : "pending";
      row.nextAttemptAt = row.attemptCount >= maxAttempts ? null : nextAttemptAt;
      row.lastError = error;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return this.result(1);
    }

    if (this.query.includes("SET status = 'sending'")) {
      const [leaseOwner, leaseExpiresAt, sessionId, promptId, stage, now, maxAttempts] = this.bound as [
        string,
        number,
        string,
        string,
        string,
        number,
        number,
      ];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (
        !row ||
        row.status !== "pending" ||
        (row.nextAttemptAt !== null && row.nextAttemptAt > now) ||
        row.attemptCount >= maxAttempts
      ) {
        return this.result(0);
      }
      row.status = "sending";
      row.attemptCount += 1;
      row.leaseOwner = leaseOwner;
      row.leaseExpiresAt = leaseExpiresAt;
      row.lastError = null;
      return this.result(1);
    }

    if (this.query.includes("SET message_ts = ?") && this.query.includes("status = 'delivered'")) {
      const [messageTs, sessionId, promptId, stage] = this.bound as [string, string, string, string];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (!row) {
        return this.result(0);
      }
      row.messageTs = messageTs;
      row.status = "delivered";
      row.nextAttemptAt = null;
      row.lastError = null;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return this.result(1);
    }

    return this.result(0);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (
      this.query.includes("SELECT session_id, prompt_id, stage, attempt_count") &&
      this.query.includes("FROM slack_posts")
    ) {
      const [sessionId, now] = this.bound as [string, number, number];
      const retryStages = new Set(SLACK_POST_RETRY_STAGES);
      return {
        results: [...this.db.slackPosts.entries()]
          .filter(([key, row]) => {
            const [rowSessionId, , stage] = key.split(":");
            return (
              rowSessionId === sessionId &&
              retryStages.has(stage) &&
              (row.status === "sending" || row.status === "pending") &&
              (row.status === "sending" || row.nextAttemptAt === null || row.nextAttemptAt <= now)
            );
          })
          .map(([key, row]) => {
            const [rowSessionId, promptId, stage] = key.split(":");
            return {
              session_id: rowSessionId,
              prompt_id: promptId,
              stage,
              attempt_count: row.attemptCount,
            };
          }),
      };
    }

    return { results: [] };
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("status = CASE WHEN attempt_count") && this.query.includes("RETURNING status")) {
      const [maxAttempts, , nextAttemptAt, error, sessionId, promptId, stage] = this.bound as [
        number,
        number,
        number,
        string,
        string,
        string,
        string,
      ];
      const row = this.db.slackPosts.get(this.db.key(sessionId, promptId, stage));
      if (!row || row.status !== "sending") {
        return null;
      }
      row.status = row.attemptCount >= maxAttempts ? "exhausted" : "pending";
      row.nextAttemptAt = row.attemptCount >= maxAttempts ? null : nextAttemptAt;
      row.lastError = error;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      return { status: row.status };
    }

    return null;
  }

  private result(changes: number): { success: true; meta: { changes: number; last_row_id: number } } {
    return { success: true, meta: { changes, last_row_id: 0 } };
  }
}

class SlackPostD1 {
  readonly slackPosts = new Map<string, SlackPostRow>();

  prepare(query: string): SlackPostD1Statement {
    return new SlackPostD1Statement(this, query);
  }

  async batch(statements: SlackPostD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  key(sessionId: string, promptId: string, stage: string): string {
    return `${sessionId}:${promptId}:${stage}`;
  }
}

type TestSessionDO = {
  fetch(request: Request): Promise<Response>;
  recoverMissingSlackNotifications(sessionId: string): Promise<void>;
  notifySlackSessionStopped(sessionId: string): Promise<void>;
  stopSessionAtDurabilityBoundary(
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    reason: string,
    options: { stopReason: doDb.SandboxStopReason | null },
  ): Promise<unknown>;
  closeSessionAtDurabilityBoundary(
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    reason: string,
    closeMetadata?: Record<string, unknown>,
  ): Promise<unknown>;
  cachedSandboxConnectionGen: number | null;
  sandboxWs: unknown | null;
};

describe("Slack notification for idle user stops", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let createSessionSlackNotifications: typeof import("../../../apps/control-plane-worker/src/session/slack-notifications.ts").createSessionSlackNotifications;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let d1: SlackPostD1;
  let agent: TestSessionDO;

  const sessionId = "slack-idle-stop-session";

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
    ({ createSessionSlackNotifications } =
      await import("../../../apps/control-plane-worker/src/session/slack-notifications.ts"));
  }, 30_000);

  beforeEach(() => {
    mockResolveSlackBotTokenForCallback.mockReset().mockResolvedValue("xoxb-test-token");
    mockReportSlackPostFailure.mockReset().mockResolvedValue(undefined);
    mockPostThreadReply.mockReset().mockResolvedValue({ ok: true, ts: "200.100" });
    mockUpdateSlackStatusStageInPlace.mockReset().mockResolvedValue(true);
    state = createFakeState();
    d1 = new SlackPostD1();
    env = {
      ...createTestEnv(),
      DB: d1,
      FRONTEND_URL: "https://app.example.com",
    };
    agent = new SessionDO(state as never, env as never) as unknown as TestSessionDO;
  });

  function seedSlackSession(overrides: Record<string, unknown> = {}): void {
    doDb.createSession(state.storage.sql, {
      sessionId,
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
        ...overrides,
      },
    });
  }

  function attachReadySandbox(): void {
    seedSandboxState(state.storage, {
      sessionId,
      status: "ready",
      sandboxId: "sandbox-1",
    });
    const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    state.acceptWebSocket(sandboxSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);
    agent.cachedSandboxConnectionGen = 1;
    agent.sandboxWs = sandboxSocket;
  }

  function createNotifications() {
    return createSessionSlackNotifications({
      state: state as never,
      env: env as never,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      sql: state.storage.sql,
      rescheduleSessionAlarm: vi.fn(async () => undefined),
    });
  }

  it("does NOT post to Slack when the UI stops an idle non-verifier session (live-idle soft stop)", async () => {
    // resume-stopped-session: a non-verifier idle user stop keeps the sandbox live-idle
    // (stopSessionKeepAlive, no boundary) and does NOT route through the stop-notification
    // path. The stop-notification-copy for the live-idle path is deferred (design residual Q2),
    // so the boundary Slack reply + terminal stage update no longer fire here.
    seedSlackSession();
    attachReadySandbox();

    const response = await agent.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    await state.flushWaitUntil();

    expect(response.status).toBe(200);
    // Sandbox stays live — no pause boundary.
    expect(doDb.getSandboxState(state.storage.sql, sessionId)?.status).toBe("ready");
    // No Slack thread reply and no terminal "stopped" stage update on the soft-stop path.
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockUpdateSlackStatusStageInPlace).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, stage: "stopped" }),
    );
  });

  it("still posts to Slack when the UI stops an idle VERIFIER session (decision #8 keeps the pause boundary)", async () => {
    // Verifier sessions keep pausing on stop, so the boundary Slack reply is unchanged.
    seedSlackSession({ askMessageTs: "150.000" });
    state.storage.sql.exec("UPDATE session SET agent_role='verification' WHERE session_id=?", sessionId);
    attachReadySandbox();

    const response = await agent.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    await state.flushWaitUntil();

    expect(response.status).toBe(200);
    expect(doDb.getSandboxState(state.storage.sql, sessionId)?.status).toBe("stopped");
    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    // Routed through the thread-budget path (no ask anchor → new post, no blocks).
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test-token",
      "C123",
      "100.000",
      "🛑 Session stopped from the dashboard. <https://app.example.com/sessions/slack-idle-stop-session|View session>",
      undefined,
    );
    expect(mockUpdateSlackStatusStageInPlace).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, stage: "stopped" }),
    );
    expect(doDb.getSessionExtended(state.storage.sql, sessionId)?.callbackContext).toMatchObject({
      askMessageTs: "150.000",
    });
  });

  it("does not post when the session is not Slack-sourced", async () => {
    doDb.createSession(state.storage.sql, { sessionId, ownerUserId: "1" });

    await agent.notifySlackSessionStopped(sessionId);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("does not post for a non-user stop reason", async () => {
    seedSlackSession();
    seedSandboxState(state.storage, { sessionId, status: "ready" });
    const session = doDb.getSession(state.storage.sql, sessionId);
    expect(session).toBeDefined();

    await agent.stopSessionAtDurabilityBoundary(session!, "sandbox_disconnected", { stopReason: "reaped" });
    await state.flushWaitUntil();

    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(mockUpdateSlackStatusStageInPlace).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, stage: "stopped" }),
    );
  });

  it("does not post when no Slack bot token resolves", async () => {
    seedSlackSession();
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    await agent.notifySlackSessionStopped(sessionId);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("does not post a top-level channel message when threadTs is missing", async () => {
    seedSlackSession({ threadTs: "" });

    await agent.notifySlackSessionStopped(sessionId);

    expect(mockResolveSlackBotTokenForCallback).not.toHaveBeenCalled();
    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("does not post an archive notification when the session is not Slack-sourced", async () => {
    doDb.createSession(state.storage.sql, { sessionId, ownerUserId: "1" });

    await createNotifications().notifySlackSessionArchived(sessionId);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(d1.slackPosts.size).toBe(0);
  });

  it("does not claim an archive notification when no Slack bot token resolves", async () => {
    seedSlackSession();
    mockResolveSlackBotTokenForCallback.mockResolvedValueOnce(null);

    await createNotifications().notifySlackSessionArchived(sessionId);

    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(d1.slackPosts.size).toBe(0);
  });

  it("does not claim an archive notification when thread routing is missing", async () => {
    seedSlackSession({ threadTs: "" });

    await createNotifications().notifySlackSessionArchived(sessionId);

    expect(mockResolveSlackBotTokenForCallback).not.toHaveBeenCalled();
    expect(mockPostThreadReply).not.toHaveBeenCalled();
    expect(d1.slackPosts.size).toBe(0);
  });

  it("claims the archive notification stage so repeated attempts post once", async () => {
    seedSlackSession();
    const notifications = createNotifications();

    await notifications.notifySlackSessionArchived(sessionId);
    await notifications.notifySlackSessionArchived(sessionId);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test-token",
      "C123",
      "100.000",
      "📦 Session archived. <https://app.example.com/sessions/slack-idle-stop-session|View session>",
      undefined,
    );
    expect(d1.slackPosts.get(d1.key(sessionId, "session-archived", "session_archived"))).toMatchObject({
      status: "delivered",
      messageTs: "200.100",
    });
  });

  it("reports archive post failures without scheduling a retry", async () => {
    seedSlackSession();
    mockPostThreadReply.mockResolvedValueOnce({ ok: false, error: "ratelimited" });
    const notifications = createNotifications();

    await notifications.notifySlackSessionArchived(sessionId);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    expect(mockReportSlackPostFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: "notifySlackSessionArchived",
        sessionId,
        stage: "session_archived",
        slackErrorCode: "ratelimited",
      }),
    );
    expect(d1.slackPosts.get(d1.key(sessionId, "session-archived", "session_archived"))).toMatchObject({
      status: "sending",
      messageTs: null,
      lastError: null,
    });

    await notifications.recoverMissingSlackNotifications(sessionId);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
  });

  it("posts an archive notification when the close boundary has the dashboard archive source", async () => {
    seedSlackSession();
    const session = doDb.getSession(state.storage.sql, sessionId);
    expect(session).toBeDefined();

    await agent.closeSessionAtDurabilityBoundary(session!, "user_closed", { closeSource: "dashboard_archive" });
    await state.flushWaitUntil();

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    expect(mockPostThreadReply).toHaveBeenCalledWith(
      "xoxb-test-token",
      "C123",
      "100.000",
      "📦 Session archived. <https://app.example.com/sessions/slack-idle-stop-session|View session>",
      undefined,
    );
  });

  it("does not post an archive notification for Slack-native user_closed closes without a source", async () => {
    seedSlackSession();
    const session = doDb.getSession(state.storage.sql, sessionId);
    expect(session).toBeDefined();

    await agent.closeSessionAtDurabilityBoundary(session!, "user_closed");
    await state.flushWaitUntil();

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("does not post an archive notification for reaper close sources", async () => {
    seedSlackSession();
    const session = doDb.getSession(state.storage.sql, sessionId);
    expect(session).toBeDefined();

    await agent.closeSessionAtDurabilityBoundary(session!, "terminal_stale", {
      closeSource: "session_phase_reaper",
    });
    await state.flushWaitUntil();

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });

  it("claims the stop notification stage so repeated stop finalization posts once", async () => {
    seedSlackSession();
    seedSandboxState(state.storage, { sessionId, status: "ready" });
    const session = doDb.getSession(state.storage.sql, sessionId);
    expect(session).toBeDefined();

    await agent.stopSessionAtDurabilityBoundary(session!, "user", { stopReason: "user" });
    await state.flushWaitUntil();
    await agent.stopSessionAtDurabilityBoundary(session!, "user", { stopReason: "user" });
    await state.flushWaitUntil();

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    expect(d1.slackPosts.get(d1.key(sessionId, "session-stopped", "session_stopped"))).toMatchObject({
      status: "delivered",
      messageTs: "200.100",
    });
  });

  it("marks failed Slack posts pending and recovers them through the retry sweep", async () => {
    seedSlackSession();
    mockPostThreadReply.mockResolvedValueOnce({ ok: false, error: "ratelimited" });

    await agent.notifySlackSessionStopped(sessionId);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    const row = d1.slackPosts.get(d1.key(sessionId, "session-stopped", "session_stopped"));
    expect(row).toMatchObject({
      status: "pending",
      messageTs: null,
      lastError: "session_stopped_api_error",
    });
    row!.nextAttemptAt = 0;

    await agent.recoverMissingSlackNotifications(sessionId);

    expect(mockPostThreadReply).toHaveBeenCalledTimes(2);
    expect(d1.slackPosts.get(d1.key(sessionId, "session-stopped", "session_stopped"))).toMatchObject({
      status: "delivered",
      messageTs: "200.100",
    });
  });
});
