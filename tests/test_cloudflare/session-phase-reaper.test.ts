import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupStaleSessionPhases } from "../../apps/control-plane-worker/src/session/cleanup";
import type { SessionPhaseReaperResponse } from "../../apps/control-plane-worker/src/session/internal-routes";
import type { Env } from "../../apps/control-plane-worker/src/types";

const stubFetchMock = vi.fn();
const { postCountMetricSeriesMock } = vi.hoisted(() => ({ postCountMetricSeriesMock: vi.fn() }));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionStub: vi.fn(() => ({ fetch: stubFetchMock })),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", () => ({
  postCountMetricSeries: postCountMetricSeriesMock,
}));

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
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

const NOW = Date.parse("2026-06-29T18:00:00.000Z");
const OLD_MS = NOW - 8 * 24 * 60 * 60 * 1_000;
const FRESH_MS = NOW - 60_000;

let sqlite: Database.Database;

function makeEnv(): Env {
  return {
    DB: new SqliteD1(sqlite) as unknown as D1Database,
    SESSION: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ fetch: stubFetchMock })),
    },
    SANDBOX_RUNTIME_CLEANUP_SECRET: "cleanup-secret",
    DD_API_KEY: undefined,
    WORKER_ENV: "test",
  } as unknown as Env;
}

function insertSession(input: {
  sessionId: string;
  createdAt?: number | string;
  updatedAt: number;
  richStatus?: string | null;
  runtimeState?: string | null;
  runtimeLiveLeaseExpiresAt?: number | null;
  status?: string;
  planApprovalPending?: boolean;
}): void {
  sqlite
    .prepare(
      `INSERT INTO session_index (
        session_id,
        status,
        created_at,
        updated_at,
        rich_status,
        runtime_state,
        runtime_live_lease_expires_at,
        plan_approval_pending
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.status ?? "active",
      input.createdAt ?? OLD_MS,
      input.updatedAt,
      input.richStatus ?? null,
      input.runtimeState ?? null,
      input.runtimeLiveLeaseExpiresAt ?? null,
      input.planApprovalPending ? 1 : 0,
    );
}

function reaperResponse(input: Partial<SessionPhaseReaperResponse> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      terminalized: true,
      action: "archive",
      reason: "runtime_killed",
      ...input,
    } satisfies SessionPhaseReaperResponse),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("cleanupStaleSessionPhases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE session_index (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        rich_status TEXT,
        runtime_state TEXT,
        runtime_live_lease_expires_at INTEGER,
        plan_approval_pending INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  it("terminalizes each stale/dead eligibility branch through the SessionDO", async () => {
    insertSession({ sessionId: "review-old", updatedAt: OLD_MS, richStatus: "review_listening" });
    insertSession({ sessionId: "killed", updatedAt: FRESH_MS, richStatus: "running", runtimeState: "killed" });
    insertSession({ sessionId: "missing-old", updatedAt: OLD_MS, richStatus: "idle", runtimeState: null });
    insertSession({
      sessionId: "lease-expired",
      updatedAt: FRESH_MS,
      richStatus: "running",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: NOW - 1,
    });
    stubFetchMock
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "runtime_missing_ttl" }))
      .mockResolvedValueOnce(reaperResponse({ action: "exit_review_listening", reason: "review_listening_ttl" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "runtime_killed" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "live_lease_expired" }));

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 4, archived: 3, reviewListeningExited: 1, skipped: 0, errors: 0 });
    const bodies = stubFetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toEqual([
      expect.objectContaining({ sessionId: "missing-old", action: "archive", reason: "runtime_missing_ttl" }),
      expect.objectContaining({
        sessionId: "review-old",
        action: "exit_review_listening",
        reason: "review_listening_ttl",
      }),
      expect.objectContaining({ sessionId: "killed", action: "archive", reason: "runtime_killed" }),
      expect.objectContaining({ sessionId: "lease-expired", action: "archive", reason: "live_lease_expired" }),
    ]);
  });

  it("leaves fresh, live, within-grace terminal, blocked, and archived sessions alone", async () => {
    insertSession({ sessionId: "fresh-missing", updatedAt: FRESH_MS, richStatus: "idle", runtimeState: null });
    insertSession({
      sessionId: "live-running",
      updatedAt: OLD_MS,
      richStatus: "running",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: NOW + 60_000,
    });
    // Terminal but still within the stale grace -> not yet reclaimed.
    insertSession({ sessionId: "terminal-fresh", updatedAt: FRESH_MS, richStatus: "completed", runtimeState: null });
    // Terminal but non-archivable (blocked may still be actionable) -> never auto-archived.
    insertSession({ sessionId: "blocked-old", updatedAt: OLD_MS, richStatus: "blocked", runtimeState: null });
    insertSession({ sessionId: "closed", updatedAt: OLD_MS, richStatus: "running", status: "archived" });
    insertSession({ sessionId: "review-fresh", updatedAt: FRESH_MS, richStatus: "review_listening" });

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 0, archived: 0, reviewListeningExited: 0, skipped: 0, errors: 0 });
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it("does not archive an expired-lease session before it is three days old", async () => {
    insertSession({
      sessionId: "young-lease-expired-ms",
      createdAt: NOW - 60_000,
      updatedAt: FRESH_MS,
      richStatus: "running",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: NOW - 1,
    });
    insertSession({
      sessionId: "young-lease-expired-iso",
      createdAt: new Date(NOW - 60_000).toISOString(),
      updatedAt: FRESH_MS,
      richStatus: "running",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: NOW - 1,
    });
    stubFetchMock
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "live_lease_expired" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "live_lease_expired" }));

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 0, archived: 0, reviewListeningExited: 0, skipped: 0, errors: 0 });
    expect(stubFetchMock).not.toHaveBeenCalled();
  });

  it("still archives an expired-lease session older than three days with an ISO created_at", async () => {
    insertSession({
      sessionId: "old-iso-lease-expired",
      createdAt: new Date(OLD_MS).toISOString(),
      updatedAt: FRESH_MS,
      richStatus: "running",
      runtimeState: "running",
      runtimeLiveLeaseExpiresAt: NOW - 1,
    });
    stubFetchMock.mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "live_lease_expired" }));

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 1, archived: 1, reviewListeningExited: 0, skipped: 0, errors: 0 });
    expect(stubFetchMock).toHaveBeenCalledTimes(1);
  });

  it("archives terminal-stale sessions past the grace via the SessionDO with reason terminal_stale", async () => {
    insertSession({ sessionId: "completed-old", updatedAt: OLD_MS, richStatus: "completed", runtimeState: null });
    insertSession({ sessionId: "failed-old", updatedAt: OLD_MS, richStatus: "failed", runtimeState: null });
    insertSession({ sessionId: "superseded-old", updatedAt: OLD_MS, richStatus: "superseded", runtimeState: null });
    // Excluded: `stopped` is resumable (archiving would 409 the resume route), within grace,
    // non-archivable terminal, already archived.
    insertSession({ sessionId: "stopped-old", updatedAt: OLD_MS, richStatus: "stopped", runtimeState: null });
    insertSession({ sessionId: "completed-fresh", updatedAt: FRESH_MS, richStatus: "completed", runtimeState: null });
    insertSession({ sessionId: "blocked-old", updatedAt: OLD_MS, richStatus: "blocked", runtimeState: null });

    stubFetchMock
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "terminal_stale" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "terminal_stale" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "terminal_stale" }));

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 3, archived: 3, reviewListeningExited: 0, skipped: 0, errors: 0 });
    const bodies = stubFetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies.map((body) => body.sessionId).sort()).toEqual(["completed-old", "failed-old", "superseded-old"]);
    for (const body of bodies) {
      expect(body).toMatchObject({ action: "archive", reason: "terminal_stale" });
    }
  });

  it("exempts parked sessions only from dead-runtime archival", async () => {
    insertSession({
      sessionId: "parked-killed",
      updatedAt: FRESH_MS,
      richStatus: "waiting_for_input",
      runtimeState: "killed",
      planApprovalPending: true,
    });
    insertSession({
      sessionId: "unparked-killed",
      updatedAt: FRESH_MS,
      richStatus: "running",
      runtimeState: "killed",
      planApprovalPending: false,
    });
    insertSession({
      sessionId: "parked-terminal-stale",
      updatedAt: OLD_MS,
      richStatus: "completed",
      runtimeState: "killed",
      planApprovalPending: true,
    });
    stubFetchMock
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "terminal_stale" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "runtime_killed" }));

    const result = await cleanupStaleSessionPhases(makeEnv(), NOW);

    expect(result).toEqual({ scanned: 2, archived: 2, reviewListeningExited: 0, skipped: 0, errors: 0 });
    const bodies = stubFetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toEqual([
      expect.objectContaining({ sessionId: "parked-terminal-stale", reason: "terminal_stale" }),
      expect.objectContaining({ sessionId: "unparked-killed", reason: "runtime_killed" }),
    ]);
  });

  it("keeps sweeping when metric emission fails", async () => {
    insertSession({ sessionId: "missing-old", updatedAt: OLD_MS, richStatus: "idle", runtimeState: null });
    insertSession({ sessionId: "killed", updatedAt: FRESH_MS, richStatus: "running", runtimeState: "killed" });
    stubFetchMock
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "runtime_missing_ttl" }))
      .mockResolvedValueOnce(reaperResponse({ action: "archive", reason: "runtime_killed" }));
    postCountMetricSeriesMock.mockRejectedValueOnce(new Error("datadog unavailable")).mockResolvedValue(undefined);

    const env = { ...makeEnv(), DD_API_KEY: "dd-api-key" } as Env;
    const result = await cleanupStaleSessionPhases(env, NOW);

    expect(result).toEqual({ scanned: 2, archived: 2, reviewListeningExited: 0, skipped: 0, errors: 0 });
    expect(stubFetchMock).toHaveBeenCalledTimes(2);
    expect(postCountMetricSeriesMock).toHaveBeenCalledTimes(2);
  });
});
