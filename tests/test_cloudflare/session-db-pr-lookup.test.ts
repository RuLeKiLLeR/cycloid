import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSessionApiShapeById, listSessions } from "../../apps/control-plane-worker/src/session/db";
import { SqliteD1 } from "./sqlite-d1-helper";

/**
 * Row-identity guard for session PR metadata projection.
 *
 * The list query reads PR links from session_pr_metadata instead of prompt
 * completions. These tests run the real SQL against an in-memory SQLite and
 * assert latest published PR semantics for sessions with zero, one, and many
 * PRs.
 */

let sqlite: Database.Database;
let db: D1Database;

function createSchema(s: Database.Database): void {
  s.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      login TEXT,
      avatar_url TEXT
    );

    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      business_id TEXT,
      status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      closed_at INTEGER,
				last_event_id TEXT,
				title TEXT,
				rich_status TEXT,
				ui_lifecycle_stage TEXT,
				model TEXT,
				reasoning_effort TEXT,
				repo_owner TEXT,
				repo_name TEXT,
      parent_session_id TEXT,
      spawn_depth INTEGER,
      initiation_mode TEXT,
      entrypoint TEXT,
      agent_runtime_backend TEXT,
      scheduled_rule_id TEXT,
      rule_name_snapshot TEXT,
      cron_snapshot TEXT,
      review_loop_done_state TEXT,
      arcanist_done_state TEXT NOT NULL DEFAULT 'working',
      arcanist_done_outcome TEXT,
      arcanist_done_reasons_json TEXT NOT NULL DEFAULT '[]',
      verification_state TEXT,
      verification_attempt_count INTEGER,
      verification_max_attempts INTEGER,
      qa_testing_state TEXT,
      qa_testing_attempt_count INTEGER,
      qa_testing_max_attempts INTEGER
    );

    CREATE TABLE prompt_runs (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE session_completions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      pr_url TEXT,
      pr_draft INTEGER,
      completed_at INTEGER NOT NULL
    );

    CREATE TABLE session_pr_metadata (
      session_id TEXT NOT NULL,
      pr_url TEXT NOT NULL,
      pr_number INTEGER,
      pr_draft INTEGER,
      published_branch TEXT,
      source_prompt_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, pr_url)
    );

    CREATE INDEX idx_session_pr_metadata_latest
      ON session_pr_metadata(session_id, updated_at DESC, pr_url DESC);

    -- listSessions LEFT JOINs pr_coordination for the FSM lifecycle columns
    -- (state/blocked_reason/failure_reason). Minimal shape — the join keys on
    -- session_id and reads three nullable columns.
    CREATE TABLE pr_coordination (
      session_id TEXT NOT NULL PRIMARY KEY,
      state TEXT,
      blocked_reason TEXT,
      failure_reason TEXT
    );
  `);
}

function seedSession(
  s: Database.Database,
  sessionId: string,
  createdAt: number,
  options: { businessId?: string | null; parentSessionId?: string | null; spawnDepth?: number | null } = {},
): void {
  s.prepare(
    `INSERT INTO session_index (
				session_id, owner_user_id, business_id, created_at, updated_at, title, rich_status,
				parent_session_id, spawn_depth
			)
			 VALUES (?, 1, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(
    sessionId,
    options.businessId ?? "biz-1",
    createdAt,
    createdAt,
    `title ${sessionId}`,
    options.parentSessionId ?? null,
    options.spawnDepth ?? null,
  );
}

function seedCompletion(
  s: Database.Database,
  sessionId: string,
  completedAt: number,
  prUrl: string | null,
  prDraft: number | null,
): void {
  s.prepare(`INSERT INTO session_completions (session_id, pr_url, pr_draft, completed_at) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    prUrl,
    prDraft,
    completedAt,
  );
}

function seedPrMetadata(
  s: Database.Database,
  sessionId: string,
  updatedAt: number,
  prUrl: string,
  prDraft: number | null,
): void {
  s.prepare(
    `INSERT INTO session_pr_metadata (session_id, pr_url, pr_draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, prUrl, prDraft, updatedAt, updatedAt);
}

function expectedLatestPr(s: Database.Database, sessionId: string): { pr_url: string | null; pr_draft: number | null } {
  const row = s
    .prepare(
      `SELECT pr_url, pr_draft FROM session_pr_metadata
       WHERE session_id = ?
       ORDER BY updated_at DESC, pr_url DESC LIMIT 1`,
    )
    .get(sessionId) as { pr_url: string | null; pr_draft: number | null } | undefined;
  return { pr_url: row?.pr_url ?? null, pr_draft: row?.pr_draft ?? null };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSchema(sqlite);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

afterEach(() => {
  sqlite.close();
});

describe("listSessions session PR metadata projection", () => {
  it("matches latest session_pr_metadata semantics for zero/one/many PRs", async () => {
    // none: no PR metadata at all
    seedSession(sqlite, "s-none", 1000);

    // completion-only: legacy completion rows no longer feed list PR metadata
    seedSession(sqlite, "s-completion-only", 2000);
    seedCompletion(sqlite, "s-completion-only", 2100, "https://pr/completion-only", 1);

    // one: a single published PR (draft)
    seedSession(sqlite, "s-one", 3000);
    seedPrMetadata(sqlite, "s-one", 3100, "https://pr/one", 1);

    // many: latest non-null wins; later NULL pr_url rows must be ignored
    seedSession(sqlite, "s-many", 4000);
    seedPrMetadata(sqlite, "s-many", 4100, "https://pr/old", 1);
    seedPrMetadata(sqlite, "s-many", 4300, "https://pr/latest", 0);
    seedPrMetadata(sqlite, "s-many", 4200, "https://pr/mid", 1);
    seedCompletion(sqlite, "s-many", 4400, "https://pr/completion-newer", 1);

    const { data } = await listSessions(db, "1", null, { limit: 50 });
    const byId = new Map(data.map((r) => [r.session_id, r]));

    for (const sessionId of ["s-none", "s-completion-only", "s-one", "s-many"]) {
      const expected = expectedLatestPr(sqlite, sessionId);
      const row = byId.get(sessionId);
      expect(row, `row for ${sessionId}`).toBeDefined();
      expect(row?.pr_url ?? null, `pr_url for ${sessionId}`).toBe(expected.pr_url);
      expect(row?.pr_draft ?? null, `pr_draft for ${sessionId}`).toBe(expected.pr_draft);
    }

    // Spot-check the concrete expected values.
    expect(byId.get("s-none")?.pr_url ?? null).toBeNull();
    expect(byId.get("s-completion-only")?.pr_url ?? null).toBeNull();
    expect(byId.get("s-one")?.pr_url).toBe("https://pr/one");
    expect(byId.get("s-one")?.pr_draft).toBe(1);
    expect(byId.get("s-many")?.pr_url).toBe("https://pr/latest");
    expect(byId.get("s-many")?.pr_draft).toBe(0);
  });

  it("resolves pr_url/pr_draft identically in the search-active query form", async () => {
    seedSession(sqlite, "s-search", 5000);
    sqlite
      .prepare(`UPDATE session_index SET title = ? WHERE session_id = ?`)
      .run("searchable architect title", "s-search");
    seedPrMetadata(sqlite, "s-search", 5100, "https://pr/search-old", 1);
    seedPrMetadata(sqlite, "s-search", 5200, "https://pr/search-new", 0);

    const { data } = await listSessions(db, "1", null, {
      limit: 50,
      search: { query: "architect" },
    });
    const row = data.find((r) => r.session_id === "s-search");
    expect(row).toBeDefined();
    expect(row?.pr_url).toBe("https://pr/search-new");
    expect(row?.pr_draft).toBe(0);
  });

  it("omits child metadata for orphaned list rows whose parent is missing", async () => {
    seedSession(sqlite, "s-parent", 6000);
    seedSession(sqlite, "s-child", 6100, { parentSessionId: "s-parent", spawnDepth: 1 });
    seedSession(sqlite, "s-orphan", 6200, { parentSessionId: "s-missing", spawnDepth: 1 });
    seedSession(sqlite, "s-cross-business", 6300, {
      businessId: "biz-2",
      parentSessionId: "s-parent",
      spawnDepth: 1,
    });

    const { data } = await listSessions(db, "1", null, { limit: 50 });
    const byId = new Map(data.map((r) => [r.session_id, r]));
    const orphan = byId.get("s-orphan");
    const crossBusiness = byId.get("s-cross-business");

    expect(byId.get("s-child")).toMatchObject({ parent_session_id: "s-parent", spawn_depth: 1 });
    expect(orphan).toBeDefined();
    expect(orphan?.parent_session_id).toBeNull();
    expect(orphan?.spawn_depth).toBeNull();
    expect(crossBusiness).toBeDefined();
    expect(crossBusiness?.parent_session_id).toBeNull();
    expect(crossBusiness?.spawn_depth).toBeNull();
  });

  it("appends missing parent anchors without advancing the pagination cursor past the child", async () => {
    seedSession(sqlite, "s-parent", 6000);
    seedSession(sqlite, "s-sibling", 6100);
    seedSession(sqlite, "s-child", 6200, { parentSessionId: "s-parent", spawnDepth: 1 });

    const { data, nextCursor } = await listSessions(db, "1", null, { limit: 1 });

    expect(data.map((row) => row.session_id)).toEqual(["s-child", "s-parent"]);
    expect(data[0]).toMatchObject({ parent_session_id: "s-parent", spawn_depth: 1 });
    expect(nextCursor).toEqual(expect.any(String));
    expect(atob(nextCursor!)).toBe("v2|6200|s-child");
  });
});

// The realtime feed (ARC-1322) reads a single session row in the same projection
// as listSessions and runs it through toSessionApiShape. These tests exercise the
// real by-id SQL (users join + PR metadata subqueries) against in-memory SQLite.
describe("getSessionApiShapeById", () => {
  function seedUser(s: Database.Database, id: number, login: string, avatar: string | null): void {
    s.prepare(`INSERT INTO users (id, login, avatar_url) VALUES (?, ?, ?)`).run(id, login, avatar);
  }

  it("returns the API-shaped row with the users join and latest PR resolved", async () => {
    seedUser(sqlite, 1, "alice", "https://avatar/alice");
    seedSession(sqlite, "s-api", 7000);
    sqlite
      .prepare(`UPDATE session_index SET repo_owner = ?, repo_name = ? WHERE session_id = ?`)
      .run("acme", "widgets", "s-api");
    seedPrMetadata(sqlite, "s-api", 7100, "https://pr/old", 1);
    seedPrMetadata(sqlite, "s-api", 7200, "https://pr/latest", 0);

    const shape = await getSessionApiShapeById(db, "s-api");

    expect(shape).not.toBeNull();
    expect(shape).toMatchObject({
      sessionId: "s-api",
      ownerUserId: "1",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "widgets",
      ownerLogin: "alice",
      ownerAvatarUrl: "https://avatar/alice",
      prUrl: "https://pr/latest",
      prDraft: false,
      phase: "idle",
    });
  });

  it("reports prUrl null for a session with no non-null completion", async () => {
    seedUser(sqlite, 1, "alice", null);
    seedSession(sqlite, "s-nopr", 7300);

    const shape = await getSessionApiShapeById(db, "s-nopr");
    expect(shape?.prUrl ?? null).toBeNull();
  });

  it("returns null for a missing session id", async () => {
    const shape = await getSessionApiShapeById(db, "does-not-exist");
    expect(shape).toBeNull();
  });
});
