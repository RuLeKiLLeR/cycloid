// Tests for Linear webhook skip feedback: the dedup marker DAO, the user-facing
// comment copy, and notifyLinearWebhookSkip (lifecycle event always emitted; a
// single deduped comment for user-actionable repo-step skips).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

// --- Mocks for cross-module side effects exercised by notifyLinearWebhookSkip ---
const writeLifecycle = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "evt-id");
vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/service", async (importActual) => ({
  ...(await importActual<object>()),
  writeIntegrationLifecycleEvent: (...args: unknown[]) => writeLifecycle(...args),
}));

const getValidLinearToken = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => "linear-token");
vi.mock("../../apps/control-plane-worker/src/auth/db", async (importActual) => ({
  ...(await importActual<object>()),
  getValidLinearToken: (...args: unknown[]) => getValidLinearToken(...args),
}));

const postLinearIssueComment = vi.fn<(...args: unknown[]) => Promise<{ success: boolean; externalId: string | null }>>(
  async () => ({ success: true, externalId: null }),
);
vi.mock("../../apps/control-plane-worker/src/webhooks/linear", async (importActual) => ({
  ...(await importActual<object>()),
  postLinearIssueComment: (...args: unknown[]) => postLinearIssueComment(...args),
}));

import type { Env } from "../../apps/control-plane-worker/src/types";
import { claimLinearIssueSkipNotice, SKIP_NOTICE_DEDUP_TTL_MS } from "../../apps/control-plane-worker/src/webhooks/db";
import { notifyLinearWebhookSkip, repoSkipCommentText } from "../../apps/control-plane-worker/src/webhooks/shared";

// --- Minimal D1 adapter over better-sqlite3 with all migrations applied ---
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
  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string) {
    return new SqliteD1Statement(this.sqlite, query);
  }
}

function makeDb() {
  return new SqliteD1() as unknown as Parameters<typeof claimLinearIssueSkipNotice>[0];
}

const ISSUE = "issue-uuid-1";
const ENV = {} as Env;

function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  return { ctx, drain: () => Promise.all(tasks) };
}

beforeEach(() => {
  writeLifecycle.mockClear();
  getValidLinearToken.mockClear();
  getValidLinearToken.mockResolvedValue("linear-token");
  postLinearIssueComment.mockClear();
  postLinearIssueComment.mockResolvedValue({ success: true, externalId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimLinearIssueSkipNotice", () => {
  it("returns true once per (issue, reason), false thereafter", async () => {
    const db = makeDb();
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "no_installation")).toBe(true);
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "no_installation")).toBe(false);
    // distinct reason on the same issue is a separate claim
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "repo_not_authorized")).toBe(true);
  });

  it("returns false for empty issue id or reason", async () => {
    const db = makeDb();
    expect(await claimLinearIssueSkipNotice(db, "", "no_installation")).toBe(false);
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "")).toBe(false);
  });

  it("expires old dedup rows while preserving recent dedup rows", async () => {
    const db = makeDb();
    const now = 1_800_000_000_000;

    expect(await claimLinearIssueSkipNotice(db, ISSUE, "no_installation", now - SKIP_NOTICE_DEDUP_TTL_MS)).toBe(true);
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "no_installation", now)).toBe(true);
    expect(await claimLinearIssueSkipNotice(db, ISSUE, "no_installation", now + 1)).toBe(false);
  });
});

describe("repoSkipCommentText", () => {
  it("names the repo for access/installation failures", () => {
    expect(repoSkipCommentText("no_installation", "trycycloid", "cycloid")).toContain("`trycycloid/cycloid`");
    expect(repoSkipCommentText("repo_not_authorized", "trycycloid", "cycloid")).toContain("don't have access");
  });
  it("guides repo configuration when no repo could be determined", () => {
    expect(repoSkipCommentText("invalid_repo_url")).toContain("repo=owner/name");
    expect(repoSkipCommentText("repo_inference_unknown")).toContain("Set a default repo");
  });
  it("falls back to a generic repo label when owner/name absent", () => {
    expect(repoSkipCommentText("no_installation")).toContain("the target repo");
  });
  it("preserves Linear's existing rendered strings", () => {
    expect(repoSkipCommentText("invalid_repo_url")).toBe(
      "Cycloid couldn't start a session: no repository could be determined for this issue. Set a default repo in your Cycloid settings, or add `repo=owner/name` to the description, then re-add the label.",
    );
    expect(repoSkipCommentText("no_installation", "trycycloid", "cycloid")).toBe(
      "Cycloid couldn't start a session: the GitHub App isn't installed for `trycycloid/cycloid`. Install it, then re-add the label.",
    );
    expect(repoSkipCommentText("repo_not_authorized", "trycycloid", "cycloid")).toBe(
      "Cycloid couldn't start a session: you don't have access to `trycycloid/cycloid`.",
    );
    expect(repoSkipCommentText("repo_access_verification_failed", "trycycloid", "cycloid")).toBe(
      "Cycloid couldn't confirm access to `trycycloid/cycloid`. Reconnect GitHub in your Cycloid settings, then re-add the label.",
    );
  });
});

describe("notifyLinearWebhookSkip", () => {
  it("emits a lifecycle event and posts one comment for a repo-step skip", async () => {
    const db = makeDb();
    const { ctx, drain } = makeCtx();
    await notifyLinearWebhookSkip({
      env: ENV,
      db,
      ctx,
      businessId: "biz-1",
      actorUserId: "1",
      linearIssueId: ISSUE,
      reason: "no_installation",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    await drain();

    expect(writeLifecycle).toHaveBeenCalledTimes(1);
    expect(postLinearIssueComment).toHaveBeenCalledTimes(1);
    expect(postLinearIssueComment.mock.calls[0][2]).toContain("`trycycloid/cycloid`");
  });

  it("does not post a second comment for a duplicate webhook (same issue+reason)", async () => {
    const db = makeDb();
    for (let i = 0; i < 3; i++) {
      const { ctx, drain } = makeCtx();
      await notifyLinearWebhookSkip({
        env: ENV,
        db,
        ctx,
        businessId: "biz-1",
        actorUserId: "1",
        linearIssueId: ISSUE,
        reason: "repo_not_authorized",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      });
      await drain();
    }
    // every delivery is recorded for observability, but only one comment is posted
    expect(writeLifecycle).toHaveBeenCalledTimes(3);
    expect(postLinearIssueComment).toHaveBeenCalledTimes(1);
  });

  it("records a lifecycle event but posts no comment when no token is available", async () => {
    getValidLinearToken.mockResolvedValue(null);
    const db = makeDb();
    const { ctx, drain } = makeCtx();
    await notifyLinearWebhookSkip({
      env: ENV,
      db,
      ctx,
      businessId: "biz-1",
      actorUserId: "1",
      linearIssueId: ISSUE,
      reason: "no_installation",
    });
    await drain();
    expect(writeLifecycle).toHaveBeenCalledTimes(1);
    expect(postLinearIssueComment).not.toHaveBeenCalled();
  });

  it("does not comment on identity-gate skips, only records them", async () => {
    const db = makeDb();
    const { ctx, drain } = makeCtx();
    await notifyLinearWebhookSkip({
      env: ENV,
      db,
      ctx,
      businessId: "biz-1",
      actorUserId: "1",
      linearIssueId: ISSUE,
      reason: "repo_inference_unavailable",
    });
    await drain();
    expect(writeLifecycle).toHaveBeenCalledTimes(1);
    expect(postLinearIssueComment).not.toHaveBeenCalled();
  });

  async function notifyOnce(db: Parameters<typeof claimLinearIssueSkipNotice>[0]) {
    const { ctx, drain } = makeCtx();
    await notifyLinearWebhookSkip({
      env: ENV,
      db,
      ctx,
      businessId: "biz-1",
      actorUserId: "1",
      linearIssueId: ISSUE,
      reason: "no_installation",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    await drain();
  }

  it("releases the dedup slot when no token is available so a later delivery retries", async () => {
    const db = makeDb();
    getValidLinearToken.mockResolvedValueOnce(null);
    await notifyOnce(db); // token miss: claim released, no comment
    await notifyOnce(db); // token now available: comment posts
    expect(postLinearIssueComment).toHaveBeenCalledTimes(1);
  });

  it("releases the dedup slot when comment delivery fails so a later delivery retries", async () => {
    const db = makeDb();
    postLinearIssueComment.mockResolvedValueOnce({ success: false, externalId: null });
    await notifyOnce(db); // delivery fails: claim released
    await notifyOnce(db); // retry succeeds
    expect(postLinearIssueComment).toHaveBeenCalledTimes(2);
  });
});
