import { afterEach, describe, expect, it, vi } from "vitest";

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
  getAllSessionFeedback,
  getSessionFeedback,
  type SessionFeedbackRow,
  upsertSessionFeedback,
} from "../../../apps/control-plane-worker/src/session/feedback-db";
import {
  buildMemoryFeedbackKey,
  getLatestMemoryFeedbackForSessionUser,
  insertMemoryFeedback,
  type MemoryFeedbackRow,
  updateMemoryFeedbackSlackDelivery,
} from "../../../apps/control-plane-worker/src/session/memory-feedback-db";

// Lightweight D1 mock that records prepared statements
type BoundStatement = {
  query: string;
  values: unknown[];
};

function createMockD1(options?: { firstResult?: SessionFeedbackRow | null; allResults?: unknown[] }) {
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
          return { success: true };
        },
        async first<T>() {
          return (options?.firstResult ?? null) as T | null;
        },
        async all<T>() {
          return { results: (options?.allResults ?? []) as T[] };
        },
      };
    },
    _statements: statements,
  };
  return db as unknown as D1Database & { _statements: BoundStatement[] };
}

describe("feedback-db", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("upsertSessionFeedback", () => {
    it("inserts feedback with all fields including transcript", async () => {
      const db = createMockD1();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T12:00:00.123Z"));
      await upsertSessionFeedback(db, {
        sessionId: "s-1",
        userId: "u-1",
        rating: "up",
        message: "great session",
        transcript: "# Session transcript\n\n## Turn 1\n...",
      });

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.query).toContain("INSERT INTO session_feedback");
      expect(stmt.query).toContain("transcript");
      expect(stmt.query).toContain("ON CONFLICT");
      // id, sessionId, userId, rating, message, transcript, created_at, updated_at
      expect(stmt.values).toHaveLength(8);
      expect(stmt.values[0]).toBe("s-1:u-1"); // composite id
      expect(stmt.values[1]).toBe("s-1"); // sessionId
      expect(stmt.values[2]).toBe("u-1"); // userId
      expect(stmt.values[3]).toBe("up"); // rating
      expect(stmt.values[4]).toBe("great session"); // message
      expect(stmt.values[5]).toBe("# Session transcript\n\n## Turn 1\n..."); // transcript
      expect(stmt.values[6]).toBe(1778846400123); // created_at
      expect(stmt.values[7]).toBe(1778846400123); // updated_at
    });

    it("inserts feedback without optional fields (message and transcript default to null)", async () => {
      const db = createMockD1();
      await upsertSessionFeedback(db, {
        sessionId: "s-2",
        userId: "u-2",
        rating: "down",
      });

      expect(db._statements).toHaveLength(1);
      const stmt = db._statements[0];
      expect(stmt.values).toHaveLength(8);
      expect(stmt.values[4]).toBeNull(); // message defaults to null
      expect(stmt.values[5]).toBeNull(); // transcript defaults to null
    });

    it("inserts feedback with message but no transcript", async () => {
      const db = createMockD1();
      await upsertSessionFeedback(db, {
        sessionId: "s-3",
        userId: "u-3",
        rating: "up",
        message: "nice work",
      });

      const stmt = db._statements[0];
      expect(stmt.values[4]).toBe("nice work"); // message
      expect(stmt.values[5]).toBeNull(); // transcript defaults to null
    });

    it("inserts feedback with transcript but no message", async () => {
      const db = createMockD1();
      await upsertSessionFeedback(db, {
        sessionId: "s-4",
        userId: "u-4",
        rating: "down",
        transcript: "# Transcript content",
      });

      const stmt = db._statements[0];
      expect(stmt.values[4]).toBeNull(); // message defaults to null
      expect(stmt.values[5]).toBe("# Transcript content"); // transcript
    });

    it("generates composite id from sessionId and userId", async () => {
      const db = createMockD1();
      await upsertSessionFeedback(db, {
        sessionId: "session-abc",
        userId: "user-xyz",
        rating: "up",
      });

      expect(db._statements[0].values[0]).toBe("session-abc:user-xyz");
    });

    it("upsert query updates rating, message, transcript on conflict", async () => {
      const db = createMockD1();
      await upsertSessionFeedback(db, {
        sessionId: "s-1",
        userId: "u-1",
        rating: "down",
        message: "updated",
        transcript: "updated transcript",
      });

      const stmt = db._statements[0];
      expect(stmt.query).toContain("ON CONFLICT(session_id, user_id) DO UPDATE SET");
      expect(stmt.query).toContain("rating = excluded.rating");
      expect(stmt.query).toContain("message = excluded.message");
      expect(stmt.query).toContain("transcript = excluded.transcript");
      expect(stmt.query).toContain("updated_at = excluded.updated_at");
    });
  });

  describe("getSessionFeedback", () => {
    it("returns the feedback row when it exists", async () => {
      const mockRow: SessionFeedbackRow = {
        id: "s-1:u-1",
        session_id: "s-1",
        user_id: "u-1",
        rating: "up",
        message: "good",
        transcript: "# Transcript",
        created_at: 1735689600000,
        updated_at: 1735689600000,
      };
      const db = createMockD1({ firstResult: mockRow });
      const result = await getSessionFeedback(db, "s-1", "u-1");

      expect(result).toEqual(mockRow);
      expect(db._statements).toHaveLength(1);
      expect(db._statements[0].query).toContain("FROM session_feedback");
      expect(db._statements[0].values).toEqual(["s-1", "u-1"]);
    });

    it("returns null when no feedback exists", async () => {
      const db = createMockD1({ firstResult: null });
      const result = await getSessionFeedback(db, "s-nonexistent", "u-1");

      expect(result).toBeNull();
    });

    it("includes transcript field in returned row", async () => {
      const mockRow: SessionFeedbackRow = {
        id: "s-2:u-2",
        session_id: "s-2",
        user_id: "u-2",
        rating: "down",
        message: null,
        transcript: "# Long transcript with tool calls\n\n**Tool call:** bash - ls\n",
        created_at: 1735689600000,
        updated_at: 1735689600000,
      };
      const db = createMockD1({ firstResult: mockRow });
      const result = await getSessionFeedback(db, "s-2", "u-2");

      expect(result?.transcript).toBe("# Long transcript with tool calls\n\n**Tool call:** bash - ls\n");
    });
  });

  describe("getAllSessionFeedback", () => {
    it("converts D1 INTEGER timestamps to ISO strings for feedback summaries", async () => {
      const db = createMockD1({
        allResults: [
          {
            rating: "up",
            message: "useful",
            login: "octocat",
            created_at: 1735689600123,
          },
        ],
      });

      const result = await getAllSessionFeedback(db, "s-1");

      expect(result).toEqual([
        {
          rating: "up",
          message: "useful",
          login: "octocat",
          created_at: "2025-01-01T00:00:00.123Z",
        },
      ]);
      expect(db._statements).toHaveLength(1);
      expect(db._statements[0].query).toContain("ORDER BY CASE");
      expect(db._statements[0].values).toEqual(["s-1"]);
    });

    it("normalizes legacy ISO strings already stored in timestamp columns", async () => {
      const db = createMockD1({
        allResults: [
          {
            rating: "down",
            message: null,
            login: null,
            created_at: "2025-01-01T00:00:00.000Z",
          },
        ],
      });

      const result = await getAllSessionFeedback(db, "s-legacy");

      expect(result[0]?.created_at).toBe("2025-01-01T00:00:00.000Z");
    });

    it("throws a clear error for corrupt timestamps", async () => {
      const db = createMockD1({
        allResults: [
          {
            rating: "down",
            message: null,
            login: "octocat",
            created_at: "not-a-timestamp",
          },
        ],
      });

      await expect(getAllSessionFeedback(db, "s-bad")).rejects.toThrow(
        'Cannot convert timestamp to ISO string: "not-a-timestamp"',
      );
    });
  });
});

describe("memory-feedback-db", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("inserts append-only memory feedback with snapshot fields", async () => {
    const db = createMockD1();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T12:00:00.000Z"));
    const feedbackKey = buildMemoryFeedbackKey({
      sessionId: "s-1",
      promptId: "p-1",
      activityEventId: "mem-1",
      memoryId: "memory-1",
      userId: "u-1",
    });

    const row = await insertMemoryFeedback(db, {
      id: "fb-1",
      feedbackKey,
      sessionId: "s-1",
      promptId: "p-1",
      activityEventId: "mem-1",
      displayEventType: "memory_usage",
      usageSource: "prompt_start",
      memoryId: "memory-1",
      userId: "u-1",
      userLogin: "octocat",
      rating: "up",
      message: "useful",
      memoryTitle: "Memory title",
      memoryPath: ".cycloid/memory/title.md",
      memoryReason: "Matched the task.",
      memoryExpectedEffect: "Use the helper.",
      memoryObservedEffect: "Used the helper.",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      sessionUrl: "https://app.trycycloid.com/sessions/s-1",
    });

    expect(row.feedback_key).toBe(feedbackKey);
    expect(row.created_at).toBe(1781006400000);
    expect(db._statements).toHaveLength(1);
    expect(db._statements[0].query).toContain("INSERT INTO memory_feedback");
    expect(db._statements[0].query).not.toContain("ON CONFLICT");
    expect(db._statements[0].values).toContain("Memory title");
    expect(db._statements[0].values).toContain("Used the helper.");
  });

  it("loads latest memory feedback rows for a session user", async () => {
    const latestRow: MemoryFeedbackRow = {
      id: "fb-2",
      feedback_key: "s-1:p-1:mem-1:memory-1:u-1",
      session_id: "s-1",
      prompt_id: "p-1",
      activity_event_id: "mem-1",
      display_event_type: "memory_usage",
      usage_source: "prompt_start",
      memory_id: "memory-1",
      user_id: "u-1",
      user_login: "octocat",
      rating: "down",
      message: "wrong",
      memory_title: null,
      memory_path: null,
      memory_reason: null,
      memory_expected_effect: null,
      memory_observed_effect: null,
      repo_owner: null,
      repo_name: null,
      session_url: null,
      slack_channel_id: null,
      slack_message_ts: null,
      slack_post_status: "skipped_config",
      slack_post_error: null,
      created_at: 1781006500000,
    };
    const db = createMockD1({ allResults: [latestRow] });
    const rows = await getLatestMemoryFeedbackForSessionUser(db, "s-1", "u-1");

    expect(rows).toEqual([latestRow]);
    expect(db._statements[0].query).toContain("ORDER BY latest.created_at DESC, latest.rowid DESC");
    expect(db._statements[0].values).toEqual(["s-1", "u-1"]);
  });

  it("updates Slack delivery fields on the inserted row", async () => {
    const db = createMockD1();
    await updateMemoryFeedbackSlackDelivery(db, {
      id: "fb-1",
      status: "sent",
      channelId: "C123",
      messageTs: "123.456",
    });

    expect(db._statements).toHaveLength(1);
    expect(db._statements[0].query).toContain("UPDATE memory_feedback");
    expect(db._statements[0].values).toEqual(["sent", "C123", "123.456", null, "fb-1"]);
  });
});
