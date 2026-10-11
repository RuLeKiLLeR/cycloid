import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeQaLoopBinding,
  createQaLoopBinding,
  getQaLoopBinding,
  markQaLoopBindingPromptEnqueued,
} from "../../apps/control-plane-worker/src/qa/db";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const PR_URL = "https://github.com/acme/repo/pull/42";
const LIFECYCLE_ID = "implementation-session-1";
const QA_SESSION_ID = "qa-session-1";
const PARENT_SESSION_ID = "parent-session-1";

function createMigratedSqlite(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return sqlite;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("qa_loop_session_bindings DAO", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("migration creates the binding table and QA session lookup index", () => {
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qa_loop_session_bindings'").get(),
    ).toEqual({ name: "qa_loop_session_bindings" });
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_qa_loop_session_bindings_qa_session'",
        )
        .get(),
    ).toEqual({ name: "idx_qa_loop_session_bindings_qa_session" });
  });

  function baseCreateInput(overrides: Partial<Parameters<typeof createQaLoopBinding>[1]> = {}) {
    return {
      prUrl: PR_URL,
      automatedLifecycleId: LIFECYCLE_ID,
      qaSessionId: QA_SESSION_ID,
      parentSessionId: PARENT_SESSION_ID,
      lastScheduledHeadSha: "head-a",
      activePromptId: "prompt-a",
      ...overrides,
    };
  }

  it("creates and resolves the same active binding", async () => {
    const created = await createQaLoopBinding(db, baseCreateInput());
    const resolved = await getQaLoopBinding(db, PR_URL, LIFECYCLE_ID);

    expect(created).toEqual(resolved);
    expect(resolved).toMatchObject({
      prUrl: PR_URL,
      automatedLifecycleId: LIFECYCLE_ID,
      qaSessionId: QA_SESSION_ID,
      parentSessionId: PARENT_SESSION_ID,
      status: "active",
      lastScheduledHeadSha: "head-a",
      activePromptId: "prompt-a",
    });
    expect(resolved?.createdAt).toBeGreaterThan(0);
    expect(resolved?.updatedAt).toBeGreaterThan(0);
  });

  it("resolves concurrent create attempts to one winner", async () => {
    const [first, second] = await Promise.all([
      createQaLoopBinding(db, baseCreateInput({ qaSessionId: "qa-winner" })),
      createQaLoopBinding(db, baseCreateInput({ qaSessionId: "qa-loser" })),
    ]);

    expect(first?.qaSessionId).toBe("qa-winner");
    expect(second?.qaSessionId).toBe("qa-winner");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM qa_loop_session_bindings").get()).toEqual({ count: 1 });
  });

  it("updates prompt bookkeeping only for the active bound QA session", async () => {
    await createQaLoopBinding(db, baseCreateInput());

    await expect(
      markQaLoopBindingPromptEnqueued(db, {
        prUrl: PR_URL,
        automatedLifecycleId: LIFECYCLE_ID,
        qaSessionId: "other-session",
        lastScheduledHeadSha: "head-b",
        activePromptId: "prompt-b",
      }),
    ).resolves.toBe(false);

    await expect(
      markQaLoopBindingPromptEnqueued(db, {
        prUrl: PR_URL,
        automatedLifecycleId: LIFECYCLE_ID,
        qaSessionId: QA_SESSION_ID,
        lastScheduledHeadSha: "head-b",
        activePromptId: "prompt-b",
      }),
    ).resolves.toBe(true);

    await expect(getQaLoopBinding(db, PR_URL, LIFECYCLE_ID)).resolves.toMatchObject({
      qaSessionId: QA_SESSION_ID,
      lastScheduledHeadSha: "head-b",
      activePromptId: "prompt-b",
    });
  });

  it("does not reuse closed or expired bindings", async () => {
    await createQaLoopBinding(db, baseCreateInput());
    await expect(
      closeQaLoopBinding(db, {
        prUrl: PR_URL,
        automatedLifecycleId: LIFECYCLE_ID,
        qaSessionId: QA_SESSION_ID,
        status: "closed",
      }),
    ).resolves.toBe(true);
    await expect(getQaLoopBinding(db, PR_URL, LIFECYCLE_ID)).resolves.toBeNull();

    await createQaLoopBinding(db, baseCreateInput({ automatedLifecycleId: "implementation-session-2" }));
    await expect(
      closeQaLoopBinding(db, {
        prUrl: PR_URL,
        automatedLifecycleId: "implementation-session-2",
        qaSessionId: QA_SESSION_ID,
        status: "expired",
      }),
    ).resolves.toBe(true);
    await expect(getQaLoopBinding(db, PR_URL, "implementation-session-2")).resolves.toBeNull();
  });

  it("replaces a closed binding for the same lifecycle", async () => {
    await createQaLoopBinding(db, baseCreateInput({ qaSessionId: "qa-old" }));
    await expect(
      closeQaLoopBinding(db, {
        prUrl: PR_URL,
        automatedLifecycleId: LIFECYCLE_ID,
        qaSessionId: "qa-old",
        status: "expired",
      }),
    ).resolves.toBe(true);

    await expect(
      createQaLoopBinding(
        db,
        baseCreateInput({
          qaSessionId: "qa-new",
          lastScheduledHeadSha: "head-new",
          activePromptId: "prompt-new",
        }),
      ),
    ).resolves.toMatchObject({
      qaSessionId: "qa-new",
      status: "active",
      lastScheduledHeadSha: "head-new",
      activePromptId: "prompt-new",
    });
    expect(sqlite.prepare("SELECT qa_session_id, status FROM qa_loop_session_bindings").get()).toEqual({
      qa_session_id: "qa-new",
      status: "active",
    });
  });

  it("does not touch session_index QA or verification state columns", async () => {
    sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, owner_user_id, business_id, status, created_at, updated_at,
          verification_state, verification_attempt_count, verification_max_attempts,
          qa_testing_state, qa_testing_attempt_count, qa_testing_max_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "implementation-session-1",
        1001,
        "biz-1",
        "active",
        1_783_094_400_000,
        1_783_094_400_000,
        "verification-in-progress",
        2,
        3,
        "qa-in-progress",
        2,
        3,
      );

    await createQaLoopBinding(db, baseCreateInput());
    await markQaLoopBindingPromptEnqueued(db, {
      prUrl: PR_URL,
      automatedLifecycleId: LIFECYCLE_ID,
      qaSessionId: QA_SESSION_ID,
      lastScheduledHeadSha: "head-b",
      activePromptId: "prompt-b",
    });
    await closeQaLoopBinding(db, {
      prUrl: PR_URL,
      automatedLifecycleId: LIFECYCLE_ID,
      qaSessionId: QA_SESSION_ID,
      status: "closed",
    });

    expect(
      sqlite
        .prepare(
          `SELECT verification_state, verification_attempt_count, verification_max_attempts,
                  qa_testing_state, qa_testing_attempt_count, qa_testing_max_attempts
           FROM session_index
           WHERE session_id = ?`,
        )
        .get("implementation-session-1"),
    ).toEqual({
      verification_state: "verification-in-progress",
      verification_attempt_count: 2,
      verification_max_attempts: 3,
      qa_testing_state: "qa-in-progress",
      qa_testing_attempt_count: 2,
      qa_testing_max_attempts: 3,
    });
  });
});
