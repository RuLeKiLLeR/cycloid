import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const QA_LOOP_BINDINGS_MIGRATION = readFileSync(
  resolve(__dirname, "../../../apps/control-plane-worker/migrations/0221_qa_loop_session_bindings.sql"),
  "utf-8",
);

function newSqlite(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(QA_LOOP_BINDINGS_MIGRATION);
  return sqlite;
}

const mockCreateSessionState = vi.fn();
const mockEnqueueSessionPrompt = vi.fn();
const mockCloseSessionState = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockUpsertSessionWebhookRef = vi.fn();
const mockCountVerificationSessionsByGithubPrRef = vi.fn();
const mockFindActiveVerificationSession = vi.fn();
const mockSyncVerificationStateForPr = vi.fn();
const mockSyncVerificationResultForPr = vi.fn();
const mockGetSessionState = vi.fn();
const mockPostStructuredEventToDd = vi.fn();
const mockCheckVerificationConflict = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB?: D1Database }) => {
    if (!env.DB) throw new Error("D1 binding DB is not configured");
    return env.DB;
  },
  createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
  enqueueSessionPrompt: (...args: unknown[]) => mockEnqueueSessionPrompt(...args),
  closeSessionState: (...args: unknown[]) => mockCloseSessionState(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  countVerificationSessionsByGithubPrRef: (...args: unknown[]) => mockCountVerificationSessionsByGithubPrRef(...args),
  upsertSessionWebhookRef: (...args: unknown[]) => mockUpsertSessionWebhookRef(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/verification-gate", () => ({
  checkVerificationConflict: (...args: unknown[]) => mockCheckVerificationConflict(...args),
  checkVerificationRunLimit: async (...args: unknown[]) => {
    const maxRuns = typeof args[3] === "number" ? args[3] : 3;
    const currentRuns = Number(await mockCountVerificationSessionsByGithubPrRef(...args));
    if (currentRuns >= maxRuns) {
      return {
        allowed: false,
        reason: "verification_run_limit_reached",
        currentRuns,
        maxRuns,
      };
    }
    return { allowed: true, currentRuns, maxRuns };
  },
  findActiveVerificationSession: (...args: unknown[]) => mockFindActiveVerificationSession(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/verification-state", () => ({
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
  syncVerificationResultForPr: (...args: unknown[]) => mockSyncVerificationResultForPr(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import { scheduleVerificationForPr } from "../../../apps/control-plane-worker/src/session/verification-spawn";

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

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

function activeVerifierSession(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    agentRole: "verification",
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const sqlite = newSqlite();
  const db = new SqliteD1(sqlite) as unknown as D1Database;
  return {
    env: { DB: db, ARCANIST_OPENAI_API_KEY: "sk-test" },
    logger,
    parentSessionId: "parent-session",
    parentPromptId: "parent-prompt",
    ownerUserId: "1001",
    businessId: "biz-1",
    repoOwner: "acme",
    repoName: "repo",
    installationId: 123,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "deadbeef",
    agentRole: "implementation",
    ...overrides,
  };
}

describe("automatic verification scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckVerificationConflict.mockResolvedValue({ skip: false });
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValue(0);
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockSyncVerificationStateForPr.mockResolvedValue(undefined);
    mockSyncVerificationResultForPr.mockResolvedValue(undefined);
    mockPostStructuredEventToDd.mockResolvedValue(true);
    // Default: parent session unresolved -> verifier falls back to the codex default.
    mockGetSessionState.mockResolvedValue(null);
    mockCreateSessionState.mockResolvedValue({
      session: {
        sessionId: "verification-session",
        ownerUserId: "1001",
        businessId: "biz-1",
        status: "active",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        closedAt: null,
        lastEventId: null,
        title: null,
        sessionKind: "repo",
        repoOwner: "acme",
        repoName: "repo",
      },
      replay: {
        sessionId: "verification-session",
        lastEventSequence: 0,
        lastEventTimestamp: null,
        updatedAt: null,
      },
    });
    mockEnqueueSessionPrompt.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        session: {
          sessionId: "verification-session",
          ownerUserId: "1001",
          businessId: "biz-1",
          status: "active",
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:01.000Z",
          closedAt: null,
          lastEventId: null,
          title: null,
          sessionKind: "repo",
        },
        replay: {
          sessionId: "verification-session",
          lastEventSequence: 1,
          lastEventTimestamp: "2026-06-05T00:00:01.000Z",
          updatedAt: "2026-06-05T00:00:01.000Z",
        },
      },
      error: null,
    });
    mockCloseSessionState.mockResolvedValue({
      session: {
        sessionId: "verification-session",
        ownerUserId: "1001",
        businessId: "biz-1",
        status: "closed",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:02.000Z",
        closedAt: "2026-06-05T00:00:02.000Z",
        lastEventId: null,
        title: null,
        sessionKind: "repo",
      },
      replay: {
        sessionId: "verification-session",
        lastEventSequence: 1,
        lastEventTimestamp: "2026-06-05T00:00:02.000Z",
        updatedAt: "2026-06-05T00:00:02.000Z",
      },
    });
  });

  it("defaults to auto and schedules verification after review-loop completion", async () => {
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        agentRole: "verification",
        agentProfile: "verify",
        targetPrUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(expect.anything(), {
      event: "qa_tester.routing.decided",
      needs_verification: true,
      needs_app_runtime: false,
      verification_reason_code: "review_loop_done",
      runtime_reason_code: "planner_controlled",
      fail_closed: false,
      confidence: "deterministic",
      pr_url: "https://github.com/acme/repo/pull/42",
      head_sha: "deadbeef",
      parent_session_id: "parent-session",
    });
  });

  it("runs a mid codex parent verifier on gpt-5.4/codex", async () => {
    mockGetSessionState.mockResolvedValue({ model: "gpt-5.4", agentRuntimeBackend: "codex" });
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockGetSessionState).toHaveBeenCalledWith(expect.anything(), "parent-session", undefined);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ model: "gpt-5.4", agentRuntimeBackend: "codex" }),
    );
  });

  it("runs a claude_code frontier parent verifier on claude-opus-4-8/claude_code", async () => {
    mockGetSessionState.mockResolvedValue({ model: "claude-opus-4-8", agentRuntimeBackend: "claude_code" });
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ model: "claude-opus-4-8", agentRuntimeBackend: "claude_code" }),
    );
  });

  it("runs a claude_code mid parent verifier on claude-sonnet-4-6/claude_code", async () => {
    mockGetSessionState.mockResolvedValue({ model: "claude-sonnet-4-6", agentRuntimeBackend: "claude_code" });
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ model: "claude-sonnet-4-6", agentRuntimeBackend: "claude_code" }),
    );
  });

  it("falls back to the codex frontier default when the parent session can't be loaded", async () => {
    mockGetSessionState.mockResolvedValue(null);
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ model: "gpt-5.4", agentRuntimeBackend: "codex" }),
    );
  });

  it("falls back to the default and still schedules when parent session load throws", async () => {
    mockGetSessionState.mockRejectedValue(new Error("DO unavailable"));
    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ model: "gpt-5.4", agentRuntimeBackend: "codex" }),
    );
  });

  it("skips re-scheduling when a settled verdict is stamped for THIS head (positively-identified no-op)", async () => {
    const input = baseInput({
      currentVerificationState: "verification-done",
      currentVerificationResult: "merge-ready",
      // Stamp matches the head being settled → a content no-op the call-site already validated.
      currentVerificationVerdictHeadSha: "deadbeef",
    });
    await expect(scheduleVerificationForPr(input)).resolves.toEqual({
      scheduled: false,
      reason: "verdict_already_settled",
    });
    // Short-circuits before verifier session creation.
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("skips re-scheduling for a verification-exhausted or -skipped verdict stamped for this head", async () => {
    await expect(
      scheduleVerificationForPr(
        baseInput({
          currentVerificationState: "verification-exhausted",
          currentVerificationVerdictHeadSha: "deadbeef",
        }),
      ),
    ).resolves.toEqual({ scheduled: false, reason: "verdict_already_settled" });
    await expect(
      scheduleVerificationForPr(
        baseInput({ currentVerificationState: "verification-skipped", currentVerificationVerdictHeadSha: "deadbeef" }),
      ),
    ).resolves.toEqual({ scheduled: false, reason: "verdict_already_settled" });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("does NOT skip (re-verifies) when a settled verdict is stamped for a DIFFERENT head (failed-clear self-heal)", async () => {
    // A real content change whose best-effort verdict clear silently failed leaves an outdated settled
    // verdict stamped for the OLD head. The new head differs from the stamp, so it must re-verify.
    const input = baseInput({
      currentVerificationState: "verification-done",
      currentVerificationResult: "merge-ready",
      currentVerificationVerdictHeadSha: "old-head",
    });
    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });
  });

  it("does NOT skip when a settled verdict has no head stamp (cannot positively identify a no-op)", async () => {
    const input = baseInput({
      currentVerificationState: "verification-done",
      currentVerificationResult: "merge-ready",
      // currentVerificationVerdictHeadSha omitted → null.
    });
    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });
  });

  it("skips scheduling when the PR has a confirmed merge conflict without consuming an attempt", async () => {
    mockCheckVerificationConflict.mockResolvedValueOnce({ skip: true, reason: "merge_conflict" });

    await expect(scheduleVerificationForPr(baseInput())).resolves.toEqual({
      scheduled: false,
      reason: "merge_conflict",
    });

    expect(mockCheckVerificationConflict).toHaveBeenCalledWith(expect.anything(), logger, {
      prUrl: "https://github.com/acme/repo/pull/42",
      installationId: 123,
      repoOwner: "acme",
      repoName: "repo",
    });
    expect(mockCountVerificationSessionsByGithubPrRef).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/repo/pull/42",
        state: "verification-stopped",
        sessionIds: ["parent-session"],
        installationId: 123,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  it("allows scheduling through a confirmed merge conflict when explicitly requested", async () => {
    mockCheckVerificationConflict.mockResolvedValueOnce({ skip: true, reason: "merge_conflict" });

    await expect(scheduleVerificationForPr(baseInput({ allowMergeConflict: true }))).resolves.toMatchObject({
      scheduled: true,
    });

    expect(mockCountVerificationSessionsByGithubPrRef).toHaveBeenCalled();
    expect(mockCreateSessionState).toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/repo/pull/42",
        state: "verification-stopped",
      }),
    );
  });

  it("still schedules when awaiting a verdict (null state) or for a needs-work re-engage", async () => {
    await expect(
      scheduleVerificationForPr(
        baseInput({ currentVerificationState: null, currentVerificationVerdictHeadSha: "deadbeef" }),
      ),
    ).resolves.toMatchObject({ scheduled: true });
    await expect(
      scheduleVerificationForPr(
        baseInput({
          currentVerificationState: "verification-done",
          currentVerificationResult: "needs-work",
          currentVerificationVerdictHeadSha: "deadbeef",
        }),
      ),
    ).resolves.toMatchObject({ scheduled: true });
  });

  it("skips scheduling when the session opted out of auto-verification", async () => {
    await expect(scheduleVerificationForPr(baseInput({ autoVerifyDisabled: true }))).resolves.toEqual({
      scheduled: false,
      reason: "auto_verify_disabled",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("skips review-loop completion scheduling for opted-out sessions", async () => {
    await expect(scheduleVerificationForPr(baseInput({ autoVerifyDisabled: true }))).resolves.toEqual({
      scheduled: false,
      reason: "auto_verify_disabled",
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  // ARC-1330 D-50A — the "honors disabled policy → policy_not_auto" test was removed: D7 always-on drops
  // the env-level `VerificationPolicy` arm entirely (the `resolveVerificationPolicy` helper is deleted).

  // ── W11-V3 — the FSM-native spawn path (`fsmNative: true`, the ONLY live caller post-flip) ──
  describe("fsmNative path (W11-V3 a/b/c)", () => {
    it("(c) HONORS the #6395 per-user auto-verify opt-out: declined with the structured auto_verify_disabled skip, NO spawn", async () => {
      // Review fix (adversarial): the opted-out cohort is reachable at REVIEW→VERIFYING by construction,
      // and silently overriding the user-facing toggle is not this refactor's call — the FSM path
      // declines exactly like the legacy arm (the executor surfaces it as a first-class structured skip).
      // D7 always-on vs the toggle is an OPEN Jag decision; this pins current behavior.
      await expect(
        scheduleVerificationForPr(baseInput({ autoVerifyDisabled: true, fsmNative: true })),
      ).resolves.toEqual({ scheduled: false, reason: "auto_verify_disabled" });
      expect(mockCreateSessionState).not.toHaveBeenCalled();
      expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    });

    it("(c) env-policy fold: schedules even when VERIFICATION_POLICY=disabled (policy arm not consulted)", async () => {
      await expect(
        scheduleVerificationForPr(
          baseInput({ env: { DB: baseInput().env.DB, VERIFICATION_POLICY: "disabled" }, fsmNative: true }),
        ),
      ).resolves.toMatchObject({ scheduled: true });
      expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    });

    it("keeps the STRUCTURAL verifier-role gate (a verifier child must never spawn a verifier)", async () => {
      await expect(
        scheduleVerificationForPr(baseInput({ agentRole: "verification", fsmNative: true })),
      ).resolves.toEqual({ scheduled: false, reason: "verification_session" });
      expect(mockCreateSessionState).not.toHaveBeenCalled();
    });

    it("does not schedule QA from the independent code-review agent", async () => {
      await expect(scheduleVerificationForPr(baseInput({ agentRole: "review", fsmNative: true }))).resolves.toEqual({
        scheduled: false,
        reason: "review_session",
      });
      expect(mockCreateSessionState).not.toHaveBeenCalled();
    });

    it("legacy path (fsmNative omitted) still honors the per-user opt-out (D-50A: no comment)", async () => {
      // ARC-1330 D-50A collapsed the two paths: both honor the #6395 `auto_verify_disabled` opt-out and
      // neither consults the removed env-level policy arm. `fsmNative` now only gates the A1 shadow-drive.
      await expect(scheduleVerificationForPr(baseInput({ autoVerifyDisabled: true }))).resolves.toEqual({
        scheduled: false,
        reason: "auto_verify_disabled",
      });
      await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({
        scheduled: true,
      });
    });
  });

  it("schedules a verifier session for an auto-policy review-loop completion", async () => {
    const input = baseInput({
      env: {
        DB: baseInput().env.DB,
        ARCANIST_OPENAI_API_KEY: "sk-test",
        VERIFICATION_POLICY: "auto_after_review_loop",
      },
    });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });

    expect(mockCreateSessionState).toHaveBeenCalledWith(
      input.env,
      expect.any(String),
      "1001",
      expect.objectContaining({
        sessionKind: "repo",
        repoContext: { repoOwner: "acme", repoName: "repo" },
        installationId: 123,
        businessId: "biz-1",
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        verificationRuntimeMode: "none",
        targetPrUrl: "https://github.com/acme/repo/pull/42",
      }),
    );
    expect(mockFindActiveVerificationSession).toHaveBeenCalledWith(
      input.env,
      logger,
      "https://github.com/acme/repo/pull/42",
    );
    expect(mockSyncSessionProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        parentContext: {
          parentSessionId: "parent-session",
          parentPromptId: "parent-prompt",
          spawnedByUserId: 1001,
          spawnDepth: 1,
        },
      }),
    );
    expect(mockUpsertSessionWebhookRef).toHaveBeenCalledWith(
      input.env.DB,
      "github_pr_url",
      "https://github.com/acme/repo/pull/42",
      expect.any(String),
    );
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
      input.env,
      expect.any(String),
      expect.stringContaining("qa=true"),
      "1001",
      expect.objectContaining({ agent: "verify" }),
    );
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      input.env,
      expect.objectContaining({
        prUrl: "https://github.com/acme/repo/pull/42",
        state: "verification-in-progress",
        sessionIds: ["parent-session"],
        attemptCount: 1,
        installationId: 123,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
    // A new run must clear the previous run's verdict — an outdated needs-work would otherwise keep
    // reading as current while this run is in progress.
    expect(mockSyncVerificationResultForPr).toHaveBeenCalledWith(
      input.env,
      expect.objectContaining({
        prUrl: "https://github.com/acme/repo/pull/42",
        result: null,
        sessionIds: ["parent-session"],
      }),
    );
  });

  it("reuses the same verifier session for later automatic QA in the same PR lifecycle", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
    };
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const first = await scheduleVerificationForPr(baseInput({ env, headSha: "head-one" }));
    expect(first).toMatchObject({ scheduled: true });
    if (!first.scheduled) throw new Error("first schedule failed");
    const firstSessionId = first.sessionId;
    mockGetSessionState.mockImplementation(async (_env, sessionId) =>
      sessionId === firstSessionId ? activeVerifierSession({ sessionId: firstSessionId }) : null,
    );
    mockFindActiveVerificationSession.mockResolvedValueOnce({ sessionId: firstSessionId });

    const second = await scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }));
    expect(second).toEqual({ scheduled: true, sessionId: firstSessionId });

    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledTimes(2);
    expect(mockEnqueueSessionPrompt.mock.calls[0]?.[1]).toBe(firstSessionId);
    expect(mockEnqueueSessionPrompt.mock.calls[1]?.[1]).toBe(firstSessionId);
    expect(mockEnqueueSessionPrompt.mock.calls[0]?.[2]).toContain("Target head SHA: head-one");
    expect(mockEnqueueSessionPrompt.mock.calls[1]?.[2]).toContain("Target head SHA: head-two");
    expect(mockEnqueueSessionPrompt.mock.calls[1]?.[2]).toContain(
      "This is another automated QA pass for the same PR lifecycle",
    );
    expect(
      sqlite
        .prepare(
          `SELECT qa_session_id, parent_session_id, last_scheduled_head_sha
           FROM qa_loop_session_bindings
           WHERE pr_url = ? AND automated_lifecycle_id = ?`,
        )
        .get("https://github.com/acme/repo/pull/42", "parent-session"),
    ).toEqual({
      qa_session_id: firstSessionId,
      parent_session_id: "parent-session",
      last_scheduled_head_sha: "head-two",
    });
  });

  it("at FSM_MODE=live the legacy lifetime/lifecycle counts are advisory — the FSM cap is sole authority (W11-V7 pin, flipped at D-51)", async () => {
    // Same exhausted-lifecycle setup as the shadow veto test below, but at live the
    // FSM's under_verification_cap already admitted this spawn on the dispatch edge;
    // a legacy decline here would strand the committed VERIFYING row until the
    // deadline (false NEEDS_YOU on the pass-reset cohort).
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
      FSM_MODE: "live",
    };
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(scheduleVerificationForPr(baseInput({ env, headSha: "head-one" }))).resolves.toMatchObject({
      scheduled: true,
    });
    const firstSessionId = mockCreateSessionState.mock.calls[0]?.[1] as string;
    mockCreateSessionState.mockClear();
    mockEnqueueSessionPrompt.mockClear();
    mockSyncVerificationStateForPr.mockClear();
    mockGetSessionState.mockImplementation(async (_env, sessionId) => {
      if (sessionId === firstSessionId)
        return { ...activeVerifierSession({ sessionId: firstSessionId }), status: "closed", rich_status: "completed" };
      if (sessionId === "parent-session") return { verificationAttemptCount: 3 };
      return null;
    });

    await expect(scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }))).resolves.toMatchObject({
      scheduled: true,
    });
    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-exhausted" }),
    );
  });

  it("uses the lifecycle attempt count when run-limiting a reused automatic QA verifier", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
    };
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(scheduleVerificationForPr(baseInput({ env, headSha: "head-one" }))).resolves.toMatchObject({
      scheduled: true,
    });
    const firstSessionId = mockCreateSessionState.mock.calls[0]?.[1] as string;
    mockCreateSessionState.mockClear();
    mockEnqueueSessionPrompt.mockClear();
    mockGetSessionState.mockImplementation(async (_env, sessionId) => {
      if (sessionId === firstSessionId) return activeVerifierSession({ sessionId: firstSessionId });
      if (sessionId === "parent-session") return { verificationAttemptCount: 3 };
      return null;
    });

    // D-60: the lifecycle attempt count (3/3) is now advisory — it no longer declines the reused verifier
    // (the FSM `under_verification_cap` guard owns admission). Scheduling proceeds; no exhausted-state write.
    await expect(scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }))).resolves.toMatchObject({
      scheduled: true,
    });
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-exhausted" }),
    );
  });

  it("does not persist a lifecycle binding when first automatic QA prompt enqueue fails", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const input = baseInput({
      env: {
        DB: db,
        ARCANIST_OPENAI_API_KEY: "sk-test",
        VERIFICATION_POLICY: "auto_after_review_loop",
      },
    });
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 500,
      payload: null,
      error: "enqueue down",
    });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({
      scheduled: false,
      reason: "schedule_failed",
      error: "enqueue down",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM qa_loop_session_bindings").get()).toEqual({ count: 0 });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledTimes(2);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM qa_loop_session_bindings WHERE status = 'active'").get(),
    ).toEqual({
      count: 1,
    });
  });

  it("expires a stale lifecycle binding and creates a replacement verifier session", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
    };

    const first = await scheduleVerificationForPr(baseInput({ env, headSha: "head-one" }));
    expect(first).toMatchObject({ scheduled: true });
    if (!first.scheduled) throw new Error("first schedule failed");

    mockCreateSessionState.mockClear();
    mockEnqueueSessionPrompt.mockClear();
    mockGetSessionState.mockImplementation(async (_env, sessionId) =>
      sessionId === first.sessionId ? { status: "archived", agentRole: "verification" } : null,
    );

    const second = await scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }));

    expect(second).toMatchObject({ scheduled: true });
    if (!second.scheduled) throw new Error("second schedule failed");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSessionPrompt).toHaveBeenCalledWith(
      env,
      second.sessionId,
      expect.stringContaining("Target head SHA: head-two"),
      "1001",
      expect.objectContaining({ agent: "verify" }),
    );
    expect(
      sqlite
        .prepare(
          `SELECT qa_session_id, status, last_scheduled_head_sha
           FROM qa_loop_session_bindings
           WHERE pr_url = ? AND automated_lifecycle_id = ?`,
        )
        .get("https://github.com/acme/repo/pull/42", "parent-session"),
    ).toEqual({
      qa_session_id: second.sessionId,
      status: "active",
      last_scheduled_head_sha: "head-two",
    });
  });

  it("expires a reused lifecycle binding after enqueue failure so the next attempt can replace it", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
    };

    const first = await scheduleVerificationForPr(baseInput({ env, headSha: "head-one" }));
    expect(first).toMatchObject({ scheduled: true });
    if (!first.scheduled) throw new Error("first schedule failed");

    mockGetSessionState.mockImplementation(async (_env, sessionId) =>
      sessionId === first.sessionId ? activeVerifierSession({ sessionId: first.sessionId }) : null,
    );
    mockEnqueueSessionPrompt.mockResolvedValueOnce({
      ok: false,
      status: 500,
      payload: null,
      error: "enqueue down",
    });

    await expect(scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }))).resolves.toEqual({
      scheduled: false,
      reason: "schedule_failed",
      error: "enqueue down",
      // W11-V3 (#6425): enqueue never succeeded → pre-enqueue, safe for the caller to terminalize.
      failureStage: "pre_enqueue",
      verificationSessionId: undefined,
    });
    expect(
      sqlite
        .prepare(
          `SELECT qa_session_id, status
           FROM qa_loop_session_bindings
           WHERE pr_url = ? AND automated_lifecycle_id = ?`,
        )
        .get("https://github.com/acme/repo/pull/42", "parent-session"),
    ).toEqual({
      qa_session_id: first.sessionId,
      status: "expired",
    });

    const replacement = await scheduleVerificationForPr(baseInput({ env, headSha: "head-two" }));

    expect(replacement).toMatchObject({ scheduled: true });
    if (!replacement.scheduled) throw new Error("replacement schedule failed");
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(
      sqlite
        .prepare(
          `SELECT qa_session_id, status, last_scheduled_head_sha
           FROM qa_loop_session_bindings
           WHERE pr_url = ? AND automated_lifecycle_id = ?`,
        )
        .get("https://github.com/acme/repo/pull/42", "parent-session"),
    ).toEqual({
      qa_session_id: replacement.sessionId,
      status: "active",
      last_scheduled_head_sha: "head-two",
    });
  });

  it("keeps separate verifier session bindings for different automatic PR lifecycles", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const env = {
      DB: db,
      ARCANIST_OPENAI_API_KEY: "sk-test",
      VERIFICATION_POLICY: "auto_after_review_loop",
    };
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const first = await scheduleVerificationForPr(
      baseInput({ env, parentSessionId: "implementation-session-a", headSha: "head-one" }),
    );
    const second = await scheduleVerificationForPr(
      baseInput({ env, parentSessionId: "implementation-session-b", headSha: "head-two" }),
    );

    expect(first).toMatchObject({ scheduled: true });
    expect(second).toMatchObject({ scheduled: true });
    if (!first.scheduled || !second.scheduled) throw new Error("schedule failed");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(mockCreateSessionState).toHaveBeenCalledTimes(2);
    expect(
      sqlite
        .prepare(
          `SELECT automated_lifecycle_id, qa_session_id
           FROM qa_loop_session_bindings
           ORDER BY automated_lifecycle_id`,
        )
        .all(),
    ).toEqual([
      { automated_lifecycle_id: "implementation-session-a", qa_session_id: first.sessionId },
      { automated_lifecycle_id: "implementation-session-b", qa_session_id: second.sessionId },
    ]);
  });

  it("defers runtime need to the planner and starts verifier sessions with runtime disabled", async () => {
    const input = baseInput({
      env: {
        DB: baseInput().env.DB,
        VERIFICATION_POLICY: "auto_after_review_loop",
      },
    });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });

    expect(mockCreateSessionState).toHaveBeenCalledWith(
      input.env,
      expect.any(String),
      "1001",
      expect.objectContaining({
        verificationRuntimeMode: "none",
      }),
    );
    expect(mockEnqueueSessionPrompt.mock.calls[0][2]).toContain("VerificationPlannerArtifact");
    expect(mockEnqueueSessionPrompt.mock.calls[0][2]).not.toContain("needsAppRuntime");
  });

  it("still schedules a verifier for docs-only candidates so the planner owns skip", async () => {
    const input = baseInput({
      env: {
        DB: baseInput().env.DB,
        VERIFICATION_POLICY: "auto_after_review_loop",
      },
    });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });

    expect(mockCreateSessionState).toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      input.env,
      expect.objectContaining({
        prUrl: "https://github.com/acme/repo/pull/42",
        state: "verification-in-progress",
        sessionIds: ["parent-session"],
      }),
    );
  });

  it("does not schedule another verifier while one is active", async () => {
    mockFindActiveVerificationSession.mockResolvedValueOnce({ sessionId: "manual-verifier" });
    const input = baseInput({
      env: {
        DB: baseInput().env.DB,
        ARCANIST_OPENAI_API_KEY: "sk-test",
        VERIFICATION_POLICY: "auto_after_review_loop",
      },
    });

    await expect(scheduleVerificationForPr(input)).resolves.toEqual({
      scheduled: false,
      reason: "active_verification_session_exists",
    });

    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      input.env,
      expect.objectContaining({ state: "verification-skipped" }),
    );
  });

  it("forceNewSession bypasses the advisory active-verifier decline and schedules a fresh verifier", async () => {
    // The forced manual rerun (ARC-1514) already superseded the in-flight verifier via the FSM edge;
    // teardown is best-effort, so the advisory lookup could still see the just-killed child. Asserting the
    // lookup is skipped entirely proves force can't be blocked with active_verification_session_exists (the
    // FSM child-slot anchor owns the real single-verifier boundary).
    await expect(scheduleVerificationForPr(baseInput({ forceNewSession: true }))).resolves.toMatchObject({
      scheduled: true,
    });

    expect(mockFindActiveVerificationSession).not.toHaveBeenCalled();
    expect(mockCreateSessionState).toHaveBeenCalled();
  });

  it("keeps the run scheduled when the result clear fails (non-fatal)", async () => {
    mockSyncVerificationResultForPr.mockRejectedValueOnce(new Error("DO unavailable"));

    await expect(scheduleVerificationForPr(baseInput())).resolves.toMatchObject({
      scheduled: true,
    });
  });

  it("does not clear the verification result when scheduling is skipped", async () => {
    const input = baseInput({ autoVerifyDisabled: true });

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({
      scheduled: false,
      reason: "auto_verify_disabled",
    });

    expect(mockSyncVerificationResultForPr).not.toHaveBeenCalled();
  });

  it("blocks auto-scheduling when an active verifier already exists", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const input = baseInput({ env: { DB: db, VERIFICATION_POLICY: "auto_after_review_loop" } });
    mockFindActiveVerificationSession.mockResolvedValueOnce({ sessionId: "active-verifier" });

    await expect(scheduleVerificationForPr(input)).resolves.toEqual({
      scheduled: false,
      reason: "active_verification_session_exists",
    });

    expect(mockFindActiveVerificationSession).toHaveBeenCalledWith(
      input.env,
      logger,
      "https://github.com/acme/repo/pull/42",
    );
    expect(mockCountVerificationSessionsByGithubPrRef).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("returns schedule_failed when the verifier session create fails before the prompt is enqueued", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const input = baseInput({ env: { DB: db, VERIFICATION_POLICY: "auto_after_review_loop" } });
    mockCreateSessionState.mockRejectedValueOnce(new Error("create down"));

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({
      scheduled: false,
      reason: "schedule_failed",
    });
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  });

  it("no longer vetoes on the legacy run limit — the FSM cap is the sole admission authority (advisory only, D-60)", async () => {
    mockCountVerificationSessionsByGithubPrRef.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const input = baseInput();

    // The legacy lifetime run limit (3/3) is advisory since D-60: it no longer declines a spawn the FSM
    // cap admitted (`under_verification_cap` is enforced on the dispatch edge before this scheduler runs).
    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-exhausted" }),
    );
  });

  it("rolls back the created verifier when persistence fails before enqueue", async () => {
    const sqlite = newSqlite();
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const input = baseInput({ env: { DB: db, VERIFICATION_POLICY: "auto_after_review_loop" } });
    mockSyncSessionProjection.mockRejectedValueOnce(new Error("projection down"));

    await expect(scheduleVerificationForPr(input)).resolves.toEqual({
      scheduled: false,
      reason: "schedule_failed",
      error: "projection down",
      // W11-V3 (#6425): failed before enqueue (child session created but no prompt) → pre-enqueue.
      failureStage: "pre_enqueue",
      verificationSessionId: expect.any(String),
    });
    expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
    expect(mockCloseSessionState).toHaveBeenCalledWith(
      input.env,
      expect.any(String),
      undefined,
      expect.objectContaining({ reason: "auto_verification_scheduling_failed" }),
    );

    await expect(scheduleVerificationForPr(input)).resolves.toMatchObject({ scheduled: true });
    expect(mockCreateSessionState).toHaveBeenCalledTimes(2);
  });
});
