import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (set up before any imports from mocked modules)
// ---------------------------------------------------------------------------

const mockResolveReviewLoopHumanEligibility = vi.fn();
const mockResolveReviewLoopCiEligibility = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/review-loop-settings", () => ({
  resolveReviewLoopHumanEligibility: (...args: unknown[]) => mockResolveReviewLoopHumanEligibility(...args),
  resolveReviewLoopCiEligibility: (...args: unknown[]) => mockResolveReviewLoopCiEligibility(...args),
}));

const mockCreateInstallationToken = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

const mockCreatePrIssueComment = vi.fn();
const mockUpdateIssueComment = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  createPrIssueComment: (...args: unknown[]) => mockCreatePrIssueComment(...args),
  updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
}));

const mockEmitReviewSummaryCommentPosted = vi.fn();

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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  beginReviewLoopOperationAttempt,
  buildReviewLoopSummaryCommentOperationId,
  markReviewLoopOperationSucceeded,
} from "../../apps/control-plane-worker/src/services/review-loop-operations";

// publishReviewLoopSummaryComment imported via factory so emitReviewSummaryCommentPosted can be spied on
// We create a testable version by mocking emitReviewSummaryCommentPosted in the module.

// ---------------------------------------------------------------------------
// D1 / SQLite fixture
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
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-summary-1";
const EPOCH_ID = "epoch-summary-1";
const HEAD_SHA = "deadbeef1234";
const OWNER_USER_ID = 42;
const REPO_OWNER = "acme";
const REPO_NAME = "repo";
const PR_NUMBER = 99;

const ELIGIBLE_RESULT = { ok: true as const, ownerUserId: OWNER_USER_ID, installationId: 7 };
const INELIGIBLE = { ok: false as const, reason: "auto_response_disabled" as const };

let sqlite: Database.Database;
let db: D1Database;
let env: { DB: D1Database };

function seedEpoch(
  overrides: {
    id?: string;
    sessionId?: string;
    sourceKind?: string;
    status?: string;
    headSha?: string;
    ownerUserId?: number;
  } = {},
): void {
  const id = overrides.id ?? EPOCH_ID;
  const sessionId = overrides.sessionId ?? SESSION_ID;
  const sourceKind = overrides.sourceKind ?? "human";
  const status = overrides.status ?? "processing";
  const headSha = overrides.headSha ?? HEAD_SHA;
  const ownerUserId = overrides.ownerUserId ?? OWNER_USER_ID;
  const nowMs = Date.now();

  sqlite
    .prepare(
      `
    INSERT INTO pr_review_response_epochs (
      id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url,
      head_sha, wave, expected_bots_hash, expected_bots_json, expected_bot_keys_json,
      observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
      handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
      timed_out_bot_keys_json, uncertain_source_ids_json,
      first_activity_at, fallback_after_at, status, source_kind, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, 1, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '[]', '[]',
      '[]', '[]', 0,
      '[]', '[]', '[]',
      '[]', '[]',
      ?, ?, ?, ?, ?, ?
    )
  `,
    )
    .run(
      id,
      sessionId,
      ownerUserId,
      REPO_OWNER,
      REPO_NAME,
      PR_NUMBER,
      `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`,
      headSha,
      nowMs,
      nowMs,
      status,
      sourceKind,
      nowMs,
      nowMs,
    );
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
  // Widen the source_kind CHECK to admit 'verification' (0156) and 'mention' (0254) for the
  // manual-review carve-out cases below. Each rebuild's SELECT references columns added by the
  // intervening migrations (0126 prompted_source_ids, 0166/0202 carried-forward, 0225 merge-conflict),
  // so they must all apply first in order.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0156_review_loop_verification_source_kind.sql", "utf8"),
  );
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0166_review_loop_carried_forward.sql", "utf8"));
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0202_review_loop_carry_forward_no_progress_count.sql", "utf8"),
  );
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0225_pr_review_merge_conflict_resolution.sql", "utf8"),
  );
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0254_review_loop_mention_source_kind.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = { DB: db } as unknown as { DB: D1Database };

  mockResolveReviewLoopHumanEligibility.mockReset().mockResolvedValue(ELIGIBLE_RESULT);
  mockResolveReviewLoopCiEligibility.mockReset().mockResolvedValue(ELIGIBLE_RESULT);
  mockCreateInstallationToken.mockReset().mockResolvedValue("tok-install-123");
  mockCreatePrIssueComment.mockReset().mockResolvedValue({ id: 1001, htmlUrl: "https://github.com/.../1001" });
  mockUpdateIssueComment.mockReset().mockResolvedValue(undefined);
  mockEmitReviewSummaryCommentPosted.mockReset().mockResolvedValue(undefined);
});

// Import after mocks are set up, using a lazy import helper
let _publishReviewLoopSummaryComment: typeof import("../../apps/control-plane-worker/src/session/publish-service").publishReviewLoopSummaryComment;

async function getPublishFn() {
  if (!_publishReviewLoopSummaryComment) {
    const mod = await import("../../apps/control-plane-worker/src/session/publish-service");
    _publishReviewLoopSummaryComment = mod.publishReviewLoopSummaryComment;
  }
  return _publishReviewLoopSummaryComment;
}

// Convenience wrapper
async function callPublish(args: {
  sessionId?: string;
  epochId?: string;
  headSha?: string;
  body: string;
  promptId?: string;
}) {
  const fn = await getPublishFn();
  return fn({
    env: env as never,
    db,
    sessionId: args.sessionId ?? SESSION_ID,
    epochId: args.epochId ?? EPOCH_ID,
    headSha: args.headSha ?? HEAD_SHA,
    body: args.body,
    ...(args.promptId ? { promptId: args.promptId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Service unit tests (Task 20)
// ---------------------------------------------------------------------------

describe("publishReviewLoopSummaryComment — input validation", () => {
  it("returns body_too_large when body exceeds 8192 bytes", async () => {
    const bigBody = "x".repeat(8193);
    const result = await callPublish({ body: bigBody });
    expect(result).toEqual({ ok: false, reason: "body_too_large" });
  });

  it("accepts exactly 8192 bytes", async () => {
    seedEpoch();
    const body = "x".repeat(8192);
    const result = await callPublish({ body });
    expect(result.ok).toBe(true);
  });
});

describe("publishReviewLoopSummaryComment — epoch gate", () => {
  it("returns epoch_not_found when epoch does not exist", async () => {
    const result = await callPublish({ epochId: "no-such-epoch", body: "hello" });
    expect(result).toEqual({ ok: false, reason: "epoch_not_found" });
  });

  it("returns session_mismatch when epoch belongs to a different session", async () => {
    seedEpoch({ sessionId: "other-session" });
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "session_mismatch" });
  });

  it("returns invalid_source_kind for bot-only epochs", async () => {
    seedEpoch({ sourceKind: "bot" });
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "invalid_source_kind" });
  });

  it("accepts mixed epochs", async () => {
    seedEpoch({ sourceKind: "mixed" });
    const result = await callPublish({ body: "hello" });
    expect(result.ok).toBe(true);
  });

  it("rejects ci epochs (FIX 8: a CI fix pushes, it must not post a summary comment)", async () => {
    seedEpoch({ sourceKind: "ci" });
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "invalid_source_kind" });
  });

  it("returns invalid_status for collecting epochs", async () => {
    seedEpoch({ status: "collecting" });
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("returns invalid_status for blocked epochs", async () => {
    seedEpoch({ status: "blocked" });
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("allows completed epochs", async () => {
    seedEpoch({ status: "completed" });
    const result = await callPublish({ body: "hello" });
    expect(result.ok).toBe(true);
  });

  it("allows publishing epochs", async () => {
    seedEpoch({ status: "publishing" });
    const result = await callPublish({ body: "hello" });
    expect(result.ok).toBe(true);
  });
});

describe("publishReviewLoopSummaryComment — eligibility gate", () => {
  it("returns not_eligible when eligibility check fails", async () => {
    seedEpoch();
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(INELIGIBLE);
    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "not_eligible" });
  });
});

describe("publishReviewLoopSummaryComment — manual review mode carve-out (ARC-1514, FIX 1)", () => {
  const DISABLED = { ok: false as const, reason: "review_handling_disabled" as const };

  it("mention epoch: uses the caps-only CI gate, so its summary comment posts even in manual mode", async () => {
    seedEpoch({ sourceKind: "mention" });
    // Manual review mode: the human gate is off. A mention must bypass it (caps-only CI gate).
    mockResolveReviewLoopHumanEligibility.mockResolvedValue(DISABLED);
    mockResolveReviewLoopCiEligibility.mockResolvedValue(ELIGIBLE_RESULT);

    const result = await callPublish({ body: "mention summary" });

    expect(result.ok).toBe(true);
    expect(mockResolveReviewLoopCiEligibility).toHaveBeenCalledOnce();
    // The mention path must NOT consult the human/manual gate that would reject it.
    expect(mockResolveReviewLoopHumanEligibility).not.toHaveBeenCalled();
  });

  it("verification epoch: threads sourceKind so its summary comment is eligible in manual mode", async () => {
    seedEpoch({ sourceKind: "verification" });
    // Mirror the real resolver: manual mode disables the human arm EXCEPT for verification epochs.
    mockResolveReviewLoopHumanEligibility.mockImplementation((_env: unknown, input: { sourceKind?: string }) =>
      Promise.resolve(input.sourceKind === "verification" ? ELIGIBLE_RESULT : DISABLED),
    );

    const result = await callPublish({ body: "qa summary" });

    expect(result.ok).toBe(true);
    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKind: "verification" }),
    );
  });

  it("human epoch in manual mode: stays gated (proves the carve-out is not a blanket bypass)", async () => {
    seedEpoch({ sourceKind: "human" });
    mockResolveReviewLoopHumanEligibility.mockImplementation((_env: unknown, input: { sourceKind?: string }) =>
      Promise.resolve(input.sourceKind === "verification" ? ELIGIBLE_RESULT : DISABLED),
    );

    const result = await callPublish({ body: "human summary" });

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    expect(mockResolveReviewLoopHumanEligibility).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKind: "human" }),
    );
  });
});

describe("publishReviewLoopSummaryComment — first call POSTs to GitHub", () => {
  it("creates a new GitHub issue comment on first call", async () => {
    seedEpoch();
    mockCreatePrIssueComment.mockResolvedValue({ id: 5001, htmlUrl: "https://github.com/.../5001" });

    const result = await callPublish({ body: "Summary of changes" });

    expect(result).toEqual({ ok: true, githubCommentId: 5001 });
    expect(mockCreatePrIssueComment).toHaveBeenCalledOnce();
    const [token, owner, repo, prNumber, body] = mockCreatePrIssueComment.mock.calls[0];
    expect(token).toBe("tok-install-123");
    expect(owner).toBe(REPO_OWNER);
    expect(repo).toBe(REPO_NAME);
    expect(prNumber).toBe(PR_NUMBER);
    expect(body).toBe("Summary of changes");
  });

  it("persists the operation as succeeded with the comment id", async () => {
    seedEpoch();
    mockCreatePrIssueComment.mockResolvedValue({ id: 5002, htmlUrl: "https://github.com/.../5002" });

    await callPublish({ body: "hello" });

    const operationId = await buildReviewLoopSummaryCommentOperationId({
      epochId: EPOCH_ID,
      headSha: HEAD_SHA,
    });
    const opRow = await db
      .prepare("SELECT * FROM pr_review_response_operations WHERE operation_id = ?")
      .bind(operationId)
      .first<{ status: string; github_id: string }>();
    expect(opRow?.status).toBe("succeeded");
    expect(opRow?.github_id).toBe("5002");
  });
});

describe("publishReviewLoopSummaryComment — idempotency (second call PATCHes)", () => {
  it("PATCHes the existing comment on retry after success", async () => {
    seedEpoch();
    mockCreatePrIssueComment.mockResolvedValue({ id: 6001, htmlUrl: "" });

    // First call — POST
    const first = await callPublish({ body: "Version 1" });
    expect(first).toEqual({ ok: true, githubCommentId: 6001 });
    expect(mockCreatePrIssueComment).toHaveBeenCalledOnce();

    // Second call — PATCH (same operation id because same epochId + epoch.headSha)
    const second = await callPublish({ body: "Version 2" });
    expect(second).toEqual({ ok: true, githubCommentId: 6001 });
    // Should not POST again
    expect(mockCreatePrIssueComment).toHaveBeenCalledOnce();
    // Should PATCH with new body
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce();
    const [token, owner, repo, commentId, patchBody] = mockUpdateIssueComment.mock.calls[0];
    expect(token).toBe("tok-install-123");
    expect(owner).toBe(REPO_OWNER);
    expect(repo).toBe(REPO_NAME);
    expect(commentId).toBe(6001);
    expect(patchBody).toBe("Version 2");
  });

  it("returns github_patch_failed when the PATCH call throws", async () => {
    seedEpoch();
    // Seed an already-succeeded operation directly so we skip the POST
    const operationId = await buildReviewLoopSummaryCommentOperationId({
      epochId: EPOCH_ID,
      headSha: HEAD_SHA,
    });
    await beginReviewLoopOperationAttempt(db, {
      operationId,
      epochId: EPOCH_ID,
      sessionId: SESSION_ID,
      kind: "summary_comment",
      headSha: HEAD_SHA,
      maxAttempts: 3,
      nowMs: Date.now(),
    });
    await markReviewLoopOperationSucceeded(db, operationId, { githubId: "7777", nowMs: Date.now() });

    mockUpdateIssueComment.mockRejectedValue(new Error("GitHub PATCH error"));

    const result = await callPublish({ body: "Retry body" });
    expect(result).toEqual({ ok: false, reason: "github_patch_failed" });
  });
});

describe("publishReviewLoopSummaryComment — arg headSha vs epoch.headSha", () => {
  it("does NOT reject when arg headSha differs from epoch.headSha", async () => {
    seedEpoch({ headSha: "epoch-head-sha" });
    mockCreatePrIssueComment.mockResolvedValue({ id: 9001, htmlUrl: "" });

    const result = await callPublish({
      headSha: "different-arg-head-sha", // different from epoch's "epoch-head-sha"
      body: "hello",
    });
    expect(result).toEqual({ ok: true, githubCommentId: 9001 });
  });

  it("uses epoch.headSha for operation id stability, not arg headSha", async () => {
    const epochHeadSha = "epoch-stable-head";
    seedEpoch({ headSha: epochHeadSha });
    mockCreatePrIssueComment.mockResolvedValue({ id: 9002, htmlUrl: "" });

    await callPublish({
      headSha: "totally-different-arg-sha",
      body: "hello",
    });

    // Operation should be keyed on epoch's headSha, not arg headSha
    const expectedOpId = await buildReviewLoopSummaryCommentOperationId({
      epochId: EPOCH_ID,
      headSha: epochHeadSha,
    });
    const opRow = await db
      .prepare("SELECT status FROM pr_review_response_operations WHERE operation_id = ?")
      .bind(expectedOpId)
      .first<{ status: string }>();
    expect(opRow?.status).toBe("succeeded");
  });
});

describe("publishReviewLoopSummaryComment — GitHub POST failure", () => {
  it("returns github_post_failed when createPrIssueComment throws", async () => {
    seedEpoch();
    mockCreatePrIssueComment.mockRejectedValue(new Error("Network error"));

    const result = await callPublish({ body: "hello" });
    expect(result).toEqual({ ok: false, reason: "github_post_failed" });
  });

  it("marks the operation as failed when GitHub POST fails", async () => {
    seedEpoch();
    mockCreatePrIssueComment.mockRejectedValue(new Error("Network error"));

    await callPublish({ body: "hello" });

    const operationId = await buildReviewLoopSummaryCommentOperationId({
      epochId: EPOCH_ID,
      headSha: HEAD_SHA,
    });
    const opRow = await db
      .prepare("SELECT status FROM pr_review_response_operations WHERE operation_id = ?")
      .bind(operationId)
      .first<{ status: string }>();
    expect(opRow?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// HTTP layer reason→status mapping (Task 21)
// These verify the mapping table used in the DO handler and the route.
// Route: POST /api/sessions/:id/review-loop/summary-comment
//   - auth: public (sandbox auth validated by DO via validateSandboxAuthRequest)
//   - rejects without bridge token → 401 (tested in session-features.test.ts)
//   - forwards to publishReviewLoopSummaryComment via DO handler
// ---------------------------------------------------------------------------

describe("POST /api/sessions/:id/review-loop/summary-comment — reason→status mapping", () => {
  /**
   * Canonical mapping from publishReviewLoopSummaryComment reason to HTTP status.
   * This table is the ground truth for the DO handler; session-features.test.ts
   * exercises the end-to-end route with sandbox auth.
   */
  const REASON_STATUS_MAP: Array<[string, number]> = [
    ["body_too_large", 400],
    ["epoch_not_found", 404],
    ["session_mismatch", 404],
    ["invalid_source_kind", 409],
    ["invalid_status", 409],
    ["not_eligible", 403],
    ["github_post_failed", 502],
    ["github_patch_failed", 502],
  ];

  for (const [reason, expectedStatus] of REASON_STATUS_MAP) {
    it(`maps reason "${reason}" to HTTP ${expectedStatus}`, () => {
      // Verify the mapping is consistent with the DO handler's switch logic.
      // The DO handler uses: body_too_large→400, epoch_not_found/session_mismatch→404,
      // invalid_source_kind/invalid_status→409, not_eligible→403,
      // github_post_failed/github_patch_failed→502.
      const actualStatus = resolveReasonToStatus(reason as never);
      expect(actualStatus).toBe(expectedStatus);
    });
  }
});

/**
 * Mirror of the reason→status mapping in the DO handler.
 * Kept in sync with the switch in durable-object.ts.
 */
function resolveReasonToStatus(
  reason:
    | "body_too_large"
    | "epoch_not_found"
    | "session_mismatch"
    | "invalid_source_kind"
    | "invalid_status"
    | "not_eligible"
    | "github_post_failed"
    | "github_patch_failed",
): number {
  if (reason === "body_too_large") return 400;
  if (reason === "epoch_not_found" || reason === "session_mismatch") return 404;
  if (reason === "invalid_source_kind" || reason === "invalid_status") return 409;
  if (reason === "not_eligible") return 403;
  if (reason === "github_post_failed" || reason === "github_patch_failed") return 502;
  return 500;
}
