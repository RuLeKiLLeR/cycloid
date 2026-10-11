import { describe, expect, it } from "vitest";

import {
  claimSlackPostForDelivery,
  deleteSlackPostMarker,
  getNextDueSlackPostRetry,
  hasDeliveredSlackPost,
  insertSlackPostIfAbsent,
  listDueSlackPostRetries,
  markSlackPostDelivered,
  markSlackPostPendingRetry,
} from "../../../apps/control-plane-worker/src/session/slack-posts-db.ts";

type BoundStatement = {
  query: string;
  values: unknown[];
};

function createMockD1(changes = 1, firstResult: unknown = null, allResults: Array<Record<string, unknown>> = []) {
  const statements: BoundStatement[] = [];
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
          return { success: true, meta: { changes } };
        },
        async first() {
          return firstResult;
        },
        async all() {
          return { results: allResults };
        },
      };
    },
    _statements: statements,
  };
  return db as unknown as D1Database & { _statements: BoundStatement[] };
}

describe("slack-posts-db", () => {
  it("inserts a completion post marker with INSERT OR IGNORE", async () => {
    const db = createMockD1(1);

    const inserted = await insertSlackPostIfAbsent(db, {
      sessionId: "session-1",
      promptId: "prompt-1",
      stage: "completed",
      channel: "C123",
      messageTs: "1712345678.000100",
    });

    expect(inserted).toBe(true);
    expect(db._statements).toHaveLength(1);
    expect(db._statements[0].query).toContain("INSERT OR IGNORE INTO slack_posts");
    expect(db._statements[0].values[1]).toBe("session-1");
    expect(db._statements[0].values[2]).toBe("prompt-1");
    expect(db._statements[0].values[3]).toBe("completed");
    expect(db._statements[0].values[4]).toBe("C123");
    expect(db._statements[0].values[5]).toBe("1712345678.000100");
    expect(db._statements[0].values[7]).toBe("delivered");
  });

  it("returns false when the marker already exists", async () => {
    const db = createMockD1(0);

    const inserted = await insertSlackPostIfAbsent(db, {
      sessionId: "session-1",
      promptId: "prompt-1",
      stage: "failed",
    });

    expect(inserted).toBe(false);
    expect(db._statements[0].values[3]).toBe("failed");
    expect(db._statements[0].values[4]).toBeNull();
    expect(db._statements[0].values[5]).toBeNull();
    expect(db._statements[0].values[7]).toBe("pending");
  });

  it("claims a due post by moving it to sending with a lease", async () => {
    const db = createMockD1(1);

    await expect(
      claimSlackPostForDelivery(db, {
        sessionId: "session-1",
        promptId: "prompt-1",
        stage: "completed",
        channel: "C123",
        now: 1000,
        leaseOwner: "lease-1",
      }),
    ).resolves.toBe(true);

    expect(db._statements[3].query).toContain("SET status = 'sending'");
    expect(db._statements[3].values).toEqual(["lease-1", 61_000, "session-1", "prompt-1", "completed", 1000, 5]);
  });

  it("exhausts an expired max-attempt lease instead of leaving it due forever", async () => {
    const db = createMockD1(0);

    await claimSlackPostForDelivery(db, {
      sessionId: "session-1",
      promptId: "prompt-1",
      stage: "completed",
      now: 1000,
    });

    expect(db._statements[2].query).toContain("SET status = 'exhausted'");
    expect(db._statements[2].values).toEqual(["session-1", "prompt-1", "completed", 5]);
  });

  it("marks a failed delivery pending for a row-local retry", async () => {
    const db = createMockD1(1, { status: "pending" });

    await expect(
      markSlackPostPendingRetry(db, {
        sessionId: "session-1",
        promptId: "prompt-1",
        stage: "failed",
        nextAttemptAt: 2000,
        error: "status_delivery_failed",
      }),
    ).resolves.toBe("pending");

    expect(db._statements[0].query).toContain("status = CASE");
    expect(db._statements[0].query).toContain("status = 'sending'");
    expect(db._statements[0].query).toContain("RETURNING status");
    expect(db._statements[0].values).toEqual([5, 5, 2000, "status_delivery_failed", "session-1", "prompt-1", "failed"]);
  });

  it("returns exhausted when a retry row crosses the max attempt boundary", async () => {
    const db = createMockD1(1, { status: "exhausted" });

    await expect(
      markSlackPostPendingRetry(db, {
        sessionId: "session-1",
        promptId: "prompt-1",
        stage: "verification_blocked",
        nextAttemptAt: 2000,
        error: "verification_blocked_api_error",
      }),
    ).resolves.toBe("exhausted");

    expect(db._statements[0].values).toEqual([
      5,
      5,
      2000,
      "verification_blocked_api_error",
      "session-1",
      "prompt-1",
      "verification_blocked",
    ]);
  });

  it("deletes a marker when delivery needs to be retried", async () => {
    const db = createMockD1(1);

    await deleteSlackPostMarker(db, {
      sessionId: "session-1",
      promptId: "prompt-1",
      stage: "failed",
    });

    expect(db._statements[0].query).toContain("DELETE FROM slack_posts");
    expect(db._statements[0].values).toEqual(["session-1", "prompt-1", "failed"]);
  });

  it("checks only delivered markers when recovering notifications", async () => {
    const db = createMockD1(1, { present: 1 });

    await expect(
      hasDeliveredSlackPost(db, {
        sessionId: "session-1",
        promptId: "prompt-1",
        stage: "completed",
      }),
    ).resolves.toBe(true);

    expect(db._statements[0].query).toContain("message_ts IS NOT NULL");
    expect(db._statements[0].query).toContain("status = 'delivered'");
    expect(db._statements[0].values).toEqual(["session-1", "prompt-1", "completed"]);
  });

  it("lists due prompt retries from row state", async () => {
    const db = createMockD1(1, null, [
      { session_id: "session-1", prompt_id: "prompt-1", stage: "completed", attempt_count: 2 },
      { session_id: "session-1", prompt_id: "prompt-2", stage: "failed", attempt_count: 1 },
      {
        session_id: "session-1",
        prompt_id: "verification:verification-exhausted:head:pr",
        stage: "verification_blocked",
        attempt_count: 1,
      },
      { session_id: "session-1", prompt_id: "session-stopped", stage: "session_stopped", attempt_count: 1 },
    ]);

    await expect(listDueSlackPostRetries(db, "session-1", 3000)).resolves.toEqual([
      { sessionId: "session-1", promptId: "prompt-1", stage: "completed", attemptCount: 2 },
      { sessionId: "session-1", promptId: "prompt-2", stage: "failed", attemptCount: 1 },
      {
        sessionId: "session-1",
        promptId: "verification:verification-exhausted:head:pr",
        stage: "verification_blocked",
        attemptCount: 1,
      },
      { sessionId: "session-1", promptId: "session-stopped", stage: "session_stopped", attemptCount: 1 },
    ]);

    expect(db._statements[0].query).toContain("status = 'pending'");
    expect(db._statements[0].query).toContain("status = 'sending'");
    expect(db._statements[0].query).toContain("'verification_blocked'");
    expect(db._statements[0].query).toContain("'session_stopped'");
    expect(db._statements[0].values).toEqual(["session-1", 3000, 3000]);
  });

  it("finds the next due retry deadline for alarm projection", async () => {
    const db = createMockD1(1, { next_attempt_at: 4000 });

    await expect(getNextDueSlackPostRetry(db, "session-1", 3000)).resolves.toBe(4000);

    expect(db._statements[0].query).toContain("MIN(COALESCE(next_attempt_at, created_at))");
    expect(db._statements[0].query).toContain("'verification_blocked'");
    expect(db._statements[0].query).toContain("'session_stopped'");
    expect(db._statements[0].values).toEqual(["session-1", 3000]);
  });

  it("marks a claimed post as delivered after Slack accepts it", async () => {
    const db = createMockD1(1);

    await markSlackPostDelivered(db, {
      sessionId: "session-1",
      promptId: "prompt-1",
      stage: "completed",
      messageTs: "1712345678.000200",
    });

    expect(db._statements[0].query).toContain("SET message_ts = ?");
    expect(db._statements[0].query).toContain("status = 'delivered'");
    expect(db._statements[0].values).toEqual(["1712345678.000200", "session-1", "prompt-1", "completed"]);
  });
});
