// ARC-1330 PR 46 — POST /api/admin/fsm/backfill param validation + stale-fence wiring.
//
// Proves the route's `staleCutoffHours` contract: absent = the 12h default fence; `0`/`null` =
// fence DISABLED (the deliberate-manual-backfill escape hatch); a positive number = that many
// hours; anything else = 400 with NO run. The session DO loader is mocked; enumeration, the
// settings lookup, and the pr_coordination writes run real against migrated sqlite.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionState } from "../../../apps/control-plane-worker/src/types";

const mockGetSessionState = vi.fn();

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  assertDatabase: (env: { DB: D1Database }) => env.DB,
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

import { adminFsmBackfillRoutes } from "../../../apps/control-plane-worker/src/routes/admin-fsm-backfill";
import { getPrCoordination } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { AuthInfo, Env } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

const route = adminFsmBackfillRoutes[0];

const ADMIN_AUTH: AuthInfo = {
  userId: "1",
  tokenSource: "admin-token",
  authMode: "admin_token",
  canAccessAllSessions: true,
};

function session(): SessionState {
  return {
    sessionId: "sess-1",
    ownerUserId: "10",
    businessId: "biz-1",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    lastEventId: null,
    title: null,
    reviewListeningPrUrl: "https://gh/x/pull/1",
    reviewListeningHeadSha: "h1",
  } as SessionState;
}

function request(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/admin/fsm/backfill", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function parsedRequest(body: Record<string, unknown>): Request {
  return { json: async () => body } as unknown as Request;
}

describe("POST /api/admin/fsm/backfill — staleCutoffHours validation + fence wiring", () => {
  let db: D1Database;
  let env: Env;

  const insertSessionIndex = async (id: string, updatedAtIso: string) => {
    await db
      .prepare(
        `INSERT INTO session_index (session_id, owner_user_id, status, created_at, updated_at, business_id, rich_status)
         VALUES (?, 10, 'active', ?, ?, 'biz', 'review_listening')`,
      )
      .bind(id, updatedAtIso, updatedAtIso)
      .run();
  };

  beforeEach(() => {
    db = new SqliteD1(createMigratedSqlite()) as unknown as D1Database;
    env = { DB: db, FSM_MODE: "shadow" } as unknown as Env;
    mockGetSessionState.mockReset();
    mockGetSessionState.mockResolvedValue(session());
  });

  it.each([
    { name: "zero", limit: 0 },
    { name: "negative", limit: -1 },
    { name: "NaN", limit: Number.NaN },
    { name: "fractional", limit: 0.5 },
  ])("rejects a $name limit with 400 and runs nothing", async ({ limit }) => {
    await insertSessionIndex("sess-1", new Date().toISOString());
    const res = await route.handler(parsedRequest({ limit }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("limit must be a positive integer");
    expect(await getPrCoordination(db, "sess-1")).toBeNull();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("rejects a negative staleCutoffHours with 400 and runs nothing", async () => {
    await insertSessionIndex("sess-1", new Date().toISOString());
    const res = await route.handler(
      request({ staleCutoffHours: -1 }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(400);
    expect(await getPrCoordination(db, "sess-1")).toBeNull();
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric staleCutoffHours with 400", async () => {
    const res = await route.handler(
      request({ staleCutoffHours: "12" }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("staleCutoffHours");
  });

  it("absent staleCutoffHours applies the 12h default: a 13h-idle session is fenced (skippedStale)", async () => {
    await insertSessionIndex("sess-1", new Date(Date.now() - 13 * 3600 * 1000).toISOString());
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { skippedStale: number; inserted: number } };
    expect(body.report.skippedStale).toBe(1);
    expect(body.report.inserted).toBe(0);
    expect(await getPrCoordination(db, "sess-1")).toBeNull(); // frozen — no row materialized
  });

  it("staleCutoffHours: 0 disables the fence — the stale session materializes (escape hatch)", async () => {
    await insertSessionIndex("sess-1", new Date(Date.now() - 13 * 3600 * 1000).toISOString());
    const res = await route.handler(
      request({ staleCutoffHours: 0 }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { skippedStale: number; inserted: number } };
    expect(body.report.skippedStale).toBe(0);
    expect(body.report.inserted).toBe(1);
    expect(await getPrCoordination(db, "sess-1")).not.toBeNull();
  });

  it("staleCutoffHours: null also disables the fence", async () => {
    await insertSessionIndex("sess-1", new Date(Date.now() - 13 * 3600 * 1000).toISOString());
    const res = await route.handler(
      request({ staleCutoffHours: null }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { inserted: number } };
    expect(body.report.inserted).toBe(1);
  });

  it("a custom positive staleCutoffHours is honored (1h cutoff fences a 2h-idle session)", async () => {
    await insertSessionIndex("sess-1", new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    const res = await route.handler(
      request({ staleCutoffHours: 1 }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { skippedStale: number; inserted: number } };
    expect(body.report.skippedStale).toBe(1);
    expect(body.report.inserted).toBe(0);
  });

  it("a fresh session passes the default fence and materializes", async () => {
    await insertSessionIndex("sess-1", new Date().toISOString());
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { skippedStale: number; inserted: number } };
    expect(body.report.skippedStale).toBe(0);
    expect(body.report.inserted).toBe(1);
  });
});
