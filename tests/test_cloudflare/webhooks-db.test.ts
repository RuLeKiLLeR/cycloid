import { beforeEach, describe, expect, it } from "vitest";

import { D1_RETRY_SAFE_MARKER, isTransientD1StorageError } from "../../apps/control-plane-worker/src/db/errors";
import {
  buildWebhookIdempotencyKey,
  claimSessionWebhookRef,
  claimSlackThreadSessionRef,
  claimWebhookIdempotency,
  countStandaloneVerificationSessionsByGithubPrRef,
  countVerificationSessionsByGithubPrRef,
  deleteExpiredWebhookIdempotencyClaims,
  deleteLinearIssueSessionRefIfSession,
  deleteSlackThreadSessionRefIfSession,
  getSessionIdByLinearIssueRef,
  getSessionIdBySlackThreadRef,
  listSessionIdsByWebhookRef,
  releaseWebhookIdempotencyClaim,
  upsertSessionWebhookRef,
  WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS,
} from "../../apps/control-plane-worker/src/webhooks/db";
import { runFakeLinearIssueSessionRefMutation } from "./helpers/fake-d1";

class FakeWebhookD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeWebhookD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta?: { changes?: number } }> {
    if (
      this.query.includes("CREATE TABLE") ||
      this.query.includes("CREATE INDEX") ||
      this.query.includes("CREATE UNIQUE INDEX")
    ) {
      return { success: true };
    }

    if (this.query.includes("INSERT OR IGNORE INTO session_webhook_refs")) {
      const [source, externalRef, sessionId] = this.boundValues as [string, string, string];
      const key = `${source}:${externalRef}`;
      const existing = this.db.sessionWebhookRefs.get(key);
      if (existing && existing.size > 0) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.sessionWebhookRefs.set(key, new Set([sessionId]));
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      const [source, externalRef, sessionId] = this.boundValues as [string, string, string];
      const key = `${source}:${externalRef}`;
      const existing = this.db.sessionWebhookRefs.get(key) ?? new Set<string>();
      existing.add(sessionId);
      this.db.sessionWebhookRefs.set(key, existing);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT INTO slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs, sessionId] = this.boundValues as [
        string,
        string,
        string,
        string,
        string,
      ];
      const key = `${businessId}:${teamId}:${channelId}:${threadTs}`;
      if (this.db.slackThreadSessionRefs.has(key)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.slackThreadSessionRefs.set(key, sessionId);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("DELETE FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs, sessionId] = this.boundValues as [
        string,
        string,
        string,
        string,
        string,
      ];
      const key = `${businessId}:${teamId}:${channelId}:${threadTs}`;
      if (this.db.slackThreadSessionRefs.get(key) !== sessionId) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.slackThreadSessionRefs.delete(key);
      return { success: true, meta: { changes: 1 } };
    }

    const linearIssueMutation = runFakeLinearIssueSessionRefMutation(this.db, this.query, this.boundValues);
    if (linearIssueMutation) return linearIssueMutation;

    if (this.query.includes("INTO webhook_idempotency")) {
      const [idempotencyKey, source, payloadHash, receivedAt, expiresBefore] = this.boundValues as [
        string,
        string,
        string | null,
        string,
        string,
      ];
      this.db.idempotencyInsertAttempts.push({ idempotencyKey, source, payloadHash, receivedAt });
      const failure = this.db.idempotencyInsertFailures.shift();
      if (failure) throw failure;
      const existing = this.db.webhookIdempotency.get(idempotencyKey);
      if (existing) {
        const existingReceivedAt = String(existing.receivedAt);
        const expired = Date.parse(existingReceivedAt) <= Date.parse(expiresBefore);
        if (existing.source === source && expired) {
          this.db.webhookIdempotency.set(idempotencyKey, { source, payloadHash, receivedAt });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      this.db.webhookIdempotency.set(idempotencyKey, { source, payloadHash, receivedAt });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("DELETE FROM webhook_idempotency") && this.query.includes("received_at <= ?")) {
      const [expiresBefore] = this.boundValues as [string];
      let changes = 0;
      for (const [idempotencyKey, existing] of this.db.webhookIdempotency) {
        if (Date.parse(String(existing.receivedAt)) <= Date.parse(expiresBefore)) {
          this.db.webhookIdempotency.delete(idempotencyKey);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (this.query.includes("DELETE FROM webhook_idempotency")) {
      const [source, idempotencyKey] = this.boundValues as [string, string];
      this.db.idempotencyDeleteAttempts.push({ source, idempotencyKey });
      const failure = this.db.idempotencyDeleteFailures.shift();
      if (failure) throw failure;
      const existing = this.db.webhookIdempotency.get(idempotencyKey);
      if (!existing || existing.source !== source) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.webhookIdempotency.delete(idempotencyKey);
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("COUNT(DISTINCT s.session_id)")) {
      const [source, externalRef, targetPrUrl] = this.boundValues as [string, string, string];
      const key = `${source}:${externalRef}`;
      const sessionIds = this.db.sessionWebhookRefs.get(key) ?? new Set<string>();
      const matchingSessionIds = new Set<string>(sessionIds);
      for (const [sessionId, storedTargetPrUrl] of this.db.sessionTargetPrUrls) {
        if (storedTargetPrUrl === targetPrUrl) matchingSessionIds.add(sessionId);
      }
      const count = [...matchingSessionIds].filter((sessionId) => {
        if (this.db.sessionAgentRoles.get(sessionId) !== "verification") return false;
        if (this.query.includes("qa_loop_session_bindings") && this.db.qaLoopSessionIds.has(sessionId)) return false;
        return true;
      }).length;
      return { count };
    }

    if (this.query.includes("FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs] = this.boundValues as [string, string, string, string];
      const sessionId =
        this.db.slackThreadSessionRefs.get(`${businessId}:${teamId}:${channelId}:${threadTs}`) ??
        this.db.slackThreadSessionRefs.get(`${businessId}::${channelId}:${threadTs}`);
      return sessionId ? { session_id: sessionId } : null;
    }

    if (this.query.includes("FROM linear_issue_session_refs")) {
      const [issueId] = this.boundValues as [string];
      const sessionId = this.db.linearIssueSessionRefs.get(issueId);
      return sessionId ? { session_id: sessionId } : null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM session_webhook_refs")) {
      const [source, externalRef] = this.boundValues as [string, string];
      const key = `${source}:${externalRef}`;
      const sessionIds = [...(this.db.sessionWebhookRefs.get(key) ?? new Set<string>())].sort();
      return { results: sessionIds.map((sessionId) => ({ session_id: sessionId })) };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }
}

class FakeWebhookD1 {
  readonly sessionWebhookRefs = new Map<string, Set<string>>();
  readonly sessionAgentRoles = new Map<string, string>();
  readonly sessionTargetPrUrls = new Map<string, string>();
  readonly qaLoopSessionIds = new Set<string>();
  readonly slackThreadSessionRefs = new Map<string, string>();
  readonly linearIssueSessionRefs = new Map<string, string>();
  readonly webhookIdempotency = new Map<string, Record<string, unknown>>();
  readonly idempotencyInsertAttempts: Array<{
    idempotencyKey: string;
    source: string;
    payloadHash: string | null;
    receivedAt: string;
  }> = [];
  readonly idempotencyInsertFailures: Error[] = [];
  readonly idempotencyDeleteAttempts: Array<{ source: string; idempotencyKey: string }> = [];
  readonly idempotencyDeleteFailures: Error[] = [];
  readonly preparedQueries: string[] = [];

  prepare(query: string): FakeWebhookD1Statement {
    this.preparedQueries.push(query);
    return new FakeWebhookD1Statement(this, query);
  }
}

describe("webhooks/db idempotency", () => {
  let fakeDb: FakeWebhookD1;

  beforeEach(() => {
    fakeDb = new FakeWebhookD1();
  });

  it("builds explicit and fallback idempotency keys", () => {
    expect(buildWebhookIdempotencyKey("github", " delivery-123 ", "hash-abc")).toBe("github:delivery-123");
    expect(buildWebhookIdempotencyKey("github", "  ", "hash-abc")).toBe("github:sha256:hash-abc");
    expect(buildWebhookIdempotencyKey("slack", null, "hash-xyz")).toBe("slack:sha256:hash-xyz");
  });

  it("claims a new key and rejects duplicates", async () => {
    await expect(claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-1", "hash")).resolves.toBe(
      true,
    );
    await expect(claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-1", "hash")).resolves.toBe(
      false,
    );
  });

  it("releases a claimed key so the webhook can be retried", async () => {
    await expect(claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-1", "hash")).resolves.toBe(
      true,
    );

    await releaseWebhookIdempotencyClaim(fakeDb as unknown as D1Database, "github", "key-1");

    await expect(claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-1", "hash")).resolves.toBe(
      true,
    );
  });

  it("reclaims a stranded claim after the received_at TTL expires", async () => {
    const now = Date.now();
    fakeDb.webhookIdempotency.set("key-expired", {
      source: "github",
      payloadHash: "old-hash",
      receivedAt: new Date(now - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS - 1_000).toISOString(),
    });

    await expect(
      claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-expired", "new-hash"),
    ).resolves.toBe(true);

    expect(fakeDb.webhookIdempotency.get("key-expired")).toMatchObject({
      source: "github",
      payloadHash: "new-hash",
    });
  });

  it("does not reclaim a fresh claim before the received_at TTL expires", async () => {
    fakeDb.webhookIdempotency.set("key-fresh", {
      source: "github",
      payloadHash: "old-hash",
      receivedAt: new Date(Date.now() - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS + 1_000).toISOString(),
    });

    await expect(
      claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-fresh", "new-hash"),
    ).resolves.toBe(false);

    expect(fakeDb.webhookIdempotency.get("key-fresh")).toMatchObject({ payloadHash: "old-hash" });
  });

  it("deletes expired webhook idempotency claims for the scheduled sweeper", async () => {
    const now = Date.now();
    fakeDb.webhookIdempotency.set("key-expired", {
      source: "github",
      payloadHash: "old-hash",
      receivedAt: new Date(now - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS - 1_000).toISOString(),
    });
    fakeDb.webhookIdempotency.set("key-fresh", {
      source: "github",
      payloadHash: "fresh-hash",
      receivedAt: new Date(now - WEBHOOK_IDEMPOTENCY_CLAIM_TTL_MS + 1_000).toISOString(),
    });

    await expect(deleteExpiredWebhookIdempotencyClaims(fakeDb as unknown as D1Database, now)).resolves.toBe(1);

    expect(fakeDb.webhookIdempotency.has("key-expired")).toBe(false);
    expect(fakeDb.webhookIdempotency.has("key-fresh")).toBe(true);
  });

  it("marks retry-safe deletes but not the reclaiming claim upsert", async () => {
    await claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-marker", "hash");
    await releaseWebhookIdempotencyClaim(fakeDb as unknown as D1Database, "github", "key-marker");
    await deleteExpiredWebhookIdempotencyClaims(fakeDb as unknown as D1Database);

    const claimQuery = fakeDb.preparedQueries.find((q) => q.includes("INTO webhook_idempotency"));
    expect(claimQuery).toBeDefined();
    expect(claimQuery).not.toContain(D1_RETRY_SAFE_MARKER);

    const deleteQueries = fakeDb.preparedQueries.filter((q) => q.includes("DELETE FROM webhook_idempotency"));
    expect(deleteQueries).toHaveLength(2);
    for (const query of deleteQueries) {
      expect(query).toContain(D1_RETRY_SAFE_MARKER);
    }
  });

  it("makes a single attempt at the DAO layer and propagates D1 errors", async () => {
    await claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "key-release-fail", "hash");
    fakeDb.idempotencyDeleteFailures.push(new Error("D1_ERROR: no such table: webhook_idempotency"));

    await expect(
      releaseWebhookIdempotencyClaim(fakeDb as unknown as D1Database, "github", "key-release-fail"),
    ).rejects.toThrow("no such table");
    expect(fakeDb.idempotencyDeleteAttempts).toHaveLength(1);
  });

  it("returns true for empty idempotency keys so webhook ingress can continue", async () => {
    await expect(claimWebhookIdempotency(fakeDb as unknown as D1Database, "github", "", "hash")).resolves.toBe(true);
    expect(fakeDb.idempotencyInsertAttempts).toHaveLength(0);
  });

  it("classifies transient D1 storage/reset, network, and internal errors for retry", () => {
    expect(
      isTransientD1StorageError(
        new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset."),
      ),
    ).toBe(true);
    expect(isTransientD1StorageError(new Error("D1_ERROR: Network connection lost."))).toBe(true);
    // Cloudflare platform-side internal faults are transient; D1 does not auto-retry writes,
    // so this is the class we retry on idempotent write paths.
    expect(isTransientD1StorageError(new Error("D1_ERROR: internal error; reference = oscgh3e9f839qc27nd6ale5p"))).toBe(
      true,
    );
    // Wrapper-generated synthetic per-attempt timeout is the same transient class.
    expect(isTransientD1StorageError(new Error("D1_ERROR: synthetic per-attempt timeout after 5000ms"))).toBe(true);
    // Detail nested on `error.cause` must still be classified.
    expect(
      isTransientD1StorageError(
        Object.assign(new Error("D1_ERROR: query failed"), {
          cause: new Error("internal error; reference = abc123"),
        }),
      ),
    ).toBe(true);
  });

  it("does NOT classify overload or non-D1 errors as transient", () => {
    // Overload is a load-shed signal, not a retryable transient (retrying amplifies it,
    // and this classifier also drives scheduled-task suppression).
    expect(isTransientD1StorageError(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."))).toBe(
      false,
    );
    // Overload wins even when an otherwise-retryable substring is present, including on a
    // folded cause, so an overload error is never misclassified as transient.
    expect(
      isTransientD1StorageError(
        Object.assign(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."), {
          cause: new Error("internal error; reference = abc123"),
        }),
      ),
    ).toBe(false);
    expect(isTransientD1StorageError(new Error("D1_ERROR: no such table: webhook_idempotency"))).toBe(false);
    // Missing the D1 gate → not classified even if the words match.
    expect(isTransientD1StorageError(new Error("Network connection lost."))).toBe(false);
    expect(isTransientD1StorageError(new Error("internal error"))).toBe(false);
  });
});

describe("webhooks/db session refs", () => {
  let fakeDb: FakeWebhookD1;

  beforeEach(() => {
    fakeDb = new FakeWebhookD1();
  });

  it("stores and lists GitHub webhook refs", async () => {
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-1",
    );
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-2",
    );

    await expect(
      listSessionIdsByWebhookRef(
        fakeDb as unknown as D1Database,
        "github_pr_url",
        "https://github.com/org/repo/pull/1",
      ),
    ).resolves.toEqual(["s-1", "s-2"]);
  });

  it("counts only verification sessions for a GitHub PR ref or target PR URL", async () => {
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-impl",
    );
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-verify-1",
    );
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-verify-2",
    );
    fakeDb.sessionAgentRoles.set("s-impl", "implementation");
    fakeDb.sessionAgentRoles.set("s-verify-1", "verification");
    fakeDb.sessionAgentRoles.set("s-verify-2", "verification");
    fakeDb.sessionAgentRoles.set("s-verify-target-only", "verification");
    fakeDb.sessionTargetPrUrls.set("s-verify-target-only", "https://github.com/org/repo/pull/1");

    await expect(
      countVerificationSessionsByGithubPrRef(fakeDb as unknown as D1Database, "https://github.com/org/repo/pull/1"),
    ).resolves.toBe(3);
  });

  it("counts only standalone verification sessions for a GitHub PR ref or target PR URL", async () => {
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-impl",
    );
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-direct-ref",
    );
    await upsertSessionWebhookRef(
      fakeDb as unknown as D1Database,
      "github_pr_url",
      "https://github.com/org/repo/pull/1",
      "s-qa-loop-ref",
    );
    fakeDb.sessionAgentRoles.set("s-impl", "implementation");
    fakeDb.sessionAgentRoles.set("s-direct-ref", "verification");
    fakeDb.sessionAgentRoles.set("s-qa-loop-ref", "verification");
    fakeDb.sessionAgentRoles.set("s-direct-target-only", "verification");
    fakeDb.sessionTargetPrUrls.set("s-direct-target-only", "https://github.com/org/repo/pull/1");
    fakeDb.sessionAgentRoles.set("s-qa-loop-target-only", "verification");
    fakeDb.sessionTargetPrUrls.set("s-qa-loop-target-only", "https://github.com/org/repo/pull/1");
    fakeDb.qaLoopSessionIds.add("s-qa-loop-ref");
    fakeDb.qaLoopSessionIds.add("s-qa-loop-target-only");

    await expect(
      countStandaloneVerificationSessionsByGithubPrRef(
        fakeDb as unknown as D1Database,
        "https://github.com/org/repo/pull/1",
      ),
    ).resolves.toBe(2);
  });

  it("ignores empty webhook refs and returns empty lookups", async () => {
    await upsertSessionWebhookRef(fakeDb as unknown as D1Database, "github_pr_url", null, "s-1");

    expect(fakeDb.sessionWebhookRefs.size).toBe(0);
    await expect(listSessionIdsByWebhookRef(fakeDb as unknown as D1Database, "github_pr_url", "")).resolves.toEqual([]);
  });

  it("claims at most one GitHub issue session ref", async () => {
    const first = await claimSessionWebhookRef(fakeDb as unknown as D1Database, "github_issue", "9001", "s-1");
    const second = await claimSessionWebhookRef(fakeDb as unknown as D1Database, "github_issue", "9001", "s-2");

    expect(first).toBe(true);
    expect(second).toBe(false);
    await expect(listSessionIdsByWebhookRef(fakeDb as unknown as D1Database, "github_issue", "9001")).resolves.toEqual([
      "s-1",
    ]);
  });

  it("claims Slack thread refs without overwriting an existing claim", async () => {
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678", "s-1"),
    ).resolves.toBe(true);
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678", "s-2"),
    ).resolves.toBe(false);

    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678"),
    ).resolves.toBe("s-1");
    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C999", "9999.9999"),
    ).resolves.toBe(null);
    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "", "1234.5678"),
    ).resolves.toBe(null);
  });

  it("falls back to migrated Slack thread refs with empty team_id", async () => {
    fakeDb.slackThreadSessionRefs.set("biz-1::C123:1234.5678", "s-legacy");

    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678"),
    ).resolves.toBe("s-legacy");
  });

  it("prefers exact Slack team thread refs over migrated empty-team refs", async () => {
    fakeDb.slackThreadSessionRefs.set("biz-1::C123:1234.5678", "s-legacy");
    fakeDb.slackThreadSessionRefs.set("biz-1:T123:C123:1234.5678", "s-exact");

    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678"),
    ).resolves.toBe("s-exact");
  });

  it("ignores empty Slack thread claim inputs", async () => {
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "", "T123", "C123", "1234.5678", "s-1"),
    ).resolves.toBe(false);
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "", "C123", "1234.5678", "s-1"),
    ).resolves.toBe(false);
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "", "1234.5678", "s-1"),
    ).resolves.toBe(false);
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "", "s-1"),
    ).resolves.toBe(false);
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678", ""),
    ).resolves.toBe(false);

    expect(fakeDb.slackThreadSessionRefs.size).toBe(0);
  });

  it("releases Slack thread refs only when the claimed session matches", async () => {
    await expect(
      claimSlackThreadSessionRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678", "s-1"),
    ).resolves.toBe(true);

    await expect(
      deleteSlackThreadSessionRefIfSession(
        fakeDb as unknown as D1Database,
        "biz-1",
        "T123",
        "C123",
        "1234.5678",
        "s-other",
      ),
    ).resolves.toBe(false);
    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678"),
    ).resolves.toBe("s-1");

    await expect(
      deleteSlackThreadSessionRefIfSession(
        fakeDb as unknown as D1Database,
        "biz-1",
        "T123",
        "C123",
        "1234.5678",
        "s-1",
      ),
    ).resolves.toBe(true);
    await expect(
      getSessionIdBySlackThreadRef(fakeDb as unknown as D1Database, "biz-1", "T123", "C123", "1234.5678"),
    ).resolves.toBe(null);
  });

  it("releases Linear issue refs only when the claimed session matches", async () => {
    fakeDb.linearIssueSessionRefs.set("issue-abc", "s-1");

    await expect(
      deleteLinearIssueSessionRefIfSession(fakeDb as unknown as D1Database, "issue-abc", "s-other"),
    ).resolves.toBe(false);
    await expect(getSessionIdByLinearIssueRef(fakeDb as unknown as D1Database, "issue-abc")).resolves.toBe("s-1");

    await expect(
      deleteLinearIssueSessionRefIfSession(fakeDb as unknown as D1Database, "issue-abc", "s-1"),
    ).resolves.toBe(true);
    await expect(getSessionIdByLinearIssueRef(fakeDb as unknown as D1Database, "issue-abc")).resolves.toBe(null);
  });
});
