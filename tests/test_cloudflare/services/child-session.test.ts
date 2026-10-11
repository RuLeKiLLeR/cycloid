import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildChildSessionSummary,
  buildChildSessionUrl,
  getChildSessionStatusSummary,
  listChildSessionSummaries,
  markChildSessionCapacityProjected,
  reacquireChildSessionConcurrency,
  releaseChildSessionConcurrency,
  releaseUnprojectedChildSessionCapacity,
  reserveChildSessionCapacity,
  resolveChildSessionParentPromptId,
  validateChildSessionCreation,
} from "../../../apps/control-plane-worker/src/services/child-session";
import {
  type ChildSessionRow,
  getChildContextForSession,
  getChildSessionRow,
  type ParentSessionRow,
} from "../../../apps/control-plane-worker/src/session/child-session-db";
import { getSessionView } from "../../../apps/control-plane-worker/src/session/state";
import { QA_TESTER_AGENT_ROLE } from "../../../shared/agent/constants";
import {
  MAX_CHILD_SESSION_SPAWN_DEPTH,
  MAX_CHILD_SESSIONS_PER_PROMPT,
  MAX_CONCURRENT_CHILD_SESSIONS_PER_USER,
  MAX_TOTAL_CHILD_SESSIONS_PER_SESSION,
  SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH,
  SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH,
} from "../../../shared/constants/session";

// ----- Fake D1 -------------------------------------------------------------

type CountResult = { n: number };

interface FakeRows {
  parent: ParentSessionRow | null;
  countForPrompt: number;
  countForSession: number;
  countConcurrent: number;
  installationRow?: { installation_id: number; suspended_at: string | null } | null;
  userRepoAccess?: boolean;
}

class FakeD1 {
  constructor(public state: FakeRows) {}

  prepare(query: string): {
    bind: (...args: unknown[]) => { first: <T>() => Promise<T | null>; all: () => Promise<{ results: unknown[] }> };
  } {
    const state = this.state;
    return {
      bind: () => ({
        first: async <T>(): Promise<T | null> => {
          if (query.includes("FROM session_index WHERE session_id = ?") && query.includes("spawn_depth")) {
            return (state.parent as unknown as T) ?? null;
          }
          if (query.includes("COUNT(*)") && query.includes("spawned_by_user_id = ?")) {
            return { n: state.countConcurrent } as unknown as T;
          }
          if (query.includes("COUNT(*)") && query.includes("parent_prompt_id = ?")) {
            return { n: state.countForPrompt } as unknown as T;
          }
          if (query.includes("COUNT(*)") && query.includes("parent_session_id = ?")) {
            return { n: state.countForSession } as unknown as T;
          }
          // Repo-gate path: installations_by_owner
          if (query.includes("FROM installations") || query.includes("github_app_installations")) {
            return (state.installationRow as unknown as T) ?? null;
          }
          // Repo-access KV/cache short-circuit (return null and rely on githubTokenEnv mocks)
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    };
  }
}

class SqliteD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly sqlite: Database.Database,
    private readonly query: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.query).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.query).all(...this.params) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.sqlite.prepare(this.query).run(...this.params);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE child_session_limit_reservations (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        parent_prompt_id TEXT NOT NULL,
        spawned_by_user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        projected_at INTEGER,
        concurrent_released_at INTEGER
      );
    `);
    this.sqlite.exec(`
      CREATE TABLE session_index (
        session_id TEXT PRIMARY KEY,
        business_id TEXT,
        parent_session_id TEXT,
        parent_prompt_id TEXT,
        spawned_by_user_id INTEGER,
        spawn_depth INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        status TEXT NOT NULL,
        rich_status TEXT,
        publish_status TEXT,
        publish_error TEXT,
        agent_role TEXT,
        target_pr_url TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);
    this.sqlite.exec(`
      CREATE TABLE session_webhook_refs (
        source TEXT NOT NULL,
        external_ref TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source, external_ref, session_id)
      );
    `);
    this.sqlite.exec(`
      CREATE TABLE session_completions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        pr_url TEXT
      );
    `);
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }

  async batch<T>(statements: SqliteD1Statement[]): Promise<{ results: T[] }[]> {
    const out: { results: T[] }[] = [];
    for (const statement of statements) {
      out.push(await statement.all<T>());
    }
    return out;
  }

  close(): void {
    this.sqlite.close();
  }
}

const baseParent: ParentSessionRow = {
  session_id: "parent-1",
  owner_user_id: 42,
  business_id: "biz-1",
  repo_owner: "acme",
  repo_name: "widget",
  installation_id: 99,
  spawn_depth: 0,
};

function buildEnv(overrides: Partial<{ FRONTEND_URL: string }> = {}) {
  return { FRONTEND_URL: "https://app.example.com", REPOS_CACHE: undefined, ...overrides } as unknown as Parameters<
    typeof validateChildSessionCreation
  >[0]["env"];
}

vi.mock("../../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: vi.fn(async () => ({ ok: true, installationId: 99 })),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionView: vi.fn(),
}));

function childSessionAuth(overrides: Partial<Parameters<typeof validateChildSessionCreation>[0]["auth"]> = {}) {
  return { userId: "42", canAccessAllSessions: false, businessId: "biz-1", ...overrides };
}

function childSessionInternalAuth() {
  return { userId: "42", canAccessAllSessions: false, businessId: "biz-1" };
}

function mockSessionViewProcessingPrompt(promptId: string | null, payloadOk = true) {
  vi.mocked(getSessionView).mockResolvedValue({
    status: 200,
    ok: true,
    payload: {
      ok: payloadOk,
      session: {},
      prompts: [],
      queue: { queuedCount: 0, processingPromptId: promptId },
    },
  } as Awaited<ReturnType<typeof getSessionView>>);
}

describe("services/child-session validateChildSessionCreation", () => {
  it("encodes child session ids in generated child session URLs", () => {
    expect(buildChildSessionUrl("https://app.example.com/", "child session/1")).toBe(
      "https://app.example.com/sessions/child%20session%2F1",
    );
  });

  it("succeeds for an authorized same-repo request and returns a plan with parentContext", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });

    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth({ businessRole: "member" }),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.parentContext).toEqual({
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      spawnedByUserId: 42,
      spawnDepth: 1,
    });
    expect(result.plan.installationId).toBe(99);
    expect(result.plan.childRepoOwner).toBe("acme");
    expect(result.plan.childRepoName).toBe("widget");
  });

  it("rejects empty prompt and missing repositoryId", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const r1 = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: " ", repositoryId: "acme/widget" },
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("missing_field");

    const r2 = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "" },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("missing_field");
  });

  it("rejects malformed repositoryId", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    for (const repositoryId of ["not-a-repo-id", "acme//widget", "acme/widget/extra"]) {
      const result = await validateChildSessionCreation({
        env: buildEnv(),
        db: db as unknown as D1Database,
        auth: childSessionAuth(),
        parentSessionId: "parent-1",
        parentPromptId: "prompt-A",
        request: { prompt: "do work", repositoryId },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_repo");
    }
  });

  it("rejects prompt and title values over the shared caps", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const oversizedPrompt = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "x".repeat(SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH + 1), repositoryId: "acme/widget" },
    });
    expect(oversizedPrompt.ok).toBe(false);
    if (!oversizedPrompt.ok) {
      expect(oversizedPrompt.error.code).toBe("invalid_input");
      expect(oversizedPrompt.error.message).toContain(String(SPAWN_CHILD_SESSION_MAX_PROMPT_LENGTH));
    }

    const oversizedTitle = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: {
        prompt: "do work",
        repositoryId: "acme/widget",
        title: "x".repeat(SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH + 1),
      },
    });
    expect(oversizedTitle.ok).toBe(false);
    if (!oversizedTitle.ok) {
      expect(oversizedTitle.error.code).toBe("invalid_input");
      expect(oversizedTitle.error.message).toContain(String(SPAWN_CHILD_SESSION_MAX_TITLE_LENGTH));
    }
  });

  it("rejects when parent session is not found", async () => {
    const db = new FakeD1({ parent: null, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "missing",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parent_not_found");
  });

  it("fails closed when the caller business does not match the parent session", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth({ businessId: "biz-2" }),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parent_not_found");
  });

  it("allows null-business callers to create child sessions for null-business parents", async () => {
    const db = new FakeD1({
      parent: { ...baseParent, business_id: null },
      countForPrompt: 0,
      countForSession: 0,
      countConcurrent: 0,
    });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth({ businessId: null }),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(true);
  });

  it("allows all-session callers to create child sessions across business boundaries", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth({ canAccessAllSessions: true, businessId: "biz-2" }),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects grandchild creation (depth limit)", async () => {
    const childParent: ParentSessionRow = { ...baseParent, spawn_depth: MAX_CHILD_SESSION_SPAWN_DEPTH };
    const db = new FakeD1({ parent: childParent, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "child-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("depth_limit_exceeded");
  });

  it("rejects cross-repo requests", async () => {
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/other-repo" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cross_repo_not_supported");
  });

  it("rejects when parent has no repo context", async () => {
    const repoless: ParentSessionRow = { ...baseParent, repo_owner: null, repo_name: null };
    const db = new FakeD1({ parent: repoless, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_repo");
  });

  it("propagates repo-gate failure as unauthorized_repo", async () => {
    const repoGate = await import("../../../apps/control-plane-worker/src/services/repo-gate");
    vi.mocked(repoGate.verifyRepoAccessAndInstallation).mockResolvedValueOnce({
      ok: false,
      response: new Response("denied", { status: 403 }),
    });
    const db = new FakeD1({ parent: { ...baseParent }, countForPrompt: 0, countForSession: 0, countConcurrent: 0 });
    const result = await validateChildSessionCreation({
      env: buildEnv(),
      db: db as unknown as D1Database,
      auth: childSessionAuth(),
      parentSessionId: "parent-1",
      parentPromptId: "prompt-A",
      request: { prompt: "do work", repositoryId: "acme/widget" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthorized_repo");
  });
});

describe("session/child-session-db getChildSessionRow", () => {
  const sqliteDbs: SqliteD1[] = [];

  afterEach(() => {
    while (sqliteDbs.length) sqliteDbs.pop()!.close();
  });

  function createSqliteD1(): SqliteD1 {
    const db = new SqliteD1();
    sqliteDbs.push(db);
    return db;
  }

  it("returns null for top-level sessions", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, NULL)`,
      )
      .run("parent-1", "biz-1", "Parent", "active", "idle", "2026-04-08T00:00:00.000Z");

    await expect(getChildSessionRow(db as unknown as D1Database, "parent-1")).resolves.toBeNull();
  });

  it("returns child rows only when parent metadata is present", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .run("child-1", "biz-1", "parent-1", "prompt-1", 42, "Child", "active", "running", "2026-04-08T00:00:01.000Z");

    await expect(getChildSessionRow(db as unknown as D1Database, "child-1")).resolves.toMatchObject({
      session_id: "child-1",
      business_id: "biz-1",
      parent_session_id: "parent-1",
      parent_prompt_id: "prompt-1",
    });
  });

  it("filters child summaries to the parent business boundary", async () => {
    const db = createSqliteD1();
    const insert = db.sqlite.prepare(
      `INSERT INTO session_index (
        session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
        title, status, rich_status, created_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
    );
    insert.run(
      "child-1",
      "biz-1",
      "parent-1",
      "prompt-1",
      42,
      "Allowed",
      "active",
      "running",
      "2026-04-08T00:00:01.000Z",
    );
    insert.run(
      "child-2",
      "biz-2",
      "parent-1",
      "prompt-1",
      43,
      "Wrong business",
      "active",
      "running",
      "2026-04-08T00:00:02.000Z",
    );

    await expect(
      listChildSessionSummaries(db as unknown as D1Database, "parent-1", "biz-1", "https://app.example.com", {}),
    ).resolves.toHaveLength(1);
  });

  it("keeps child summary PR URLs null unless requested", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .run("child-1", "biz-1", "parent-1", "prompt-1", 42, "Child", "active", "running", "2026-04-08T00:00:01.000Z");
    db.sqlite
      .prepare(
        `INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at)
         VALUES ('github_pr_url', 'https://github.com/acme/widget/pull/2', 'child-1', '2026-04-08T00:00:03.000Z')`,
      )
      .run();

    const summaries = await listChildSessionSummaries(
      db as unknown as D1Database,
      "parent-1",
      "biz-1",
      "https://app.example.com",
      {},
    );

    expect(summaries[0].prUrl).toBeNull();
  });

  it("loads requested child summary PR URLs in the child list query", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .run("child-1", "biz-1", "parent-1", "prompt-1", 42, "Child", "active", "running", "2026-04-08T00:00:01.000Z");
    db.sqlite
      .prepare(
        `INSERT INTO session_completions (
          id, session_id, prompt_id, owner_user_id, repo_owner, repo_name, prompt_text, success, completed_at, created_at, pr_url
        ) VALUES ('completion-1', 'child-1', 'prompt-1', '42', 'acme', 'widget', 'do work', 1, 1000, 1000,
          'https://github.com/acme/widget/pull/1')`,
      )
      .run();
    db.sqlite
      .prepare(
        `INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at)
         VALUES ('github_pr_url', 'https://github.com/acme/widget/pull/2', 'child-1', '2026-04-08T00:00:03.000Z')`,
      )
      .run();

    const summaries = await listChildSessionSummaries(
      db as unknown as D1Database,
      "parent-1",
      "biz-1",
      "https://app.example.com",
      { includePrUrl: true },
    );

    expect(summaries[0].prUrl).toBe("https://github.com/acme/widget/pull/2");
  });

  it("falls back to session completion PR URLs when no webhook ref exists", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .run("child-1", "biz-1", "parent-1", "prompt-1", 42, "Child", "active", "running", "2026-04-08T00:00:01.000Z");
    db.sqlite
      .prepare(
        `INSERT INTO session_completions (
          id, session_id, prompt_id, owner_user_id, repo_owner, repo_name, prompt_text, success, completed_at, created_at, pr_url
        ) VALUES ('completion-1', 'child-1', 'prompt-1', '42', 'acme', 'widget', 'do work', 1, 1000, 1000,
          'https://github.com/acme/widget/pull/1')`,
      )
      .run();

    const summaries = await listChildSessionSummaries(
      db as unknown as D1Database,
      "parent-1",
      "biz-1",
      "https://app.example.com",
      { includePrUrl: true },
    );

    expect(summaries[0].prUrl).toBe("https://github.com/acme/widget/pull/1");
  });

  it("rejects child status rows outside the parent business boundary", async () => {
    const db = createSqliteD1();
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .run(
        "child-2",
        "biz-2",
        "parent-1",
        "prompt-1",
        43,
        "Wrong business",
        "active",
        "running",
        "2026-04-08T00:00:02.000Z",
      );

    await expect(
      getChildSessionStatusSummary({
        db: db as unknown as D1Database,
        childSessionId: "child-2",
        parentSessionId: "parent-1",
        parentBusinessId: "biz-1",
        frontendUrl: "https://app.example.com",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("session/child-session-db getChildContextForSession", () => {
  const sqliteDbs: SqliteD1[] = [];

  afterEach(() => {
    while (sqliteDbs.length) sqliteDbs.pop()!.close();
  });

  function createSqliteD1(): SqliteD1 {
    const db = new SqliteD1();
    sqliteDbs.push(db);
    return db;
  }

  function insertSession(
    db: SqliteD1,
    args: {
      sessionId: string;
      businessId: string | null;
      parentSessionId: string | null;
      createdAt: string;
      agentRole?: string | null;
      targetPrUrl?: string | null;
    },
  ): void {
    db.sqlite
      .prepare(
        `INSERT INTO session_index (
          session_id, business_id, parent_session_id, parent_prompt_id, spawned_by_user_id, spawn_depth,
          title, status, rich_status, agent_role, target_pr_url, created_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        args.sessionId,
        args.businessId,
        args.parentSessionId,
        args.parentSessionId ? "prompt-1" : null,
        args.parentSessionId ? 42 : null,
        args.parentSessionId ? 1 : 0,
        "Title",
        "active",
        "running",
        args.agentRole ?? null,
        args.targetPrUrl ?? null,
        args.createdAt,
      );
  }

  function insertGithubPrRef(db: SqliteD1, args: { sessionId: string; prUrl: string; updatedAt: string }): void {
    db.sqlite
      .prepare(
        `INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at)
         VALUES ('github_pr_url', ?, ?, ?)`,
      )
      .run(args.prUrl, args.sessionId, args.updatedAt);
  }

  it("returns the child row and child ids in a single batch round-trip", async () => {
    const db = createSqliteD1();
    const batchSpy = vi.spyOn(db, "batch");
    // The session itself is a child of parent-0.
    insertSession(db, {
      sessionId: "sess-1",
      businessId: "biz-1",
      parentSessionId: "parent-0",
      createdAt: "2026-04-08T00:00:00.000Z",
    });
    // And it has two children of its own.
    insertSession(db, {
      sessionId: "child-a",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:01.000Z",
    });
    insertSession(db, {
      sessionId: "child-b",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:02.000Z",
    });

    const result = await getChildContextForSession(db as unknown as D1Database, "sess-1", "biz-1");

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(result.childRow).toMatchObject({ session_id: "sess-1", parent_session_id: "parent-0" });
    expect(result.childIds).toEqual(["child-b", "child-a"]);
    expect(result.qaChildSessionId).toBeNull();
  });

  it("returns a null child row for a top-level session and filters children by business", async () => {
    const db = createSqliteD1();
    insertSession(db, {
      sessionId: "sess-1",
      businessId: "biz-1",
      parentSessionId: null,
      createdAt: "2026-04-08T00:00:00.000Z",
    });
    insertSession(db, {
      sessionId: "child-same",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:01.000Z",
    });
    insertSession(db, {
      sessionId: "child-other",
      businessId: "biz-2",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:02.000Z",
    });

    const result = await getChildContextForSession(db as unknown as D1Database, "sess-1", "biz-1");

    expect(result.childRow).toBeNull();
    expect(result.childIds).toEqual(["child-same"]);
    expect(result.qaChildSessionId).toBeNull();
  });

  it("returns only the verifier child targeting the parent PR as the QA child", async () => {
    const db = createSqliteD1();
    insertSession(db, {
      sessionId: "sess-1",
      businessId: "biz-1",
      parentSessionId: null,
      createdAt: "2026-04-08T00:00:00.000Z",
    });
    insertSession(db, {
      sessionId: "child-ordinary",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:04.000Z",
      agentRole: "implementation",
      targetPrUrl: "https://github.com/acme/widget/pull/1",
    });
    insertSession(db, {
      sessionId: "child-qa",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:03.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: "https://github.com/acme/widget/pull/1",
    });
    insertSession(db, {
      sessionId: "child-other-pr",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: "https://github.com/acme/widget/pull/2",
    });
    insertSession(db, {
      sessionId: "child-other-business",
      businessId: "biz-2",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:05.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: "https://github.com/acme/widget/pull/1",
    });

    const result = await getChildContextForSession(
      db as unknown as D1Database,
      "sess-1",
      "biz-1",
      "https://github.com/acme/widget/pull/1",
    );

    expect(result.childRow).toBeNull();
    expect(result.childIds).toEqual(["child-ordinary", "child-qa", "child-other-pr"]);
    expect(result.qaChildSessionId).toBe("child-qa");
  });

  it("uses webhook PR refs when verifier child target projections are missing or stale", async () => {
    const db = createSqliteD1();
    const parentPrUrl = "https://github.com/acme/widget/pull/1";
    const otherPrUrl = "https://github.com/acme/widget/pull/2";
    insertSession(db, {
      sessionId: "sess-1",
      businessId: "biz-1",
      parentSessionId: null,
      createdAt: "2026-04-08T00:00:00.000Z",
    });
    insertSession(db, {
      sessionId: "child-missing-target",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: null,
    });
    insertGithubPrRef(db, {
      sessionId: "child-missing-target",
      prUrl: parentPrUrl,
      updatedAt: "2026-04-08T00:00:02.000Z",
    });

    await expect(
      getChildContextForSession(db as unknown as D1Database, "sess-1", "biz-1", parentPrUrl),
    ).resolves.toMatchObject({ qaChildSessionId: "child-missing-target" });

    insertSession(db, {
      sessionId: "child-stale-target",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:03.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: otherPrUrl,
    });
    insertGithubPrRef(db, {
      sessionId: "child-stale-target",
      prUrl: parentPrUrl,
      updatedAt: "2026-04-08T00:00:04.000Z",
    });

    await expect(
      getChildContextForSession(db as unknown as D1Database, "sess-1", "biz-1", parentPrUrl),
    ).resolves.toMatchObject({ qaChildSessionId: "child-stale-target" });

    insertSession(db, {
      sessionId: "child-webhook-other-pr",
      businessId: "biz-1",
      parentSessionId: "sess-1",
      createdAt: "2026-04-08T00:00:05.000Z",
      agentRole: QA_TESTER_AGENT_ROLE,
      targetPrUrl: parentPrUrl,
    });
    insertGithubPrRef(db, {
      sessionId: "child-webhook-other-pr",
      prUrl: otherPrUrl,
      updatedAt: "2026-04-08T00:00:06.000Z",
    });

    await expect(
      getChildContextForSession(db as unknown as D1Database, "sess-1", "biz-1", parentPrUrl),
    ).resolves.toMatchObject({ qaChildSessionId: "child-stale-target" });
  });
});

describe("services/child-session resolveChildSessionParentPromptId", () => {
  beforeEach(() => {
    vi.mocked(getSessionView).mockReset();
    mockSessionViewProcessingPrompt("prompt-active");
  });

  it("uses the request parent prompt id when provided", async () => {
    const result = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-1",
      auth: childSessionInternalAuth(),
      requestedParentPromptId: " prompt-request ",
    });

    expect(result).toEqual({ parentPromptId: "prompt-request", source: "request" });
    expect(getSessionView).not.toHaveBeenCalled();
  });

  it("derives a stable parent prompt id from the active parent prompt when omitted", async () => {
    mockSessionViewProcessingPrompt("prompt-active");

    const first = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-1",
      auth: childSessionInternalAuth(),
    });
    const second = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-2",
      auth: childSessionInternalAuth(),
    });

    expect(first).toEqual({ parentPromptId: "prompt-active", source: "active_prompt" });
    expect(second).toEqual({ parentPromptId: "prompt-active", source: "active_prompt" });
  });

  it("makes omitted MCP calls share the active prompt bucket so the per-prompt cap engages", async () => {
    mockSessionViewProcessingPrompt("prompt-active");
    const db = new SqliteD1();
    try {
      for (let i = 0; i < MAX_CHILD_SESSIONS_PER_PROMPT; i += 1) {
        const resolved = await resolveChildSessionParentPromptId({
          env: buildEnv(),
          parentSessionId: "parent-1",
          requestId: `req-${i}`,
          auth: childSessionInternalAuth(),
        });
        const reserved = await reserveChildSessionCapacity({
          db: db as unknown as D1Database,
          childSessionId: `child-${i}`,
          plan: {
            parent: { ...baseParent },
            parentContext: {
              parentSessionId: "parent-1",
              parentPromptId: resolved.parentPromptId,
              spawnedByUserId: 42,
              spawnDepth: 1,
            },
            childRepoOwner: "acme",
            childRepoName: "widget",
            installationId: 99,
            request: { prompt: "do work", repositoryId: "acme/widget" },
          },
        });
        expect(reserved.ok).toBe(true);
      }

      const rejectedPromptId = await resolveChildSessionParentPromptId({
        env: buildEnv(),
        parentSessionId: "parent-1",
        requestId: "req-over",
        auth: childSessionInternalAuth(),
      });
      const rejected = await reserveChildSessionCapacity({
        db: db as unknown as D1Database,
        childSessionId: "child-over",
        plan: {
          parent: { ...baseParent },
          parentContext: {
            parentSessionId: "parent-1",
            parentPromptId: rejectedPromptId.parentPromptId,
            spawnedByUserId: 42,
            spawnDepth: 1,
          },
          childRepoOwner: "acme",
          childRepoName: "widget",
          installationId: 99,
          request: { prompt: "do work", repositoryId: "acme/widget" },
        },
      });

      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("max_children_per_prompt");
    } finally {
      db.close();
    }
  });

  it("falls back to a stable prompt bucket when no active parent prompt is available", async () => {
    mockSessionViewProcessingPrompt(null);

    const first = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-1",
      auth: childSessionInternalAuth(),
    });
    const second = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-2",
      auth: childSessionInternalAuth(),
    });

    expect(first).toEqual({ parentPromptId: "fallback:parent-1", source: "generated_fallback" });
    expect(second).toEqual({ parentPromptId: "fallback:parent-1", source: "generated_fallback" });
  });

  it("falls back to a stable prompt bucket when the session view payload is not ok", async () => {
    mockSessionViewProcessingPrompt("stale-prompt", false);

    const result = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-1",
      auth: childSessionInternalAuth(),
    });

    expect(result.source).toBe("generated_fallback");
    expect(result.parentPromptId).toBe("fallback:parent-1");
  });

  it("falls back to a stable prompt bucket when the session view lookup fails", async () => {
    vi.mocked(getSessionView).mockRejectedValue(new Error("session view unavailable"));

    const result = await resolveChildSessionParentPromptId({
      env: buildEnv(),
      parentSessionId: "parent-1",
      requestId: "req-1",
      auth: childSessionInternalAuth(),
    });

    expect(result.source).toBe("generated_fallback");
    expect(result.parentPromptId).toBe("fallback:parent-1");
  });

  it("makes omitted fallback calls share one bucket so the per-prompt cap engages", async () => {
    vi.mocked(getSessionView).mockRejectedValue(new Error("session view unavailable"));
    const db = new SqliteD1();
    try {
      for (let i = 0; i < MAX_CHILD_SESSIONS_PER_PROMPT; i += 1) {
        const resolved = await resolveChildSessionParentPromptId({
          env: buildEnv(),
          parentSessionId: "parent-1",
          requestId: `req-${i}`,
          auth: childSessionInternalAuth(),
        });
        expect(resolved.parentPromptId).toBe("fallback:parent-1");

        const reserved = await reserveChildSessionCapacity({
          db: db as unknown as D1Database,
          childSessionId: `fallback-child-${i}`,
          plan: {
            parent: { ...baseParent },
            parentContext: {
              parentSessionId: "parent-1",
              parentPromptId: resolved.parentPromptId,
              spawnedByUserId: 42,
              spawnDepth: 1,
            },
            childRepoOwner: "acme",
            childRepoName: "widget",
            installationId: 99,
            request: { prompt: "do work", repositoryId: "acme/widget" },
          },
        });
        expect(reserved.ok).toBe(true);
      }

      const rejectedPromptId = await resolveChildSessionParentPromptId({
        env: buildEnv(),
        parentSessionId: "parent-1",
        requestId: "req-over",
        auth: childSessionInternalAuth(),
      });
      const rejected = await reserveChildSessionCapacity({
        db: db as unknown as D1Database,
        childSessionId: "fallback-child-over",
        plan: {
          parent: { ...baseParent },
          parentContext: {
            parentSessionId: "parent-1",
            parentPromptId: rejectedPromptId.parentPromptId,
            spawnedByUserId: 42,
            spawnDepth: 1,
          },
          childRepoOwner: "acme",
          childRepoName: "widget",
          installationId: 99,
          request: { prompt: "do work", repositoryId: "acme/widget" },
        },
      });

      expect(rejectedPromptId.parentPromptId).toBe("fallback:parent-1");
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("max_children_per_prompt");
    } finally {
      db.close();
    }
  });
});

describe("services/child-session reserveChildSessionCapacity", () => {
  const dbs: SqliteD1[] = [];

  function createDb(): SqliteD1 {
    const db = new SqliteD1();
    dbs.push(db);
    return db;
  }

  function plan(overrides: Partial<Parameters<typeof reserveChildSessionCapacity>[0]["plan"]> = {}) {
    return {
      parent: { ...baseParent },
      parentContext: {
        parentSessionId: "parent-1",
        parentPromptId: "prompt-A",
        spawnedByUserId: 42,
        spawnDepth: 1,
      },
      childRepoOwner: "acme",
      childRepoName: "widget",
      installationId: 99,
      request: { prompt: "do work", repositoryId: "acme/widget" },
      ...overrides,
    };
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it("atomically admits only up to the per-prompt cap", async () => {
    const db = createDb();
    const results = await Promise.all(
      Array.from({ length: MAX_CHILD_SESSIONS_PER_PROMPT + 1 }, (_, i) =>
        reserveChildSessionCapacity({
          db: db as unknown as D1Database,
          childSessionId: `child-${i}`,
          plan: plan(),
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(MAX_CHILD_SESSIONS_PER_PROMPT);
    const rejected = results.find((result) => !result.ok);
    expect(rejected?.ok).toBe(false);
    if (rejected && !rejected.ok) expect(rejected.error.code).toBe("max_children_per_prompt");
  });

  it("rejects at the per-session cap across prompts", async () => {
    const db = createDb();
    for (let i = 0; i < MAX_TOTAL_CHILD_SESSIONS_PER_SESSION; i += 1) {
      const result = await reserveChildSessionCapacity({
        db: db as unknown as D1Database,
        childSessionId: `child-${i}`,
        plan: plan({
          parentContext: {
            parentSessionId: "parent-1",
            parentPromptId: `prompt-${i}`,
            spawnedByUserId: 100 + i,
            spawnDepth: 1,
          },
        }),
      });
      expect(result.ok).toBe(true);
    }

    const rejected = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-over",
      plan: plan({
        parentContext: {
          parentSessionId: "parent-1",
          parentPromptId: "prompt-over",
          spawnedByUserId: 999,
          spawnDepth: 1,
        },
      }),
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("max_children_per_session");
  });

  it("releases unprojected reservations but keeps historical projected reservations", async () => {
    const db = createDb();
    const first = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-1",
      plan: plan(),
    });
    expect(first.ok).toBe(true);
    await releaseUnprojectedChildSessionCapacity(db as unknown as D1Database, "child-1");

    const second = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-2",
      plan: plan(),
    });
    expect(second.ok).toBe(true);
    await markChildSessionCapacityProjected(db as unknown as D1Database, "child-2");
    await releaseUnprojectedChildSessionCapacity(db as unknown as D1Database, "child-2");

    const rows = db.sqlite.prepare("SELECT child_session_id FROM child_session_limit_reservations").all();
    expect(rows).toEqual([{ child_session_id: "child-2" }]);
  });

  it("releases only the concurrent slot when a child closes", async () => {
    const db = createDb();
    for (let i = 0; i < MAX_CONCURRENT_CHILD_SESSIONS_PER_USER; i += 1) {
      const result = await reserveChildSessionCapacity({
        db: db as unknown as D1Database,
        childSessionId: `child-${i}`,
        plan: plan({
          parentContext: {
            parentSessionId: `parent-${i}`,
            parentPromptId: `prompt-${i}`,
            spawnedByUserId: 42,
            spawnDepth: 1,
          },
        }),
      });
      expect(result.ok).toBe(true);
    }

    const rejected = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-over",
      plan: plan({
        parent: { ...baseParent, session_id: "parent-over" },
        parentContext: {
          parentSessionId: "parent-over",
          parentPromptId: "prompt-over",
          spawnedByUserId: 42,
          spawnDepth: 1,
        },
      }),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("concurrent_limit_exceeded");

    await releaseChildSessionConcurrency(db as unknown as D1Database, "child-0");
    const admitted = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-after-release",
      plan: plan({
        parent: { ...baseParent, session_id: "parent-after-release" },
        parentContext: {
          parentSessionId: "parent-after-release",
          parentPromptId: "prompt-after-release",
          spawnedByUserId: 42,
          spawnDepth: 1,
        },
      }),
    });
    expect(admitted.ok).toBe(true);
  });

  it("reacquires a released concurrent slot for child unarchive when capacity is available", async () => {
    const db = createDb();
    const reserved = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-1",
      plan: plan(),
    });
    expect(reserved.ok).toBe(true);

    await releaseChildSessionConcurrency(db as unknown as D1Database, "child-1");
    expect(await reacquireChildSessionConcurrency(db as unknown as D1Database, "child-1")).toBe(true);

    const row = db.sqlite
      .prepare("SELECT concurrent_released_at FROM child_session_limit_reservations WHERE child_session_id = ?")
      .get("child-1") as { concurrent_released_at: number | null };
    expect(row.concurrent_released_at).toBeNull();
  });

  it("does not reacquire a released concurrent slot for child unarchive when the user is at cap", async () => {
    const db = createDb();
    const released = await reserveChildSessionCapacity({
      db: db as unknown as D1Database,
      childSessionId: "child-released",
      plan: plan({
        parent: { ...baseParent, session_id: "parent-released" },
        parentContext: {
          parentSessionId: "parent-released",
          parentPromptId: "prompt-released",
          spawnedByUserId: 42,
          spawnDepth: 1,
        },
      }),
    });
    expect(released.ok).toBe(true);
    await releaseChildSessionConcurrency(db as unknown as D1Database, "child-released");

    for (let i = 0; i < MAX_CONCURRENT_CHILD_SESSIONS_PER_USER; i += 1) {
      const result = await reserveChildSessionCapacity({
        db: db as unknown as D1Database,
        childSessionId: `child-active-${i}`,
        plan: plan({
          parent: { ...baseParent, session_id: `parent-active-${i}` },
          parentContext: {
            parentSessionId: `parent-active-${i}`,
            parentPromptId: `prompt-active-${i}`,
            spawnedByUserId: 42,
            spawnDepth: 1,
          },
        }),
      });
      expect(result.ok).toBe(true);
    }

    expect(await reacquireChildSessionConcurrency(db as unknown as D1Database, "child-released")).toBe(false);
  });
});

describe("services/child-session buildChildSessionSummary", () => {
  const row: ChildSessionRow = {
    session_id: "child-1",
    business_id: "biz-1",
    parent_session_id: "parent-1",
    parent_prompt_id: "prompt-A",
    spawned_by_user_id: 42,
    spawn_depth: 1,
    title: "Investigate X",
    status: "active",
    rich_status: null,
    publish_status: null,
    publish_error: null,
    created_at: "2026-04-27T00:00:00.000Z",
    closed_at: null,
  };

  it("returns running for active sessions without rich_status", () => {
    const summary = buildChildSessionSummary(row, "https://app.example.com/", null);
    expect(summary.status).toBe("running");
    expect(summary.childSessionUrl).toBe("https://app.example.com/sessions/child-1");
    expect(summary.prUrl).toBeNull();
    expect(summary.completedAt).toBeNull();
  });

  it("returns completed for archived sessions with closed_at", () => {
    const summary = buildChildSessionSummary(
      { ...row, status: "archived", closed_at: "2026-04-27T00:05:00.000Z" },
      "https://app.example.com",
      "https://github.com/acme/widget/pull/42",
    );
    expect(summary.status).toBe("completed");
    expect(summary.prUrl).toBe("https://github.com/acme/widget/pull/42");
    expect(summary.completedAt).toBeGreaterThan(0);
  });

  it("returns failed when rich_status reports failed", () => {
    const summary = buildChildSessionSummary(
      { ...row, rich_status: "failed", publish_status: "failed" },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("failed");
    // `rich_status` carries only the terminal phase string after the column
    // flip; the meaningful reason is sourced from publish_error / publish_status.
    expect(summary.failureReason).toBe("publish_failed");
  });

  it("surfaces publish_error verbatim as the failure reason when present", () => {
    const summary = buildChildSessionSummary(
      {
        ...row,
        rich_status: "failed",
        publish_status: "failed",
        publish_error: "git push rejected: non-fast-forward",
      },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("failed");
    expect(summary.failureReason).toBe("git push rejected: non-fast-forward");
  });

  it("maps phase=blocked to verification_failed (blocked wins over a failed publish_status)", () => {
    // `phase === "blocked"` (the FSM NEEDS_YOU projection) is classified before
    // the publish-phase classifier, so it wins even when publish_status is failed.
    const summary = buildChildSessionSummary(
      { ...row, rich_status: "blocked", publish_status: "failed" },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("failed");
    expect(summary.failureReason).toBe("verification_failed");
  });

  it("maps verification_failed off phase=blocked alone (publish_status absent)", () => {
    // rich_status === "blocked" without publish_status.
    const summary = buildChildSessionSummary(
      { ...row, rich_status: "blocked", publish_status: null },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("failed");
    expect(summary.failureReason).toBe("verification_failed");
  });

  it("falls back to session_failed when the session failed before publish was attempted", () => {
    // rich_status reached "failed" but publish_status never got past
    // not_started — calling this "publish_failed" would mislead retry logic.
    const summary = buildChildSessionSummary(
      { ...row, rich_status: "failed", publish_status: "not_started" },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("failed");
    expect(summary.failureReason).toBe("session_failed");
  });

  it("preserves publish_error whitespace verbatim when surfacing it as the reason", () => {
    // The persisted error is the source of truth — return the original value
    // unmodified rather than the trimmed form used to test for emptiness.
    const original = "  git push rejected: non-fast-forward\n";
    const summary = buildChildSessionSummary(
      { ...row, rich_status: "failed", publish_status: "failed", publish_error: original },
      "https://app.example.com",
      null,
    );
    expect(summary.failureReason).toBe(original);
  });

  it("returns canceled for archived sessions whose final phase is stopped", () => {
    const summary = buildChildSessionSummary(
      { ...row, status: "archived", rich_status: "stopped" },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("canceled");
  });

  it("returns canceled when an active row reports phase=stopped", () => {
    // Post-phase-flip the column carries phase strings — both user and
    // resumable stops project to `stopped` (stopMode lives on the DO).
    const summary = buildChildSessionSummary({ ...row, rich_status: "stopped" }, "https://app.example.com", null);
    expect(summary.status).toBe("canceled");
  });

  it("treats unknown / null phases on active rows as running (alive)", () => {
    // Phase-flip removed the legacy `queued` / `pending` vocabulary. Any
    // active row without a terminal phase is alive from the parent's view.
    const summary = buildChildSessionSummary({ ...row, rich_status: null }, "https://app.example.com", null);
    expect(summary.status).toBe("running");
  });

  it("returns completed for an active row whose phase is superseded (benign terminal)", () => {
    // `superseded` is the benign review-loop terminal (the PR/session moved on). It settles the
    // child as completed from the parent's view — NOT alive. Without the mapping it would fall
    // through to running and parent automation waiting on a terminal child status never converges.
    const summary = buildChildSessionSummary({ ...row, rich_status: "superseded" }, "https://app.example.com", null);
    expect(summary.status).toBe("completed");
  });

  it("treats phase=blocked as failed on active and archived rows", () => {
    // `blocked` is a canonical terminal phase (verification-failure) — from
    // the parent agent's perspective it surfaces as a failure outcome.
    const active = buildChildSessionSummary({ ...row, rich_status: "blocked" }, "https://app.example.com", null);
    expect(active.status).toBe("failed");
    const archived = buildChildSessionSummary(
      { ...row, status: "archived", rich_status: "blocked" },
      "https://app.example.com",
      null,
    );
    expect(archived.status).toBe("failed");
  });

  it("preserves canceled for legacy archived rows that persisted rich_status='canceled' pre-flip", () => {
    // Archived rows are permanent — they never receive a DO re-projection,
    // so legacy values must keep their original lifecycle mapping.
    const summary = buildChildSessionSummary(
      { ...row, status: "archived", rich_status: "canceled", closed_at: "2026-04-27T00:05:00.000Z" },
      "https://app.example.com",
      null,
    );
    expect(summary.status).toBe("canceled");
  });
});
