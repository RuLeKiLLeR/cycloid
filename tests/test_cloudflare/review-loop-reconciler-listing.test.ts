import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteSessionWebhookRef,
  listReviewListeningGithubPrRefs,
  markReviewListeningGithubPrRefsSwept,
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
} from "../../apps/control-plane-worker/src/webhooks/db";

// ---------------------------------------------------------------------------
// FIX #15: the sweep reconciler must NOT key solely on the transient
// rich_status='review_listening' projection (a session loses it → 'running'
// while a review-loop response prompt is active). It must also list sessions
// that have a DURABLE non-terminal review-loop epoch, so head-change / PR-close
// reconciliation is not skipped during processing.
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
  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const PR_URL = "https://github.com/acme/repo/pull/42";

let sqlite: Database.Database;
let db: D1Database;

function insertSession(
  sessionId: string,
  richStatus: string,
  prUrl = PR_URL,
  doneStates: { reviewLoopDoneState?: string | null; cycloidDoneState?: string } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO session_index (session_id, owner_user_id, status, rich_status, review_loop_done_state, arcanist_done_state, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      101,
      richStatus,
      doneStates.reviewLoopDoneState ?? null,
      doneStates.cycloidDoneState ?? "working",
      "2026-01-01T00:00:00.000Z",
    );
  insertSessionWebhookRef(sessionId, prUrl);
}

function insertSessionWebhookRef(sessionId: string, prUrl: string, sweptAt = 0) {
  sqlite
    .prepare(
      `INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at, review_loop_swept_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl, sessionId, "2026-01-01T00:00:00.000Z", sweptAt);
}

function insertEpoch(sessionId: string, status: string) {
  sqlite
    .prepare(
      `INSERT INTO pr_review_response_epochs (
         id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
         expected_bots_hash, expected_bots_json, expected_bot_keys_json, first_activity_at,
         fallback_after_at, status, created_at, updated_at
       ) VALUES (?, ?, 101, 'acme', 'repo', 42, ?, 'head-sha', 1, 'hash', '[]', '[]', 0, 0, ?, 0, 0)`,
    )
    .run(`ep-${sessionId}-${status}`, sessionId, PR_URL, status);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id INTEGER,
      status TEXT,
      rich_status TEXT,
      review_loop_done_state TEXT,
      arcanist_done_state TEXT NOT NULL DEFAULT 'working',
      updated_at TEXT
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_webhook_refs (
      source TEXT NOT NULL, external_ref TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      review_loop_swept_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source, external_ref, session_id)
    )
  `);
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("listReviewListeningGithubPrRefs durable-signal source (FIX #15)", () => {
  it("lists a session whose rich_status is 'running' but which has an active (non-terminal) review-loop epoch", async () => {
    insertSession("sess-running", "running");
    insertEpoch("sess-running", "processing");

    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-running");
  });

  it("still lists a session whose rich_status IS 'review_listening' (no regression)", async () => {
    insertSession("sess-listening", "review_listening");

    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-listening");
  });

  it("keeps refs with a null owner_user_id sweep-visible for healing", async () => {
    insertSession("sess-null-owner", "review_listening");
    sqlite.prepare("UPDATE session_index SET owner_user_id = NULL WHERE session_id = ?").run("sess-null-owner");

    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });

    expect(page.data).toContainEqual({
      sessionId: "sess-null-owner",
      ownerUserId: null,
      prUrl: PR_URL,
      sweptAt: 0,
    });
  });

  it("does NOT list a 'running' session whose only epoch is terminal (completed/blocked/stale)", async () => {
    insertSession("sess-completed", "running");
    insertEpoch("sess-completed", "completed");
    insertSession("sess-blocked", "running");
    insertEpoch("sess-blocked", "blocked");
    insertSession("sess-stale", "running");
    insertEpoch("sess-stale", "stale");

    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    const ids = page.data.map((r) => r.sessionId);
    expect(ids).not.toContain("sess-completed");
    expect(ids).not.toContain("sess-blocked");
    expect(ids).not.toContain("sess-stale");
  });

  it("lists 'running' sessions across all non-terminal epoch statuses", async () => {
    for (const status of [
      "collecting",
      "ready",
      "reserving",
      "enqueued",
      "processing",
      "publishing",
      "waiting_for_owner",
    ]) {
      const sessionId = `sess-${status}`;
      insertSession(sessionId, "running");
      insertEpoch(sessionId, status);
    }

    const page = await listReviewListeningGithubPrRefs(db, { limit: 100 });
    const ids = page.data.map((r) => r.sessionId);
    for (const status of [
      "collecting",
      "ready",
      "reserving",
      "enqueued",
      "processing",
      "publishing",
      "waiting_for_owner",
    ]) {
      expect(ids).toContain(`sess-${status}`);
    }
  });

  it("paginates at PR-ref granularity when a session has multiple GitHub PR refs", async () => {
    const stalePrUrl = "https://github.com/acme/repo/pull/41";
    insertSession("sess-multiple-refs", "review_listening", stalePrUrl);
    insertSessionWebhookRef("sess-multiple-refs", PR_URL);

    const page1 = await listReviewListeningGithubPrRefs(db, { limit: 1 });
    expect(page1.data).toEqual([
      {
        sessionId: "sess-multiple-refs",
        ownerUserId: 101,
        prUrl: stalePrUrl,
        sweptAt: 0,
      },
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listReviewListeningGithubPrRefs(db, { limit: 1, cursor: page1.nextCursor });
    expect(page2.data).toEqual([
      {
        sessionId: "sess-multiple-refs",
        ownerUserId: 101,
        prUrl: PR_URL,
        sweptAt: 0,
      },
    ]);
    expect(page2.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sweep rotation watermark: the reconciler pages refs least-recently-swept
// first and bumps the watermark on every visit, so no-op refs (sessions the
// sweep can never act on) cannot pin the queue head and starve newer sessions
// out of the per-tick budget forever.
// ---------------------------------------------------------------------------

describe("review-listening refs sweep rotation watermark", () => {
  function prUrlFor(n: number): string {
    return `https://github.com/acme/repo/pull/${n}`;
  }

  it("orders refs least-recently-swept first", async () => {
    for (const [id, sweptAt] of [
      ["sess-a", 300],
      ["sess-b", 100],
      ["sess-c", 200],
    ] as const) {
      insertSession(id, "review_listening", prUrlFor(sweptAt));
      sqlite.prepare(`UPDATE session_webhook_refs SET review_loop_swept_at = ? WHERE session_id = ?`).run(sweptAt, id);
    }

    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toEqual(["sess-b", "sess-c", "sess-a"]);
  });

  it("markReviewListeningGithubPrRefsSwept bumps only the given refs", async () => {
    insertSession("sess-a", "review_listening", prUrlFor(1));
    insertSession("sess-b", "review_listening", prUrlFor(2));

    await markReviewListeningGithubPrRefsSwept(db, [{ sessionId: "sess-a", prUrl: prUrlFor(1) }], 5_000);

    const rows = sqlite
      .prepare(`SELECT session_id, review_loop_swept_at FROM session_webhook_refs ORDER BY session_id`)
      .all() as Array<{ session_id: string; review_loop_swept_at: number }>;
    expect(rows).toEqual([
      { session_id: "sess-a", review_loop_swept_at: 5_000 },
      { session_id: "sess-b", review_loop_swept_at: 0 },
    ]);
  });

  it("rotates: bumping a fetched page moves it behind the starved tail", async () => {
    for (const [i, id] of ["sess-a", "sess-b", "sess-c", "sess-d"].entries()) {
      insertSession(id, "review_listening", prUrlFor(i + 1));
    }

    const tick1 = await listReviewListeningGithubPrRefs(db, { limit: 2 });
    expect(tick1.data.map((r) => r.sessionId)).toEqual(["sess-a", "sess-b"]);
    await markReviewListeningGithubPrRefsSwept(db, tick1.data, 5_000);

    // Next tick starts from the front again (no persisted cursor) — the
    // previously starved tail must now sort first.
    const tick2 = await listReviewListeningGithubPrRefs(db, { limit: 2 });
    expect(tick2.data.map((r) => r.sessionId)).toEqual(["sess-c", "sess-d"]);
    await markReviewListeningGithubPrRefsSwept(db, tick2.data, 10_000);

    const tick3 = await listReviewListeningGithubPrRefs(db, { limit: 2 });
    expect(tick3.data.map((r) => r.sessionId)).toEqual(["sess-a", "sess-b"]);
  });

  it("sweptBefore excludes refs already bumped this tick, even when the cursor would re-admit them", async () => {
    for (const [i, id] of ["sess-a", "sess-b", "sess-c"].entries()) {
      insertSession(id, "review_listening", prUrlFor(i + 1));
    }

    const page1 = await listReviewListeningGithubPrRefs(db, { limit: 2, sweptBefore: 5_000 });
    expect(page1.data.map((r) => r.sessionId)).toEqual(["sess-a", "sess-b"]);
    await markReviewListeningGithubPrRefsSwept(db, page1.data, 5_000);

    // The cursor encodes the pre-bump sweptAt (0), so without the bound the
    // bumped rows (now 5000) re-match `swept_at > 0` and fill the tail of the
    // next page within the same tick — double-processing them.
    const page2 = await listReviewListeningGithubPrRefs(db, {
      limit: 2,
      cursor: page1.nextCursor,
      sweptBefore: 5_000,
    });
    expect(page2.data.map((r) => r.sessionId)).toEqual(["sess-c"]);
  });

  it("cursor pagination walks every ref exactly once under the watermark ordering", async () => {
    for (const [i, id] of ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"].entries()) {
      insertSession(id, "review_listening", prUrlFor(i + 1));
      sqlite
        .prepare(`UPDATE session_webhook_refs SET review_loop_swept_at = ? WHERE session_id = ?`)
        .run((i % 2) * 100, id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await listReviewListeningGithubPrRefs(db, { limit: 2, cursor });
      seen.push(...page.data.map((r) => r.sessionId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual(["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"]);
  });

  it("deleteSessionWebhookRef removes exactly the targeted ref row", async () => {
    insertSession("sess-a", "review_listening", prUrlFor(1));
    insertSessionWebhookRef("sess-a", prUrlFor(2));

    const deleted = await deleteSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrlFor(1), "sess-a");
    expect(deleted).toBe(true);

    const remaining = sqlite
      .prepare(`SELECT external_ref FROM session_webhook_refs WHERE session_id = 'sess-a' ORDER BY external_ref`)
      .all() as Array<{ external_ref: string }>;
    expect(remaining.map((r) => r.external_ref)).toEqual([prUrlFor(2)]);

    const deletedAgain = await deleteSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrlFor(1), "sess-a");
    expect(deletedAgain).toBe(false);
  });
});

describe("listReviewListeningGithubPrRefs merge-ready dormancy (epoch-aware)", () => {
  it("skips a caught-up session with NO in-flight epoch", async () => {
    insertSession("sess-dormant", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
    });
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).not.toContain("sess-dormant");
  });

  it("auto-readmits a caught-up session once a non-terminal epoch exists (the wake)", async () => {
    insertSession("sess-woken", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
    });
    insertEpoch("sess-woken", "collecting"); // a fresh feedback epoch
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-woken");
  });

  // Every status in the clause's NOT IN ('completed','blocked','stale') list must keep the session
  // dormant — guards against a future accidental narrowing of that terminal-epoch set.
  it.each(["completed", "blocked", "stale"])(
    "keeps a caught-up session dormant when its only epoch is terminal (%s)",
    async (terminalStatus) => {
      const sid = `sess-terminal-${terminalStatus}`;
      insertSession(sid, "review_listening", PR_URL, {
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
      });
      insertEpoch(sid, terminalStatus);
      const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
      expect(page.data.map((r) => r.sessionId)).not.toContain(sid);
    },
  );

  it("still sweeps a done review-loop whose verification has not settled", async () => {
    insertSession("sess-verifying", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "working",
    });
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-verifying");
  });

  it("still sweeps a session with NULL review-loop done-state even when cycloid is done", async () => {
    insertSession("sess-null-review-loop", "review_listening", PR_URL, {
      reviewLoopDoneState: null,
      cycloidDoneState: "done",
    });
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-null-review-loop");
  });
});
