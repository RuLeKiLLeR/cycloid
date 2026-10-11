import { describe, expect, it, vi } from "vitest";

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

import {
  type CompletionRow,
  findCompletionsForSessionsPr,
  insertCompletion,
  updateCompletionDiff,
  updateCompletionDraftForPr,
  updateCompletionOutcomes,
  updateCompletionPrUrlForPrompt,
  updateCompletionPrUrlForSession,
} from "../../../apps/control-plane-worker/src/session/completions-db";

// Lightweight D1 mock that records prepared statements
type BoundStatement = {
  query: string;
  values: unknown[];
};

function createMockD1(options?: {
  allResults?: CompletionRow[];
  sessionBusinessIds?: Record<string, string>;
  userBusinessIds?: Record<string, string>;
}) {
  const statements: BoundStatement[] = [];
  const sessionBusinessIds = new Map(Object.entries(options?.sessionBusinessIds ?? {}));
  const userBusinessIds = new Map(Object.entries(options?.userBusinessIds ?? {}));
  const db = {
    prepare(query: string) {
      const stmt: BoundStatement = { query, values: [] };
      return {
        bind(...values: unknown[]) {
          stmt.values = values;
          statements.push(stmt);
          return this;
        },
        async run() {
          return { success: true };
        },
        async first<T>() {
          if (query.includes("FROM session_index")) {
            const [sessionId] = stmt.values as [string];
            const businessId = sessionBusinessIds.get(String(sessionId));
            return businessId ? ({ business_id: businessId } as T) : null;
          }
          if (query.includes("FROM users")) {
            const [ownerUserId] = stmt.values as [string];
            const businessId = userBusinessIds.get(String(ownerUserId));
            return businessId ? ({ business_id: businessId } as T) : null;
          }
          throw new Error(`Unhandled first query: ${query}`);
        },
        async all<T>() {
          return { results: (options?.allResults ?? []) as T[] };
        },
      };
    },
    async batch(batchStatements: Array<{ run: () => Promise<unknown> }>) {
      const results = [];
      for (const statement of batchStatements) {
        await statement.run();
        results.push({ success: true });
      }
      return results;
    },
    _statements: statements,
  };
  return db as unknown as D1Database & { _statements: BoundStatement[] };
}

function makeCompletionRow(overrides: Partial<CompletionRow> = {}): CompletionRow {
  return {
    id: "c-1",
    session_id: "s-1",
    prompt_id: "p-1",
    owner_user_id: "u-1",
    business_id: "biz-1",
    repo_owner: "acme",
    repo_name: "repo",
    prompt_text: "fix bug",
    title: "Bug fix",
    diff_summary: "Fixed the bug",
    intent_summary: null,
    branch: "main",
    commit_sha: "abc",
    pr_url: null,
    pr_draft: null,
    pr_outcome: null,
    pr_outcome_at: null,
    first_pass_passed: null,
    review_thread_count: null,
    followup_commit_count: null,
    ci_first_run_status: null,
    success: 1,
    completed_at: 1000,
    created_at: 1000,
    ...overrides,
  } as CompletionRow;
}

describe("completions-db", () => {
  describe("insertCompletion", () => {
    it("inserts with explicit conflict handling and truncates long text", async () => {
      const db = createMockD1();
      const longText = "x".repeat(3000);

      await insertCompletion(db, {
        sessionId: "s-1",
        promptId: "p-1",
        ownerUserId: "u-1",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        promptText: longText,
        title: "Test title",
        diffSummary: longText,
        branch: "main",
        commitSha: "abc123",
        success: true,
        completedAt: 1000,
      });

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("INSERT INTO");
      expect(stmt.query).toContain("session_completions");
      expect(stmt.query).toContain("ON CONFLICT(session_id, prompt_id) DO NOTHING");

      expect(stmt.values).toHaveLength(15);
      // promptText should be truncated to 2000
      expect((stmt.values[7] as string).length).toBe(2000);
      // diffSummary should be truncated to 2000
      expect((stmt.values[9] as string).length).toBe(2000);
      // intentSummary column remains present but new writes leave it null
      expect(stmt.values[10]).toBeNull();
      // success should be 1 (integer)
      expect(stmt.values[13]).toBe(1);
    });

    it("passes success=0 for failed completions", async () => {
      const db = createMockD1();

      await insertCompletion(db, {
        sessionId: "s-1",
        promptId: "p-1",
        ownerUserId: "u-1",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        promptText: "fix bug",
        title: null,
        diffSummary: null,
        branch: null,
        commitSha: null,
        success: false,
        completedAt: 1000,
      });

      const stmt = db._statements[0];
      expect(stmt.values[13]).toBe(0);
    });

    it("handles null title and diffSummary", async () => {
      const db = createMockD1();

      await insertCompletion(db, {
        sessionId: "s-1",
        promptId: "p-1",
        ownerUserId: "u-1",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "repo",
        promptText: "fix bug",
        title: null,
        diffSummary: null,
        branch: null,
        commitSha: null,
        success: true,
        completedAt: 1000,
      });

      const stmt = db._statements[0];
      expect(stmt.values[8]).toBeNull(); // title
      expect(stmt.values[9]).toBeNull(); // diffSummary
      expect(stmt.values[10]).toBeNull(); // intentSummary
    });

    it("falls back to the indexed session business id when the payload omits it", async () => {
      const db = createMockD1({ sessionBusinessIds: { "s-1": "biz-indexed" } });

      await insertCompletion(db, {
        sessionId: "s-1",
        promptId: "p-1",
        ownerUserId: "u-1",
        businessId: null,
        repoOwner: "acme",
        repoName: "repo",
        promptText: "fix bug",
        title: null,
        diffSummary: null,
        branch: null,
        commitSha: null,
        success: true,
        completedAt: 1000,
      });

      const insertStatement = db._statements.find((statement) =>
        statement.query.includes("INSERT INTO session_completions"),
      );
      expect(insertStatement?.values[4]).toBe("biz-indexed");
    });

    it("throws a named error when no completion business id can be resolved", async () => {
      const db = createMockD1();

      await expect(
        insertCompletion(db, {
          sessionId: "s-1",
          promptId: "p-1",
          ownerUserId: "u-1",
          businessId: null,
          repoOwner: "acme",
          repoName: "repo",
          promptText: "fix bug",
          title: null,
          diffSummary: null,
          branch: null,
          commitSha: null,
          success: true,
          completedAt: 1000,
        }),
      ).rejects.toMatchObject({
        name: "MissingBusinessIdError",
        message: expect.stringContaining("session_completions insert"),
      });
    });
  });

  describe("updateCompletionDiff", () => {
    it("updates diff fields with COALESCE", async () => {
      const db = createMockD1();

      await updateCompletionDiff(db, "s-1", "p-1", {
        diffSummary: "Added new function",
        branch: "feat/new",
        commitSha: "def456",
      });

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("UPDATE session_completions");
      expect(stmt.query).toContain("COALESCE");
      expect(stmt.values).toEqual(["Added new function", "feat/new", "def456", "s-1", "p-1"]);
    });

    it("truncates long diffSummary", async () => {
      const db = createMockD1();
      const longDiff = "y".repeat(3000);

      await updateCompletionDiff(db, "s-1", "p-1", {
        diffSummary: longDiff,
        branch: null,
        commitSha: null,
      });

      const stmt = db._statements[0];
      expect((stmt.values[0] as string).length).toBe(2000);
      expect(stmt.values[1]).toBeNull();
    });
  });

  describe("updateCompletionPrUrlForPrompt", () => {
    it("scopes the pr_url/draft write to (session_id, prompt_id)", async () => {
      const db = createMockD1();

      await updateCompletionPrUrlForPrompt(db, "s-1", "p-2", "https://github.com/acme/repo/pull/1", true);

      const stmt = db._statements[0];
      expect(stmt.query).toContain("SET pr_url = ?, pr_draft = ?");
      expect(stmt.query).toContain("WHERE session_id = ? AND prompt_id = ?");
      expect(stmt.values).toEqual(["https://github.com/acme/repo/pull/1", 1, "s-1", "p-2"]);
    });
  });

  describe("updateCompletionPrUrlForSession", () => {
    it("falls back to a session-wide write when no prompt id is available", async () => {
      const db = createMockD1();

      await updateCompletionPrUrlForSession(db, "s-1", "https://github.com/acme/repo/pull/2", false);

      const stmt = db._statements[0];
      expect(stmt.query).toContain("WHERE session_id = ?");
      expect(stmt.query).not.toContain("prompt_id");
      expect(stmt.values).toEqual(["https://github.com/acme/repo/pull/2", 0, "s-1"]);
    });
  });

  describe("updateCompletionDraftForPr", () => {
    it("toggles only pr_draft scoped by (session_id, pr_url), never rewriting pr_url", async () => {
      const db = createMockD1();

      await updateCompletionDraftForPr(db, "s-1", "https://github.com/acme/repo/pull/3", true);

      const stmt = db._statements[0];
      expect(stmt.query).toContain("SET pr_draft = ?");
      expect(stmt.query).not.toContain("SET pr_url");
      expect(stmt.query).toContain("WHERE session_id = ? AND pr_url = ?");
      expect(stmt.values).toEqual([1, "s-1", "https://github.com/acme/repo/pull/3"]);
    });
  });

  describe("updateCompletionOutcomes", () => {
    it("updates outcome fields in a batch", async () => {
      const db = createMockD1();

      await updateCompletionOutcomes(db, [
        {
          sessionId: "s-1",
          promptId: "p-1",
          prOutcome: "merged",
          prOutcomeAt: 1234,
          firstPassPassed: true,
          reviewThreadCount: 0,
          followupCommitCount: 0,
          ciFirstRunStatus: "success",
        },
      ]);

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("UPDATE session_completions");
      expect(stmt.query).toContain("pr_outcome = ?");
      expect(stmt.values).toEqual(["merged", 1234, 1, 0, 0, "success", "s-1", "p-1"]);
    });

    it("maps false and nullable outcome values correctly", async () => {
      const db = createMockD1();

      await updateCompletionOutcomes(db, [
        {
          sessionId: "s-1",
          promptId: "p-2",
          prOutcome: "closed",
          prOutcomeAt: 2222,
          firstPassPassed: false,
          reviewThreadCount: null,
          followupCommitCount: null,
          ciFirstRunStatus: "unknown",
        },
      ]);

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("UPDATE session_completions");
      expect(stmt.values).toEqual(["closed", 2222, 0, null, null, "unknown", "s-1", "p-2"]);
    });

    it("skips empty outcome batches", async () => {
      const db = createMockD1();

      await updateCompletionOutcomes(db, []);

      expect(db._statements).toHaveLength(0);
    });
  });

  describe("findCompletionsForSessionsPr", () => {
    it("filters by exact pr_url, session set, and success = 1", async () => {
      const rows = [makeCompletionRow({ pr_url: "https://github.com/acme/repo/pull/1" })];
      const db = createMockD1({ allResults: rows });

      const results = await findCompletionsForSessionsPr(db, ["s-1", "s-2"], "https://github.com/acme/repo/pull/1");

      expect(results).toEqual(rows);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("session_id IN (?, ?)");
      expect(stmt.query).toContain("pr_url = ?");
      expect(stmt.query).toContain("success = 1");
      expect(stmt.values).toEqual(["s-1", "s-2", "https://github.com/acme/repo/pull/1"]);
    });

    it("returns empty without querying when no sessionIds are given", async () => {
      const db = createMockD1();

      const results = await findCompletionsForSessionsPr(db, [], "https://github.com/acme/repo/pull/1");

      expect(results).toEqual([]);
      expect(db._statements).toHaveLength(0);
    });
  });
});
