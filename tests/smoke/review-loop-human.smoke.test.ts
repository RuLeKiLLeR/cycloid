/**
 * Smoke test: human PR review on archived session is acknowledged without
 * reengaging the terminal archived session.
 *
 * External boundaries mocked (at the test boundary):
 *   - GitHub API (global fetch)
 *   - E2B sandbox (vi.mock of e2b-client, same as all smoke tests)
 *   - Installation token (vi.mock of octokit, same as all smoke tests)
 *
 * NOT mocked (all run real code):
 *   - reengageSessionForReview
 *   - ensureSessionLiveForPr terminal archived-session gate
 *   - runReviewLoopSweep no-op behavior when no epoch is created
 *
 * FakeD1 limitation: the smoke harness FakeD1 has no epoch table support.
 * Resolution: SmokeHybridD1 wraps FakeD1 (for sessions/users/webhooks) +
 * better-sqlite3 (for pr_review_response_epochs + user_pr_review_bot_settings).
 * The reconcile sub-path (listReviewListeningGithubPrRefs join) is excluded
 * because it requires a session_index JOIN that FakeD1 cannot execute —
 * the test focuses on the listDueReviewLoopEpochs + processEpoch path.
 */

import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_smoke_token",
  createScopedInstallationToken: async () => "ghs_smoke_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("../../apps/control-plane-worker/src/slack/notify", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/slack/notify")>(
    "../../apps/control-plane-worker/src/slack/notify",
  );
  return {
    ...actual,
    getSlackBotUserId: vi.fn().mockResolvedValue("UARCA"),
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createGithubSignature, createWorkerEnv, type FakeD1, workerFetch, type WorkerModule } from "./helpers";

// ---------------------------------------------------------------------------
// SQLite D1 adapter (mirrors the pattern used in review-loop-reengage.test.ts)
// ---------------------------------------------------------------------------

class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(this)) as this, this);
    (clone as this & { boundValues: unknown[] }).boundValues = [...values];
    return clone;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    // Schema queries: run as-is (they are idempotent CREATE IF NOT EXISTS)
    const isSchema =
      this.query.includes("CREATE TABLE IF NOT EXISTS") ||
      this.query.includes("CREATE INDEX IF NOT EXISTS") ||
      this.query.includes("CREATE UNIQUE INDEX IF NOT EXISTS");
    if (isSchema) {
      this.db.exec(this.query);
      return { success: true, meta: { changes: 0 } };
    }
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

// ---------------------------------------------------------------------------
// HybridD1: epoch + bot-settings → SQLite, everything else → FakeD1
// ---------------------------------------------------------------------------

/**
 * Routes queries to the right backend:
 * - `pr_review_response_epochs`: SQLite (real schema + real data)
 * - `user_pr_review_bot_settings`: SQLite (seed via seedBotSettings)
 * - session_webhook_refs JOIN query (listReviewListeningGithubPrRefs):
 *     returns empty — this test focuses on the processEpoch sweep path,
 *     not the reconcileReviewListeningSessions path.
 * - everything else: FakeD1
 */
class HybridD1Statement {
  constructor(
    private readonly fakeDb: FakeD1,
    private readonly sqlite: SqliteD1,
    private readonly query: string,
    private readonly boundValues: unknown[] = [],
  ) {}

  bind(...values: unknown[]): this {
    return new HybridD1Statement(this.fakeDb, this.sqlite, this.query, [...values]) as unknown as this;
  }

  private isSqliteQuery(): boolean {
    return (
      this.query.includes("pr_review_response_epochs") ||
      // Self-reply fence (PR #7119): the human-epoch sweep reads pr_review_response_operations to drop
      // Cycloid's own replies from the worklist; that table is loaded into SQLite (migration 0117).
      this.query.includes("pr_review_response_operations") ||
      this.query.includes("user_pr_review_bot_settings")
    );
  }

  private isReviewListeningJoinQuery(): boolean {
    // listReviewListeningGithubPrRefs uses a JOIN between session_index and session_webhook_refs.
    // FakeD1 cannot execute JOINs; return empty so reconcileReviewListeningSessions is a no-op.
    return (
      this.query.includes("FROM session_index") &&
      this.query.includes("session_webhook_refs") &&
      this.query.includes("rich_status = 'review_listening'")
    );
  }

  private delegate(): {
    first(): Promise<unknown>;
    all(): Promise<{ results: unknown[] }>;
    run(): Promise<{ success: true; meta: { changes: number } }>;
  } {
    if (this.isSqliteQuery()) {
      const stmt = this.sqlite.prepare(this.query);
      return stmt.bind(...this.boundValues) as unknown as ReturnType<typeof this.delegate>;
    }
    const stmt = this.fakeDb.prepare(this.query);
    return stmt.bind(...this.boundValues) as unknown as ReturnType<typeof this.delegate>;
  }

  async first<T>(): Promise<T | null> {
    return (await this.delegate().first()) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.isReviewListeningJoinQuery()) {
      return { results: [] };
    }
    return (await this.delegate().all()) as { results: T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.delegate().run();
  }
}

class HybridD1 {
  constructor(
    private readonly fakeDb: FakeD1,
    private readonly sqlite: SqliteD1,
  ) {}

  prepare(query: string): HybridD1Statement {
    return new HybridD1Statement(this.fakeDb, this.sqlite, query);
  }

  // Forward batch to FakeD1 (only used for schema-init, not for epoch queries)
  async batch(statements: HybridD1Statement[]): Promise<Array<{ results: Array<Record<string, unknown>> }>> {
    // Batch is only used by FakeD1 for idempotency checking — forward to fakeDb
    return this.fakeDb.batch(
      statements.map((s) =>
        this.fakeDb
          .prepare((s as unknown as { query: string }).query)
          .bind(...(s as unknown as { boundValues: unknown[] }).boundValues),
      ) as never,
    );
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const PR_URL = "https://github.com/acme/review-loop-repo/pull/88";
const REPO_OWNER = "acme";
const REPO_NAME = "review-loop-repo";
const PR_NUMBER = 88;
const REVIEW_ID = 9999;
const HEAD_SHA = "deadbeef01deadbeef01deadbeef0102deadbeef";
const SESSION_ID = "s-human-review-loop";

describe("smoke: human review on archived session stays terminal", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  it("webhook dispatch → reengage → epoch created → sweep enqueues prompt with sourceKind=human", async () => {
    // ---- 1. Boot environment ----
    // Seed the installation for "review-loop-repo" owner "acme" — already done by
    // createWorkerEnv which seeds "acme" with installationId=2.
    const { env: rawEnv, db: fakeDb } = createWorkerEnv(workerModule);

    // Build SQLite for epoch + bot-settings tables
    const sqliteDb = new Database(":memory:");
    sqliteDb.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    sqliteDb.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
    sqliteDb.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
    sqliteDb.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
    sqliteDb.exec(
      readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"),
    );
    sqliteDb.exec(readFileSync("apps/control-plane-worker/migrations/0166_review_loop_carried_forward.sql", "utf8"));
    sqliteDb.exec(
      readFileSync("apps/control-plane-worker/migrations/0202_review_loop_carry_forward_no_progress_count.sql", "utf8"),
    );
    const sqliteD1 = new SqliteD1(sqliteDb);
    const hybridDb = new HybridD1(fakeDb, sqliteD1);

    // Replace env.DB with HybridD1. Manual verification policy keeps this smoke focused on the
    // reengage -> sweep -> enqueue mechanics.
    const env = { ...rawEnv, DB: hybridDb, VERIFICATION_POLICY: "manual" } as Record<string, unknown>;

    // ---- 2. Seed the review-loop user ----
    // createWorkerEnv seeds installation for "acme" (id=2) and adds owner "test-owner" (id=1).
    // We need a user whose session we will use.
    const userId = fakeDb.addUser(7001, "review-loop-user");
    // ARC-1514: opt into automatic review handling so the human-review ingest/re-engage path is exercised.
    // (Manual mode — the default — deliberately drops human reviews; that is covered by unit tests.)
    fakeDb.setUserSettings(userId, { automatic_reviews_enabled: 1 });
    // Seed bot settings in SQLite so resolveReviewLoopChecklist can find them
    sqliteDb.exec(`
        INSERT INTO user_pr_review_bot_settings
          (user_id, repo_owner, repo_name, expected_bots_json, created_at, updated_at)
        VALUES
          (${userId}, 'acme', 'review-loop-repo',
           '[{"type":"known","id":"cursor-bugbot"}]',
           ${Date.now()}, ${Date.now()})
      `);

    // ---- 3. Create a session with the PR URL ----
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        ownerUserId: String(userId),
        repoUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
        githubPrUrl: PR_URL,
      }),
    });
    expect(createRes.status, "session creation should succeed").toBe(201);

    // ---- 4. Archive the session (simulate the bot loop finishing) ----
    // Send a pull_request:closed webhook for this PR so the session gets archived
    const archiveBody = JSON.stringify({
      action: "closed",
      pull_request: { html_url: PR_URL },
    });
    const archiveSignature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), archiveBody);
    const archiveRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": archiveSignature,
        "x-github-delivery": "delivery-archive-88",
        "x-github-event": "pull_request",
      },
      body: archiveBody,
    });
    expect(archiveRes.status).toBe(200);
    const archivePayload = (await archiveRes.json()) as { ok: boolean; archived: number };
    expect(archivePayload.archived).toBe(1);

    // Confirm the session is now archived
    const preReviewSessionRes = await workerFetch(workerModule, env, `/api/sessions/${SESSION_ID}`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    const preReviewBody = (await preReviewSessionRes.json()) as { session: { status: string } };
    expect(preReviewBody.session.status).toBe("archived");

    // ---- 5. Install GitHub API fetch mocks ----
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

      // PR state + head SHA — used by getPrState and getPrHeadSha
      if (url === `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`) {
        return new Response(JSON.stringify({ state: "open", merged: false, head: { sha: HEAD_SHA } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // PR review comments — used by getPrReviewComments (empty-approval check + sweep worklist)
      if (url.startsWith(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/comments`)) {
        return new Response(
          JSON.stringify([
            {
              id: 5001,
              pull_request_review_id: REVIEW_ID,
              path: "src/main.ts",
              line: 10,
              body: "Please fix the null guard here.",
              user: { login: "reviewer" },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // GraphQL — used by getPrReviewLoopWorklist (fetchReviewLoopReviewThreadItems)
      if (url === "https://api.github.com/graphql") {
        const graphqlResponse = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: "src/main.ts",
                      line: 10,
                      comments: {
                        nodes: [
                          {
                            databaseId: 5001,
                            body: "Please fix the null guard here.",
                            url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}#discussion_r5001`,
                            updatedAt: "2025-05-28T10:00:00Z",
                            author: { login: "reviewer", __typename: "User" },
                            pullRequestReview: {
                              databaseId: REVIEW_ID,
                              author: { login: "reviewer", __typename: "User" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        };
        return new Response(JSON.stringify(graphqlResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Issue comments for the PR — used by fetchReviewLoopIssueCommentItems
      if (url.startsWith(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments`)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // PR reviews — used by fetchReviewLoopHumanReviewBodyItems (human/mixed epochs)
      if (url.startsWith(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/reviews`)) {
        return new Response(
          JSON.stringify([
            {
              id: REVIEW_ID,
              body: "Please address the null guard issue before merge.",
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer", type: "User" },
              html_url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}#pullrequestreview-${REVIEW_ID}`,
              submitted_at: "2025-05-28T10:00:00Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Check runs + commit statuses — used by backfillReviewLoopTerminalSignals
      if (
        url.includes(`/repos/${REPO_OWNER}/${REPO_NAME}/commits/${HEAD_SHA}/check-runs`) ||
        url.includes(`/repos/${REPO_OWNER}/${REPO_NAME}/commits/${HEAD_SHA}/statuses`)
      ) {
        return new Response(JSON.stringify({ check_runs: [], statuses: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Fall through to the smoke-test harness mock (handles openai, other github calls)
      return previousFetch(input as RequestInfo, init);
    };

    try {
      // ---- 6. Dispatch human PR review webhook ----
      const reviewBody = JSON.stringify({
        action: "submitted",
        installation: { id: 2 },
        repository: {
          name: REPO_NAME,
          html_url: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
          owner: { login: REPO_OWNER },
        },
        pull_request: {
          number: PR_NUMBER,
          html_url: PR_URL,
          head: { sha: HEAD_SHA },
        },
        review: {
          id: REVIEW_ID,
          state: "changes_requested",
          body: "Please address the null guard issue before merge.",
          commit_id: HEAD_SHA,
          user: {
            id: 7002,
            login: "reviewer",
            type: "User",
          },
        },
      });
      const reviewSignature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), reviewBody);

      const reviewRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": reviewSignature,
          "x-github-delivery": "delivery-human-review-88",
          "x-github-event": "pull_request_review",
          // Enable the human loop flag via env override at the env level (set below)
        },
        body: reviewBody,
      });

      expect(reviewRes.status, "webhook dispatch must return 200").toBe(200);
      const reviewPayload = (await reviewRes.json()) as Record<string, unknown>;
      expect(reviewPayload.ok, "webhook response must be ok").toBe(true);
      expect(reviewPayload.reengaged, "archived session must not be reengaged").toBe(0);
      expect(reviewPayload.session_archived, "webhook must report the terminal archived session").toBe(1);

      // ---- 7. Verify session remains archived and does not enter review-listening ----
      const postReviewSessionRes = await workerFetch(workerModule, env, `/api/sessions/${SESSION_ID}`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(postReviewSessionRes.status).toBe(200);
      const postReviewBody = (await postReviewSessionRes.json()) as {
        session: {
          status: string;
          reviewListeningActive?: boolean;
        };
      };
      expect(postReviewBody.session.status, "public session status must remain archived").toBe("archived");
      expect(postReviewBody.session.reviewListeningActive, "archived session must not be review-listening").toBe(false);

      // ---- 8. Verify no human epoch was created for the terminal archived session ----
      const epochCountRow = sqliteDb
        .prepare(
          `SELECT COUNT(*) AS count
             FROM pr_review_response_epochs
             WHERE session_id = ? AND source_kind = 'human'
          `,
        )
        .get(SESSION_ID) as { count: number } | undefined;

      expect(epochCountRow?.count, "archived review must not create a human epoch").toBe(0);

      // ---- 9. Run the sweep once ----
      const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
      const sweepResult = await runReviewLoopSweep(env as never, { nowMs: Date.now() });

      expect(sweepResult.enqueued, "sweep must not enqueue prompts without a human epoch").toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }, 30_000);
});
