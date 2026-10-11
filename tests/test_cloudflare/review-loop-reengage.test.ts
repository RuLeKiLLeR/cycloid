import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (set up before any imports from mocked modules)
// ---------------------------------------------------------------------------

const mockGetSessionState = vi.fn();
const mockUnarchiveSession = vi.fn();
const mockWarmSession = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  unarchiveSession: (...args: unknown[]) => mockUnarchiveSession(...args),
  warmSession: (...args: unknown[]) => mockWarmSession(...args),
}));

const mockResolveReviewLoopHumanEligibility = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-settings", () => ({
  resolveReviewLoopHumanEligibility: (...args: unknown[]) => mockResolveReviewLoopHumanEligibility(...args),
}));

const mockCreateInstallationToken = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

const mockGetPrState = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getPrState: (...args: unknown[]) => mockGetPrState(...args),
}));

const mockEmitReviewListeningEntered = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/publish-service", () => ({
  emitReviewListeningEntered: (...args: unknown[]) => mockEmitReviewListeningEntered(...args),
}));

const mockBootstrapReviewLoopEpochForHuman = vi.fn();
const mockSelectHumanEpochCarryingSource = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  bootstrapReviewLoopEpochForHuman: (...args: unknown[]) => mockBootstrapReviewLoopEpochForHuman(...args),
  selectHumanEpochCarryingSource: (...args: unknown[]) => mockSelectHumanEpochCarryingSource(...args),
  EMPTY_EXPECTED_BOTS_HASH: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
}));

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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type {
  EnsureSessionLiveResult,
  ReengageResult,
  ReviewEventLite,
} from "../../apps/control-plane-worker/src/services/review-loop-reengage";
import {
  ensureSessionLiveForPr,
  isSessionRuntimeLive,
  reengageSessionForReview,
} from "../../apps/control-plane-worker/src/services/review-loop-reengage";
import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../shared/agent/agent-runtime-backend";
import { ONBOARD_AGENT_NAME } from "../../shared/agent/constants";

// ---------------------------------------------------------------------------
// D1 / SQLite fixture
// ---------------------------------------------------------------------------

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

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReviewEvent(overrides: Partial<ReviewEventLite> = {}): ReviewEventLite {
  return {
    reviewId: 1001,
    prUrl: "https://github.com/acme/repo/pull/42",
    prNumber: 42,
    repoOwner: "acme",
    repoName: "repo",
    headSha: "head-sha-abc",
    reviewAuthor: "alice",
    reviewUserId: 999,
    installationId: 7,
    ...overrides,
  };
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-A",
    ownerUserId: "101",
    status: "active",
    reviewListeningActive: true,
    reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    reviewListeningHeadSha: "old-sha",
    ...overrides,
  };
}

function makeArchivedSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-A",
    ownerUserId: "101",
    status: "archived",
    reviewListeningActive: false,
    ...overrides,
  };
}

const ELIGIBLE_RESULT = { ok: true as const, ownerUserId: 101, installationId: 7 };
const INELIGIBLE_CAPS_MISSING = { ok: false as const, reason: "installation_capabilities_missing" as const };

let sqlite: Database.Database;
let db: D1Database;
let env: { DB: D1Database };

beforeEach(() => {
  sqlite = new Database(":memory:");
  // Load the session_index schema (simplified) for runtime-expiry queries
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id INTEGER,
      status TEXT,
      runtime_state TEXT,
      runtime_state_expires_at INTEGER,
      runtime_live_lease_expires_at INTEGER
    )
  `);
  // Load the epochs table
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  // session_webhook_refs is written by the shared ensureSessionLiveForPr scaffold (idempotent PR ref).
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0002_webhook_session_refs.sql", "utf8"));

  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = { DB: db } as unknown as { DB: D1Database };

  // Reset all mocks
  mockGetSessionState.mockReset();
  mockUnarchiveSession.mockReset().mockResolvedValue({ ok: true, status: "active" });
  mockWarmSession.mockReset().mockResolvedValue({ ok: true });
  mockResolveReviewLoopHumanEligibility.mockReset();
  mockCreateInstallationToken.mockReset().mockResolvedValue("tok-install");
  mockGetPrState.mockReset().mockResolvedValue("open");
  mockEmitReviewListeningEntered
    .mockReset()
    .mockResolvedValue({ ok: true, status: 200, payload: { ok: true, updated: true } });
  mockBootstrapReviewLoopEpochForHuman.mockReset();
  mockSelectHumanEpochCarryingSource.mockReset().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// T9: eligibility and PR-state gates
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — eligibility and PR-state gates", () => {
  it("returns session_not_found when getSessionState returns null", async () => {
    mockGetSessionState.mockResolvedValue(null);
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-A",
      ev: makeReviewEvent({ headSha: "h1" }),
    });

    expect(result.status).toBe("session_not_found");
  });

  it.each([
    ["verification", "verification_session"],
    ["review", "review_session"],
  ] as const)(
    "returns not_eligible for %s sessions before any eligibility or GitHub work",
    async (agentRole, reason) => {
      mockGetSessionState.mockResolvedValue(makeActiveSession({ agentRole }));

      const result = (await reengageSessionForReview({
        env: env as never,
        db,
        sessionId: "sess-A",
        ev: makeReviewEvent({ headSha: "h1" }),
      })) as Extract<ReengageResult, { status: "not_eligible" }>;

      expect(result.status).toBe("not_eligible");
      expect(result.reason).toBe(reason);
      expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
      expect(mockEmitReviewListeningEntered).not.toHaveBeenCalled();
      expect(mockBootstrapReviewLoopEpochForHuman).not.toHaveBeenCalled();
    },
  );

  it("returns not_eligible for onboarding sessions before any eligibility or GitHub work", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ agentProfile: ONBOARD_AGENT_NAME }));

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-A",
      ev: makeReviewEvent({ headSha: "h1" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("onboarding_session");
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockEmitReviewListeningEntered).not.toHaveBeenCalled();
    expect(mockBootstrapReviewLoopEpochForHuman).not.toHaveBeenCalled();
  });

  it("admits opencode sessions into the review loop (Phase 9: no probe-session exemption)", async () => {
    // opencode is no longer exempt — it must proceed past the exemption guard
    // to normal eligibility resolution like codex/claude. Stub eligibility as
    // caps-missing only to short-circuit cleanly once the guard is passed.
    mockGetSessionState.mockResolvedValue(makeActiveSession({ agentRuntimeBackend: OPENCODE_AGENT_RUNTIME_BACKEND }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(INELIGIBLE_CAPS_MISSING);

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-A",
      ev: makeReviewEvent({ headSha: "h1" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalled();
    expect(result.reason).toBe("installation_capabilities_missing");
  });

  it("still reengages a non-onboarding session even when auto-verify is disabled", async () => {
    // The onboarding lockout keys on the onboarding agent profile, NOT
    // autoVerifyDisabled — an autoVerify:false user must keep re-engaging on an
    // explicit human review. Stub eligibility as caps-missing only to
    // short-circuit cleanly once the onboarding guard is passed.
    mockGetSessionState.mockResolvedValue(makeActiveSession({ agentProfile: "build", autoVerifyDisabled: true }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(INELIGIBLE_CAPS_MISSING);

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-A",
      ev: makeReviewEvent({ headSha: "h1" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalled();
    expect(result.reason).toBe("installation_capabilities_missing");
  });

  it("returns not_eligible when installation capabilities are missing", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-A" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(INELIGIBLE_CAPS_MISSING);

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-A",
      ev: makeReviewEvent({ headSha: "h1" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("installation_capabilities_missing");
  });

  it("returns pr_not_open when PR is merged", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-B" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockGetPrState.mockResolvedValue("merged");

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-B",
      ev: makeReviewEvent({ headSha: "h2" }),
    });

    expect(result.status).toBe("pr_not_open");
  });

  it("returns pr_not_open when PR is closed", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-B2" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockGetPrState.mockResolvedValue("closed");

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-B2",
      ev: makeReviewEvent({ headSha: "h2b" }),
    });

    expect(result.status).toBe("pr_not_open");
  });

  it("returns transient_pr_state (NOT pr_not_open) when PR state is null (transient lookup failure)", async () => {
    // A transient GitHub 404/429/5xx makes getPrState return null. This must NOT be conflated with a
    // genuinely closed/merged PR — the human review is recoverable, so the caller can retry.
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-B3" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockGetPrState.mockResolvedValue(null);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-B3",
      ev: makeReviewEvent({ headSha: "h2c" }),
    });

    expect(result.status).toBe("transient_pr_state");
  });

  it("returns pr_not_open (genuinely closed) but transient_pr_state (null) — the two are distinct", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-B4" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);

    mockGetPrState.mockResolvedValueOnce("closed");
    const closed = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-B4",
      ev: makeReviewEvent({ headSha: "h2d" }),
    });
    expect(closed.status).toBe("pr_not_open");

    mockGetPrState.mockResolvedValueOnce(null);
    const transient = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-B4",
      ev: makeReviewEvent({ headSha: "h2e" }),
    });
    expect(transient.status).toBe("transient_pr_state");
  });
});

// ---------------------------------------------------------------------------
// T10: archived terminal step
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — archived terminal step", () => {
  beforeEach(() => {
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-1",
      sessionId: "sess-C",
      triggeringSourceIds: ["human:1001"],
      createdAt: 1000,
      updatedAt: 1000,
      status: "ready",
      sourceKind: "human",
    });
  });

  it("reengages when session is already active", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-active" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-active",
      ev: makeReviewEvent({ headSha: "hA" }),
    });

    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalled();
  });

  it("returns session_archived when session is archived and PR is open", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-C" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-C",
      ev: makeReviewEvent({ headSha: "hC" }),
    });

    expect(result.status).toBe("session_archived");
    expect(mockWarmSession).not.toHaveBeenCalled();
    expect(mockBootstrapReviewLoopEpochForHuman).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T11: sandbox rehydrate step
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — sandbox rehydrate step", () => {
  const now = Date.now();

  beforeEach(() => {
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-warm",
      sessionId: "sess-E",
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
  });

  it("calls warmSession when runtime_state_expires_at is in the past", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-E" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockWarmSession.mockResolvedValue({ ok: true });

    // Seed session_index row with expired runtime
    sqlite
      .prepare(
        `
      INSERT INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run("sess-E", 101, "active", now - 1000, null);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-E",
      ev: makeReviewEvent({ headSha: "hE" }),
    });

    expect(mockWarmSession).toHaveBeenCalledWith(env, "sess-E", expect.any(String));
  });

  it("calls warmSession when runtime_live_lease_expires_at is in the past", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-E2" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockWarmSession.mockResolvedValue({ ok: true });
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-warm2",
      sessionId: "sess-E2",
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    sqlite
      .prepare(
        `
      INSERT INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run("sess-E2", 101, "active", null, now - 500);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-E2",
      ev: makeReviewEvent({ headSha: "hE2" }),
    });

    expect(mockWarmSession).toHaveBeenCalledWith(env, "sess-E2", expect.any(String));
  });

  it("calls warmSession when no runtime row exists in session_index", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-E3" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockWarmSession.mockResolvedValue({ ok: true });
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-warm3",
      sessionId: "sess-E3",
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    // No session_index row inserted — runtime is "unknown" → warm
    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-E3",
      ev: makeReviewEvent({ headSha: "hE3" }),
    });

    expect(mockWarmSession).toHaveBeenCalledWith(env, "sess-E3", expect.any(String));
  });

  it("does not call warmSession when both lease fields are current", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-F" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockWarmSession.mockResolvedValue({ ok: true });
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-nowarm",
      sessionId: "sess-F",
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    sqlite
      .prepare(
        `
      INSERT INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run("sess-F", 101, "active", now + 60_000, now + 60_000);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-F",
      ev: makeReviewEvent({ headSha: "hF" }),
    });

    expect(mockWarmSession).not.toHaveBeenCalled();
  });

  it("returns warm_failed when warmSession returns ok:false", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-G-warm-fail" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockWarmSession.mockResolvedValue({ ok: false, error: "sandbox launch failed" });

    // No row → will call warm
    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-G-warm-fail",
      ev: makeReviewEvent({ headSha: "hWarmFail" }),
    });

    expect(result.status).toBe("warm_failed");
    expect((result as Extract<ReengageResult, { status: "warm_failed" }>).error).toBe("sandbox launch failed");
  });
});

// ---------------------------------------------------------------------------
// T12: review_listening.entered emission
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — review_listening.entered emission", () => {
  const now = Date.now();

  beforeEach(() => {
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-wave",
      sessionId: "sess-G",
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);

    // Seed session_index with active runtime so warm is not called
    sqlite
      .prepare(
        `
      INSERT OR REPLACE INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run("sess-G", 101, "active", now + 60_000, now + 60_000);
  });

  it("emits review_listening.entered with the review head SHA (no wave/source computed)", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-G" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-G",
      ev: makeReviewEvent({ headSha: "hG" }),
    });

    expect(mockEmitReviewListeningEntered).toHaveBeenCalledWith(
      env,
      "sess-G",
      expect.objectContaining({ headSha: "hG", prUrl: expect.any(String) }),
    );
    // The wave is recomputed inside the epoch upsert instead of being read by reengage.
  });
});

// ---------------------------------------------------------------------------
// T12b: enter_review_listening_failed short-circuit
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — enter_review_listening_failed short-circuit", () => {
  const now = Date.now();

  function mockSuccessfulBootstrap(sessionId = "sess-rl-fail") {
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: "ep-rl-fail",
      sessionId,
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });
  }

  beforeEach(() => {
    // Seed an active runtime so the warm step is skipped
    sqlite
      .prepare(
        `
      INSERT OR REPLACE INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run("sess-rl-fail", 101, "active", now + 60_000, now + 60_000);
  });

  it("returns enter_review_listening_failed after bootstrapping the epoch when emitReviewListeningEntered resolves updated:false (archived reason)", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-rl-fail" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    mockSuccessfulBootstrap();

    // Simulate the DO returning ok:true, updated:false (session archived mid-flight)
    mockEmitReviewListeningEntered.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { ok: true, updated: false, reason: "archived" },
    });

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-rl-fail",
      ev: makeReviewEvent({ headSha: "hRL" }),
    });

    expect(result.status).toBe("enter_review_listening_failed");
    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalledTimes(1);
    expect(mockBootstrapReviewLoopEpochForHuman.mock.invocationCallOrder[0]).toBeLessThan(
      mockEmitReviewListeningEntered.mock.invocationCallOrder[0],
    );
  });

  it("returns enter_review_listening_failed after bootstrapping the epoch when emitReviewListeningEntered resolves ok:false", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-rl-fail" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    mockSuccessfulBootstrap();

    // Simulate a non-2xx response from the DO
    mockEmitReviewListeningEntered.mockResolvedValue({
      ok: false,
      status: 500,
      payload: null,
    });

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-rl-fail",
      ev: makeReviewEvent({ headSha: "hRL2" }),
    });

    expect(result.status).toBe("enter_review_listening_failed");
    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalledTimes(1);
    expect(mockBootstrapReviewLoopEpochForHuman.mock.invocationCallOrder[0]).toBeLessThan(
      mockEmitReviewListeningEntered.mock.invocationCallOrder[0],
    );
  });

  it("returns enter_review_listening_failed after bootstrapping the epoch when emitReviewListeningEntered resolves null (no prUrl)", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-rl-fail" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    mockSuccessfulBootstrap();

    // emitReviewListeningEntered returns null when prUrl is missing
    mockEmitReviewListeningEntered.mockResolvedValue(null);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-rl-fail",
      ev: makeReviewEvent({ headSha: "hRL3" }),
    });

    expect(result.status).toBe("enter_review_listening_failed");
    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalledTimes(1);
    expect(mockBootstrapReviewLoopEpochForHuman.mock.invocationCallOrder[0]).toBeLessThan(
      mockEmitReviewListeningEntered.mock.invocationCallOrder[0],
    );
  });

  it("re-emits review_listening.entered on redelivery when the human epoch already contains the review id", async () => {
    const sessionId = "sess-rl-retry";
    const existingEpoch = {
      id: "ep-rl-retry",
      sessionId,
      triggeringSourceIds: ["human:1001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    };
    sqlite
      .prepare(
        `
      INSERT OR REPLACE INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(sessionId, 101, "active", now + 60_000, now + 60_000);
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValueOnce(null).mockResolvedValueOnce(existingEpoch);
    mockSuccessfulBootstrap(sessionId);
    mockEmitReviewListeningEntered
      .mockResolvedValueOnce({ ok: false, status: 500, payload: null })
      .mockResolvedValueOnce({ ok: true, status: 200, payload: { ok: true, updated: true } });

    const first = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hRL-retry" }),
    });
    const second = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hRL-retry" }),
    });

    expect(first.status).toBe("enter_review_listening_failed");
    expect(second.status).toBe("already_reengaged");
    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalledTimes(1);
    expect(mockEmitReviewListeningEntered).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// T13: epoch bootstrap + return mapping
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — epoch bootstrap and return mapping", () => {
  const now = Date.now();

  function seedRuntime(sessionId: string, future = true) {
    sqlite
      .prepare(
        `
      INSERT OR REPLACE INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(sessionId, 101, "active", future ? now + 60_000 : now - 1000, future ? now + 60_000 : now - 1000);
  }

  it("bootstraps a human-source epoch and returns reengaged with epoch id", async () => {
    const sessionId = "sess-H";
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null); // no pre-existing epoch
    seedRuntime(sessionId);

    const epochId = "ep-bootstrap-1";
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      id: epochId,
      sessionId,
      triggeringSourceIds: ["human:9001"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    });

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hH", reviewId: 9001 }),
    });

    expect(result.status).toBe("reengaged");
    expect((result as Extract<ReengageResult, { status: "reengaged" }>).epochId).toBe(epochId);
  });

  it("returns already_reengaged when called twice with the same reviewId at the same head", async () => {
    const sessionId = "sess-I";
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    seedRuntime(sessionId);

    const epochId = "ep-existing";
    const existingEpoch = {
      id: epochId,
      sessionId,
      triggeringSourceIds: ["human:5000"],
      createdAt: now - 1000,
      updatedAt: now - 500,
      status: "ready",
      sourceKind: "human",
    };

    // Pre-existing epoch for this reviewId
    mockSelectHumanEpochCarryingSource.mockResolvedValue(existingEpoch);
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue({
      ...existingEpoch,
      updatedAt: now,
    });

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hI", reviewId: 5000 }),
    });

    expect(result.status).toBe("already_reengaged");
    expect((result as Extract<ReengageResult, { status: "already_reengaged" }>).epochId).toBe(epochId);
    expect(mockBootstrapReviewLoopEpochForHuman).not.toHaveBeenCalled();
    expect(mockEmitReviewListeningEntered).toHaveBeenCalledWith(
      env,
      sessionId,
      expect.objectContaining({ headSha: "hI", prUrl: expect.any(String) }),
    );
  });

  it("returns epoch_bootstrap_failed when bootstrapReviewLoopEpochForHuman throws", async () => {
    const sessionId = "sess-J";
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    mockBootstrapReviewLoopEpochForHuman.mockRejectedValue(new Error("d1 down"));
    seedRuntime(sessionId);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hJ" }),
    });

    expect(result.status).toBe("epoch_bootstrap_failed");
    expect((result as Extract<ReengageResult, { status: "epoch_bootstrap_failed" }>).error).toContain("d1 down");
    expect((result as Extract<ReengageResult, { status: "epoch_bootstrap_failed" }>).retryable).toBe(false);
    expect(mockEmitReviewListeningEntered).not.toHaveBeenCalled();
  });

  it("returns retryable epoch_bootstrap_failed and does not enter review-listening for transient D1 storage errors", async () => {
    const sessionId = "sess-J-transient";
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    mockBootstrapReviewLoopEpochForHuman.mockRejectedValue(new Error("D1_ERROR: internal error"));
    seedRuntime(sessionId);

    const result = await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hJ2" }),
    });

    expect(result.status).toBe("epoch_bootstrap_failed");
    expect((result as Extract<ReengageResult, { status: "epoch_bootstrap_failed" }>).retryable).toBe(true);
    expect(mockEmitReviewListeningEntered).not.toHaveBeenCalled();
  });

  it("passes correct triggeringSourceId (human:<reviewId>) to bootstrapReviewLoopEpochForHuman", async () => {
    const sessionId = "sess-K";
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(ELIGIBLE_RESULT);
    mockSelectHumanEpochCarryingSource.mockResolvedValue(null);
    seedRuntime(sessionId);

    const epochResult = {
      id: "ep-K",
      sessionId,
      triggeringSourceIds: ["human:7777"],
      createdAt: now,
      updatedAt: now,
      status: "ready",
      sourceKind: "human",
    };
    mockBootstrapReviewLoopEpochForHuman.mockResolvedValue(epochResult);

    await reengageSessionForReview({
      env: env as never,
      db,
      sessionId,
      ev: makeReviewEvent({ headSha: "hK", reviewId: 7777 }),
    });

    expect(mockBootstrapReviewLoopEpochForHuman).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        triggeringSourceId: "human:7777",
        headSha: "hK",
        sessionId,
      }),
    );
  });
});

describe("isSessionRuntimeLive (ARC-1407)", () => {
  const now = 1_000_000;

  function seedRuntime(sessionId: string, stateExpiresAt: number | null, liveLeaseExpiresAt: number | null) {
    sqlite
      .prepare(
        `INSERT INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, 101, "active", stateExpiresAt, liveLeaseExpiresAt);
  }

  it("returns false for an idle-paused session (multi-hour state retention, NULL live lease)", async () => {
    // The regression Fix B1 must not reintroduce: idle-pause projects runtime_state_expires_at hours
    // ahead and runtime_live_lease_expires_at = NULL. isRuntimeGone would call this "not gone", but the
    // agent is idle, so the stuck-epoch reclaim MUST proceed — liveness is the live lease alone.
    seedRuntime("sess-paused", now + 72 * 60 * 60 * 1000, null);
    expect(await isSessionRuntimeLive(db, "sess-paused", now)).toBe(false);
  });

  it("returns true only while the live lease is held in the future", async () => {
    seedRuntime("sess-live", now + 72 * 60 * 60 * 1000, now + 15 * 60 * 1000);
    expect(await isSessionRuntimeLive(db, "sess-live", now)).toBe(true);
  });

  it("returns false when the live lease has expired", async () => {
    seedRuntime("sess-expired", now + 72 * 60 * 60 * 1000, now - 1);
    expect(await isSessionRuntimeLive(db, "sess-expired", now)).toBe(false);
  });

  it("returns false when no session_index row exists", async () => {
    expect(await isSessionRuntimeLive(db, "sess-missing", now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureSessionLiveForPr — shared PR-liveness scaffold (ARC-1514)
// ---------------------------------------------------------------------------

describe("ensureSessionLiveForPr — shared PR-liveness scaffold (ARC-1514)", () => {
  const PR_URL = "https://github.com/acme/repo/pull/77";
  // Synthetic clock — the "runtime gone" cases seed expiries relative to this WITHOUT forcing a
  // real multi-hour (>72h) retention window to elapse.
  const nowMs = 5_000_000;

  function seedRuntime(sessionId: string, stateExpiresAt: number | null, liveLeaseExpiresAt: number | null) {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO session_index (session_id, owner_user_id, status, runtime_state_expires_at, runtime_live_lease_expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, 101, "active", stateExpiresAt, liveLeaseExpiresAt);
  }

  function readWebhookRefs(sessionId: string) {
    return sqlite
      .prepare(`SELECT source, external_ref, session_id FROM session_webhook_refs WHERE session_id = ?`)
      .all(sessionId) as Array<{ source: string; external_ref: string; session_id: string }>;
  }

  it("reuses the warm sandbox (does NOT warm) when the runtime lease is live", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-live" }));
    // Both expiries in the future relative to the synthetic nowMs → runtime is NOT gone → reuse.
    seedRuntime("sess-live", nowMs + 60_000, nowMs + 60_000);

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-live",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("live");
    expect(mockWarmSession).not.toHaveBeenCalled();
    expect(mockUnarchiveSession).not.toHaveBeenCalled();
  });

  it("cold-boots (warmSession) the same PR-bound session when isRuntimeGone (synthetic nowMs, no real >72h wait)", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-gone" }));
    // Both expiries in the PAST relative to the synthetic nowMs → runtime gone → warm.
    seedRuntime("sess-gone", nowMs - 1, nowMs - 1);
    mockWarmSession.mockResolvedValue({ ok: true });

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-gone",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("live");
    expect(mockWarmSession).toHaveBeenCalledWith(env, "sess-gone", expect.any(String));
  });

  it("returns warm_failed when the runtime is gone and warmSession fails", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-warm-fail" }));
    // No runtime row → isRuntimeGone → warm.
    mockWarmSession.mockResolvedValue({ ok: false, error: "boot boom" });

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-warm-fail",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("warm_failed");
    expect((result as Extract<EnsureSessionLiveResult, { status: "warm_failed" }>).error).toBe("boot boom");
  });

  it("returns session_archived for an archived session", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-arch" }));
    seedRuntime("sess-arch", nowMs + 60_000, nowMs + 60_000);

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-arch",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("session_archived");
    expect(mockWarmSession).not.toHaveBeenCalled();
  });

  it("returns session_not_found when the session is missing", async () => {
    mockGetSessionState.mockResolvedValue(null);

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-missing",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("session_not_found");
  });

  it("registers the github_pr_url webhook ref with the correct arg order and is idempotent", async () => {
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-ref" }));
    seedRuntime("sess-ref", nowMs + 60_000, nowMs + 60_000);

    await ensureSessionLiveForPr({ env: env as never, db, sessionId: "sess-ref", prUrl: PR_URL, nowMs });
    // Second call must not create a duplicate row (idempotent upsert).
    await ensureSessionLiveForPr({ env: env as never, db, sessionId: "sess-ref", prUrl: PR_URL, nowMs });

    const rows = readWebhookRefs("sess-ref");
    expect(rows).toHaveLength(1);
    // `source` is "github_pr_url" (NOT the sessionId) and `session_id` is the sessionId — this is
    // exactly the arg-order contract: upsertSessionWebhookRef(db, SOURCE, prUrl, sessionId).
    expect(rows[0]).toMatchObject({
      source: "github_pr_url",
      external_ref: PR_URL,
      session_id: "sess-ref",
    });
  });

  it("does NOT apply any review-specific eligibility gate", async () => {
    // A verification session would be rejected by reengageSessionForReview's exempt gate, but the
    // generic scaffold treats a mention as a task: it revives the session and never consults the
    // review gates, PR-state, human-epoch bootstrap, or review-listening emission.
    mockGetSessionState.mockResolvedValue(makeActiveSession({ sessionId: "sess-mention", agentRole: "verification" }));
    seedRuntime("sess-mention", nowMs + 60_000, nowMs + 60_000);

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-mention",
      prUrl: PR_URL,
      nowMs,
    });

    expect(result.status).toBe("live");
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockGetPrState).not.toHaveBeenCalled();
    expect(mockCreateInstallationToken).not.toHaveBeenCalled();
    expect(mockBootstrapReviewLoopEpochForHuman).not.toHaveBeenCalled();
    expect(mockEmitReviewListeningEntered).not.toHaveBeenCalled();
  });

  it("ensureSessionLiveForPr uses the passed-in session and skips the initial load", async () => {
    // A non-archived pre-loaded session → the helper must not load it again. getSessionState is not
    // called at all: the initial load is skipped (param) and a non-archived session has no reload.
    const passed = makeActiveSession({ sessionId: "sess-passed" });
    seedRuntime("sess-passed", nowMs + 60_000, nowMs + 60_000); // live runtime → no warm

    const result = await ensureSessionLiveForPr({
      env: env as never,
      db,
      sessionId: "sess-passed",
      prUrl: PR_URL,
      nowMs,
      session: passed as never,
    });

    expect(result.status).toBe("live");
    expect((result as Extract<EnsureSessionLiveResult, { status: "live" }>).session).toBe(passed);
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reengageSessionForReview — review gates still run BEFORE the shared scaffold
// (behavior-unchanged control after the ensureSessionLiveForPr extraction)
// ---------------------------------------------------------------------------

describe("reengageSessionForReview — review gates still applied before the shared scaffold", () => {
  it("rejects a verification-exempt session as not_eligible WITHOUT unarchiving/warming (gates run first)", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-exempt", agentRole: "verification" }));

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-exempt",
      ev: makeReviewEvent({ headSha: "hExempt" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("verification_session");
    // The shared scaffold must not have run — no revive side effects for a gated-out review.
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
    expect(mockUnarchiveSession).not.toHaveBeenCalled();
    expect(mockWarmSession).not.toHaveBeenCalled();
  });

  it("rejects on human eligibility (installation caps missing) WITHOUT unarchiving/warming", async () => {
    mockGetSessionState.mockResolvedValue(makeArchivedSession({ sessionId: "sess-caps" }));
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(INELIGIBLE_CAPS_MISSING);

    const result = (await reengageSessionForReview({
      env: env as never,
      db,
      sessionId: "sess-caps",
      ev: makeReviewEvent({ headSha: "hCaps" }),
    })) as Extract<ReengageResult, { status: "not_eligible" }>;

    expect(result.status).toBe("not_eligible");
    expect(result.reason).toBe("installation_capabilities_missing");
    expect(mockUnarchiveSession).not.toHaveBeenCalled();
    expect(mockWarmSession).not.toHaveBeenCalled();
  });
});
