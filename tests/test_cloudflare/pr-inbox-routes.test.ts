// Route + service + DAO tests for GET /api/pr-inbox. Calls the handler directly
// with synthesized auth against an in-memory D1 loaded from the real migrations.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The internal feature gate resolves identity from D1; mock it so route tests
// can drive membership directly. Defaults to a member in beforeEach.
const mockVerifyCycloidMember = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/internal-feature-gate", () => ({
  verifyCycloidMember: (...args: unknown[]) => mockVerifyCycloidMember(...args),
}));

import { prInboxRoutes } from "../../apps/control-plane-worker/src/routes/pr-inbox";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import {
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
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
    authMode: "user_session",
    canAccessAllSessions: false,
    user: { businessId: "biz-a" } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

function buildRecord(overrides: Partial<PrCoordinationRecord>): PrCoordinationRecord {
  return {
    sessionId: "sess",
    version: 1,
    state: "REVIEW",
    prUrl: "https://github.com/acme/web/pull/1",
    headSha: "abc",
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: 1,
    ...overrides,
  };
}

interface SeedSession {
  sessionId: string;
  ownerUserId: number;
  businessId?: string;
  repoOwner?: string;
  repoName?: string;
  updatedAt?: string;
  callbackContextJson?: string | null;
  title?: string;
}

function seedSession(d1: SqliteD1, s: SeedSession): void {
  d1.sqlite
    .prepare(
      `INSERT INTO session_index
       (session_id, owner_user_id, business_id, status, created_at, updated_at, title, model,
        agent_runtime_backend, repo_owner, repo_name, callback_context_json, initiation_mode)
       VALUES (?, ?, ?, 'active', ?, ?, ?, 'gpt-5.4', 'codex', ?, ?, ?, 'user')`,
    )
    .run(
      s.sessionId,
      s.ownerUserId,
      s.businessId ?? "biz-a",
      s.updatedAt ?? "2026-07-01T00:00:00.000Z",
      s.updatedAt ?? "2026-07-01T00:00:00.000Z",
      s.title ?? `PR for ${s.sessionId}`,
      s.repoOwner ?? "acme",
      s.repoName ?? "web",
      s.callbackContextJson ?? null,
    );
}

async function seedPr(
  d1: SqliteD1,
  sessionId: string,
  record: Partial<PrCoordinationRecord>,
  meta: { prNumber?: number; prDraft?: boolean; headBranch?: string } = {},
): Promise<void> {
  const prUrl = record.prUrl ?? `https://github.com/acme/web/pull/${sessionId}`;
  await insertPrCoordination(d1 as unknown as D1Database, buildRecord({ ...record, sessionId, prUrl }));
  d1.sqlite
    .prepare(
      `INSERT INTO session_pr_metadata (session_id, pr_url, pr_number, pr_draft, published_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      sessionId,
      prUrl,
      meta.prNumber ?? 1,
      meta.prDraft == null ? null : meta.prDraft ? 1 : 0,
      meta.headBranch ?? "feature-branch",
    );
}

function getRoute(): Route {
  const route = prInboxRoutes.find((r) => r.method === "GET" && r.pattern.test("/api/pr-inbox"));
  if (!route) throw new Error("GET /api/pr-inbox not registered");
  return route;
}

async function invoke(env: Env, auth: AuthInfo | null, query = ""): Promise<Response> {
  const route = getRoute();
  const url = `https://example.com/api/pr-inbox${query}`;
  const request = new Request(url, { method: "GET" });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

describe("GET /api/pr-inbox", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockVerifyCycloidMember.mockReset();
    mockVerifyCycloidMember.mockResolvedValue(true);
  });

  it("returns 403 for a customer-business member (not a Cycloid member)", async () => {
    mockVerifyCycloidMember.mockResolvedValue(false);
    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(403);
  });

  it("returns 200 for a Cycloid member", async () => {
    mockVerifyCycloidMember.mockResolvedValue(true);
    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(200);
  });

  it("evaluates the gate via the request auth (actorUser during impersonation)", async () => {
    const auth = makeAuth({ actorUser: { id: 7 } as AuthInfo["actorUser"] });
    await invoke(env, auth);
    expect(mockVerifyCycloidMember).toHaveBeenCalledWith(env.DB, auth);
  });

  it("returns owner-scoped PRs with derived buckets and FSM projection", async () => {
    seedSession(d1, { sessionId: "s-review", ownerUserId: 42, updatedAt: "2026-07-03T00:00:00.000Z" });
    seedSession(d1, { sessionId: "s-ready", ownerUserId: 42, updatedAt: "2026-07-02T00:00:00.000Z" });
    seedSession(d1, { sessionId: "s-ci", ownerUserId: 42, updatedAt: "2026-07-01T00:00:00.000Z" });
    await seedPr(d1, "s-review", { state: "REVIEW" }, { prNumber: 10 });
    await seedPr(d1, "s-ready", { state: "MERGE_READY" }, { prNumber: 11 });
    await seedPr(d1, "s-ci", { state: "NEEDS_YOU", blockedReason: "ci_fix_exhausted" }, { prNumber: 12 });

    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };
    expect(body.ok).toBe(true);
    // Newest-updated first.
    expect(body.data.items.map((i) => i.sessionId)).toEqual(["s-review", "s-ready", "s-ci"]);
    const byId = new Map(body.data.items.map((i) => [i.sessionId as string, i]));
    expect(byId.get("s-review")).toMatchObject({ bucket: "needs_review", state: "REVIEW", prNumber: 10 });
    expect(byId.get("s-ready")).toMatchObject({ bucket: "approved", state: "MERGE_READY" });
    expect(byId.get("s-ci")).toMatchObject({ bucket: "checks_failing", state: "NEEDS_YOU" });
  });

  it("excludes other users' PRs (fail-closed owner scoping) but an admin sees all", async () => {
    seedSession(d1, { sessionId: "mine", ownerUserId: 42 });
    seedSession(d1, { sessionId: "theirs", ownerUserId: 99 });
    await seedPr(d1, "mine", { state: "REVIEW" });
    await seedPr(d1, "theirs", { state: "REVIEW" });

    const mine = await invoke(env, makeAuth({ userId: "42" }));
    const mineBody = (await mine.json()) as { data: { items: Array<{ sessionId: string }> } };
    expect(mineBody.data.items.map((i) => i.sessionId)).toEqual(["mine"]);

    const admin = await invoke(env, makeAuth({ userId: "1", canAccessAllSessions: true }));
    const adminBody = (await admin.json()) as { data: { items: Array<{ sessionId: string }> } };
    expect(adminBody.data.items.map((i) => i.sessionId).sort()).toEqual(["mine", "theirs"]);
  });

  it("filters by bucket", async () => {
    seedSession(d1, { sessionId: "a", ownerUserId: 42, updatedAt: "2026-07-03T00:00:00.000Z" });
    seedSession(d1, { sessionId: "b", ownerUserId: 42, updatedAt: "2026-07-02T00:00:00.000Z" });
    await seedPr(d1, "a", { state: "REVIEW" });
    await seedPr(d1, "b", { state: "MERGE_READY" });

    const res = await invoke(env, makeAuth(), "?bucket=approved");
    const body = (await res.json()) as {
      data: {
        items: Array<{ sessionId: string; bucket: string }>;
        totalCount: number;
        bucketCounts: Record<string, number>;
      };
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ sessionId: "b", bucket: "approved" });
    expect(body.data.totalCount).toBe(1);
    expect(body.data.bucketCounts).toMatchObject({ needs_review: 1, approved: 1, closed: 0 });
  });

  it("filters server-side lanes while keeping search-scoped bucket counts", async () => {
    seedSession(d1, { sessionId: "open", ownerUserId: 42, title: "Release open" });
    seedSession(d1, { sessionId: "closed", ownerUserId: 42, title: "Release closed" });
    await seedPr(d1, "open", { state: "REVIEW" });
    await seedPr(d1, "closed", { state: "MERGED" });

    const res = await invoke(env, makeAuth(), "?lane=closed&search=release");
    const body = (await res.json()) as {
      data: {
        items: Array<{ sessionId: string }>;
        totalCount: number;
        bucketCounts: Record<string, number>;
      };
    };
    expect(body.data.items.map((item) => item.sessionId)).toEqual(["closed"]);
    expect(body.data.totalCount).toBe(1);
    expect(body.data.bucketCounts).toMatchObject({ needs_review: 1, closed: 1 });
  });

  it("searches the full scoped inbox before pagination", async () => {
    for (let index = 0; index < 30; index += 1) {
      const sessionId = `newer-${String(index).padStart(2, "0")}`;
      seedSession(d1, {
        sessionId,
        ownerUserId: 42,
        updatedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        title: `Routine update ${index}`,
      });
      await seedPr(d1, sessionId, { state: "REVIEW" }, { prNumber: index + 1 });
    }
    seedSession(d1, {
      sessionId: "older-match",
      ownerUserId: 42,
      updatedAt: "2026-06-01T00:00:00.000Z",
      title: "Needle authentication fix",
    });
    await seedPr(d1, "older-match", { state: "REVIEW" }, { prNumber: 421, headBranch: "arc/needle-auth" });

    const res = await invoke(env, makeAuth(), "?search=needle%20auth&limit=1");
    const body = (await res.json()) as {
      data: { items: Array<{ sessionId: string }>; nextCursor: string | null; totalCount: number };
    };
    expect(body.data.items.map((item) => item.sessionId)).toEqual(["older-match"]);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.totalCount).toBe(1);
  });

  it("searches repo, branch, and PR number with literal wildcard handling", async () => {
    seedSession(d1, {
      sessionId: "search-fields",
      ownerUserId: 42,
      repoOwner: "Acme",
      repoName: "Payments",
      title: "Raise coverage to 100%",
    });
    await seedPr(d1, "search-fields", { state: "REVIEW" }, { prNumber: 742, headBranch: "arc/payment-retry" });

    for (const search of ["acme/payments", "payment-retry", "%", "%23742"]) {
      const res = await invoke(env, makeAuth(), `?search=${search}`);
      const body = (await res.json()) as { data: { items: Array<{ sessionId: string }> } };
      expect(body.data.items.map((item) => item.sessionId)).toEqual(["search-fields"]);
    }
  });

  it("paginates a combined status and text filter without gaps or duplicates", async () => {
    const rows = [
      { id: "ready-3", state: "MERGE_READY", day: "06" },
      { id: "review-2", state: "REVIEW", day: "05" },
      { id: "ready-2", state: "MERGE_READY", day: "04" },
      { id: "review-1", state: "REVIEW", day: "03" },
      { id: "ready-1", state: "MERGE_READY", day: "02" },
    ] as const;
    for (const row of rows) {
      seedSession(d1, {
        sessionId: row.id,
        ownerUserId: 42,
        updatedAt: `2026-07-${row.day}T00:00:00.000Z`,
        title: `Release ${row.id}`,
      });
      await seedPr(d1, row.id, { state: row.state });
    }

    const first = await invoke(env, makeAuth(), "?bucket=approved&search=release&limit=2");
    const firstBody = (await first.json()) as {
      data: { items: Array<{ sessionId: string }>; nextCursor: string | null };
    };
    expect(firstBody.data.items.map((item) => item.sessionId)).toEqual(["ready-3", "ready-2"]);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const second = await invoke(
      env,
      makeAuth(),
      `?bucket=approved&search=release&limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor ?? "")}`,
    );
    const secondBody = (await second.json()) as {
      data: { items: Array<{ sessionId: string }>; nextCursor: string | null };
    };
    expect(secondBody.data.items.map((item) => item.sessionId)).toEqual(["ready-1"]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it("marks draft PRs as the draft bucket regardless of state", async () => {
    seedSession(d1, { sessionId: "d", ownerUserId: 42 });
    await seedPr(d1, "d", { state: "REVIEW" }, { prDraft: true });
    const res = await invoke(env, makeAuth());
    const body = (await res.json()) as { data: { items: Array<{ bucket: string; draft: boolean }> } };
    expect(body.data.items[0]).toMatchObject({ bucket: "draft", draft: true });
  });

  it("parses a Slack linked ticket from callback context", async () => {
    seedSession(d1, {
      sessionId: "slk",
      ownerUserId: 42,
      callbackContextJson: JSON.stringify({ source: "slack", channel: "C123", threadTs: "1.2", slackTeamId: "T1" }),
    });
    await seedPr(d1, "slk", { state: "REVIEW" });
    const res = await invoke(env, makeAuth());
    const body = (await res.json()) as { data: { items: Array<{ linkedTicket: unknown }> } };
    expect(body.data.items[0].linkedTicket).toMatchObject({ source: "slack", channel: "C123", threadTs: "1.2" });
  });

  it("rejects an invalid bucket with 400", async () => {
    const res = await invoke(env, makeAuth(), "?bucket=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects invalid lane and oversized search filters", async () => {
    expect((await invoke(env, makeAuth(), "?lane=merged")).status).toBe(400);
    expect((await invoke(env, makeAuth(), `?search=${"x".repeat(201)}`)).status).toBe(400);
    expect((await invoke(env, makeAuth(), `?search=${"x ".repeat(9)}`)).status).toBe(400);
  });

  it("returns a generic 500 when inbox storage fails", async () => {
    const failingEnv = {
      DB: {
        prepare() {
          throw new Error("private database detail");
        },
      },
    } as unknown as Env;

    const res = await invoke(failingEnv, makeAuth());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("private database detail");
  });
});
