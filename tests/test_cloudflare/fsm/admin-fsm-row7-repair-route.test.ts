// ARC-1330 (W11-T1) — POST /api/admin/fsm/row7-repair param validation + dryRun-first default.
//
// Proves the route contract: `target` defaults to `review` and rejects anything but review/needs_you;
// `dryRun` defaults TRUE (dryRun-first — only an explicit `dryRun:false` writes); `limit` must be a
// positive number. Enumeration + the runner run real against migrated sqlite; the honest-CI read never
// fires in these cases (no rows enumerated / no creds), so no GitHub is touched.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { adminFsmRow7RepairRoutes } from "../../../apps/control-plane-worker/src/routes/admin-fsm-row7-repair";
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

const route = adminFsmRow7RepairRoutes[0];

const ADMIN_AUTH: AuthInfo = {
  userId: "1",
  tokenSource: "admin-token",
  authMode: "admin_token",
  canAccessAllSessions: true,
};

function request(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/admin/fsm/row7-repair", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/fsm/row7-repair — validation + defaults", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = new SqliteD1(createMigratedSqlite()) as unknown as D1Database;
    env = { DB: db, FSM_MODE: "live" } as unknown as Env;
  });

  it("rejects an invalid target with 400", async () => {
    const res = await route.handler(request({ target: "bogus" }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("target");
  });

  it("rejects a non-positive limit with 400", async () => {
    const res = await route.handler(request({ limit: 0 }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("empty body defaults to a REVIEW DRY RUN", async () => {
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; report: { target: string; dryRun: boolean; enumerated: number } };
    expect(body.ok).toBe(true);
    expect(body.report).toMatchObject({ target: "review", dryRun: true, enumerated: 0 });
  });

  it("target=needs_you, dryRun:false is honored (an empty cohort is a clean no-op run)", async () => {
    const res = await route.handler(
      request({ target: "needs_you", dryRun: false }),
      env,
      [] as unknown as RegExpMatchArray,
      ADMIN_AUTH,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { target: string; dryRun: boolean; reopened: number } };
    expect(body.report).toMatchObject({ target: "needs_you", dryRun: false, reopened: 0 });
  });
});
