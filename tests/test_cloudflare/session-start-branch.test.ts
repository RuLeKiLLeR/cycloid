import { describe, expect, it } from "vitest";

import * as doDb from "../../apps/control-plane-worker/src/session/do-db.js";
import { initSchema, MIGRATIONS } from "../../apps/control-plane-worker/src/session/schema.js";
import { FakeSqlStorage } from "./helpers/worker-harness";

type Sql = Parameters<typeof initSchema>[0];

function freshSession() {
  const { sql } = new FakeSqlStorage();
  initSchema(sql as unknown as Sql);
  return sql as unknown as Sql;
}

describe("start_branch schema + persistence", () => {
  it("registers migration 102 adding start_branch to existing durable objects", () => {
    expect(MIGRATIONS).toContainEqual({
      id: 102,
      sql: "ALTER TABLE session ADD COLUMN start_branch TEXT;",
      ignoreDuplicateColumn: true,
    });
  });

  it("round-trips startBranch through createSession + getSessionExtended", () => {
    const sql = freshSession();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      baseBranch: "main",
      startBranch: "wip/resume-me",
    });
    const ext = doDb.getSessionExtended(sql, "s-1");
    expect(ext?.baseBranch).toBe("main");
    expect(ext?.startBranch).toBe("wip/resume-me");
  });

  it("defaults startBranch to null when not provided (forks off base)", () => {
    const sql = freshSession();
    doDb.createSession(sql, { sessionId: "s-2", ownerUserId: "1", baseBranch: "main" });
    expect(doDb.getSessionExtended(sql, "s-2")?.startBranch).toBeNull();
  });

  it("updateSessionFields can set start_branch", () => {
    const sql = freshSession();
    doDb.createSession(sql, { sessionId: "s-3", ownerUserId: "1" });
    doDb.updateSessionFields(sql, "s-3", { startBranch: "feature/x" });
    expect(doDb.getSessionExtended(sql, "s-3")?.startBranch).toBe("feature/x");
  });

  it("adds start_branch defaulting to null on an existing pre-migration session table", () => {
    const { sql } = new FakeSqlStorage();
    // Pre-migration session table without start_branch.
    sql.exec(
      `CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        base_branch TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      `INSERT INTO session (session_id, owner_user_id, base_branch, created_at, updated_at)
       VALUES ('legacy-1', '1', 'main', 1, 1)`,
    );
    sql.exec("ALTER TABLE session ADD COLUMN start_branch TEXT;");
    const rows = sql.exec("SELECT start_branch FROM session WHERE session_id = 'legacy-1'").toArray() as Array<{
      start_branch: string | null;
    }>;
    expect(rows[0]?.start_branch ?? null).toBeNull();
  });
});
