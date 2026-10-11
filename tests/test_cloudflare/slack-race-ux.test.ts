/**
 * Regression coverage for Slack race and UX behaviors (ARC-728).
 *
 * These suites lock in four invariants that existing Slack tests do not fully
 * exercise:
 *
 *  1. Concurrent completion/failure notifications for the same (session,
 *     prompt, stage) post to Slack exactly once — the `slack_posts` idempotency
 *     guard is the last line of defense against double-posting races.
 *  2. Concurrent Slack-thread session-ref claims accept exactly one
 *     `session_id` per `(channel_id, thread_ts)` — i.e. same-thread concurrent
 *     starts never overwrite the first claim.
 *  3. Durable Slack status messages have stable concise shapes across
 *     starting/running/done/failed lifecycle edits.
 *  4. Setup-failure events produce a visible Slack reply that names the failure
 *     rather than silently posting an empty block.
 *
 * Tests intentionally target the small surfaces that own these invariants so
 * they remain fast and resilient: `slack_posts` DAO, `claimSlackThreadSessionRef`
 * DAO, and `buildStatusBlocks`/`buildStatusFallbackText` from the blocks module.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SLACK_BLOCK_SECTION_TEXT_LIMIT } from "../../apps/control-plane-worker/src/constants/slack";
import { insertSlackPostIfAbsent } from "../../apps/control-plane-worker/src/session/slack-posts-db";
import { buildStatusBlocks, buildStatusFallbackText } from "../../apps/control-plane-worker/src/slack/blocks";
import type * as WebhookDbModule from "../../apps/control-plane-worker/src/webhooks/db";

let getSessionIdBySlackThreadRef: typeof WebhookDbModule.getSessionIdBySlackThreadRef;
let claimSlackThreadSessionRef: typeof WebhookDbModule.claimSlackThreadSessionRef;

beforeEach(async () => {
  vi.resetModules();
  const webhookDb: typeof WebhookDbModule = await import("../../apps/control-plane-worker/src/webhooks/db");
  getSessionIdBySlackThreadRef = webhookDb.getSessionIdBySlackThreadRef;
  claimSlackThreadSessionRef = webhookDb.claimSlackThreadSessionRef;
});

// ---------------------------------------------------------------------------
// Minimal D1 fake scoped to the Slack race surfaces exercised here.
//
// We deliberately model the UNIQUE constraints the production schema relies on
// (`slack_posts(session_id, prompt_id, stage)` and
// `slack_thread_session_refs(channel_id, thread_ts)`) so the tests fail if the
// DAO queries stop honoring them.
// ---------------------------------------------------------------------------

interface SlackPostRow {
  id: string;
  session_id: string;
  prompt_id: string;
  stage: string;
  channel: string | null;
  message_ts: string | null;
  created_at: number;
}

interface SlackThreadRefRow {
  business_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  session_id: string;
  updated_at: string;
}

class FakeSlackD1 {
  readonly slackPosts = new Map<string, SlackPostRow>();
  readonly slackThreadRefs = new Map<string, SlackThreadRefRow>();

  prepare(query: string) {
    return new FakeSlackStatement(this, query);
  }
}

class FakeSlackStatement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeSlackD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (
      this.query.includes("CREATE TABLE") ||
      this.query.includes("CREATE INDEX") ||
      this.query.includes("CREATE UNIQUE INDEX")
    ) {
      return { success: true, meta: { changes: 0 } };
    }

    if (/^\s*INSERT (?:OR (?:IGNORE|REPLACE) )?INTO slack_posts\b/.test(this.query)) {
      const [id, sessionId, promptId, stage, channel, messageTs, createdAt] = this.boundValues as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        number,
      ];
      const key = `${sessionId}:${promptId}:${stage}`;
      // The slack_posts dedupe depends on INSERT OR IGNORE semantics (i.e.
      // conflicts report changes=0). If the DAO drops OR IGNORE or switches to
      // OR REPLACE, the duplicate insert reports changes=1 here and the test
      // assertions fail, flagging the concurrency regression.
      const isIgnoreSemantics = this.query.includes("INSERT OR IGNORE");
      const conflict = this.db.slackPosts.has(key);
      if (conflict && isIgnoreSemantics) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.slackPosts.set(key, {
        id,
        session_id: sessionId,
        prompt_id: promptId,
        stage,
        channel,
        message_ts: messageTs,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/INSERT (?:OR IGNORE )?INTO slack_thread_session_refs\b/.test(this.query)) {
      const [businessId, teamId, channelId, threadTs, sessionId, updatedAt] = this.boundValues as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const key = `${businessId}:${teamId}:${channelId}:${threadTs}`;
      const existing = this.db.slackThreadRefs.get(key);
      const hasConflict = existing !== undefined;
      const isInsertOnly =
        this.query.includes("INSERT OR IGNORE") ||
        (this.query.includes("ON CONFLICT") && this.query.includes("DO NOTHING"));
      if (hasConflict && isInsertOnly) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.slackThreadRefs.set(key, {
        business_id: businessId,
        team_id: teamId,
        channel_id: channelId,
        thread_ts: threadTs,
        session_id: sessionId,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query.includes("FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs] = this.boundValues as [string, string, string, string];
      const row =
        this.db.slackThreadRefs.get(`${businessId}:${teamId}:${channelId}:${threadTs}`) ??
        this.db.slackThreadRefs.get(`${businessId}::${channelId}:${threadTs}`);
      return row ? ({ session_id: row.session_id } as unknown as T) : null;
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Concurrent completion/failure notifications
// ---------------------------------------------------------------------------

describe("slack race regression – completion stage idempotency", () => {
  it("concurrent completion claims for the same prompt resolve to exactly one Slack post", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        insertSlackPostIfAbsent(db, {
          sessionId: "sess-race-1",
          promptId: "prompt-race-1",
          stage: "completed",
          channel: "C_RACE",
          messageTs: `1000.${i}`,
        }),
      ),
    );

    const acceptedCount = claims.filter((ok) => ok === true).length;
    expect(acceptedCount).toBe(1);

    const backing = db as unknown as FakeSlackD1;
    expect(backing.slackPosts.size).toBe(1);
  });

  it("completed and failed stages for the same prompt are independent claims", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    const completedFirst = await insertSlackPostIfAbsent(db, {
      sessionId: "sess-stage-1",
      promptId: "prompt-stage-1",
      stage: "completed",
    });
    const completedAgain = await insertSlackPostIfAbsent(db, {
      sessionId: "sess-stage-1",
      promptId: "prompt-stage-1",
      stage: "completed",
    });
    const failedFirst = await insertSlackPostIfAbsent(db, {
      sessionId: "sess-stage-1",
      promptId: "prompt-stage-1",
      stage: "failed",
    });

    expect(completedFirst).toBe(true);
    expect(completedAgain).toBe(false);
    // A separate stage is a separate claim — setup-failure replies must still
    // get through even if a "completed" marker somehow landed first.
    expect(failedFirst).toBe(true);
  });

  it("different prompts on the same session do not block each other", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    const promptA = await insertSlackPostIfAbsent(db, {
      sessionId: "sess-multi",
      promptId: "prompt-A",
      stage: "completed",
    });
    const promptB = await insertSlackPostIfAbsent(db, {
      sessionId: "sess-multi",
      promptId: "prompt-B",
      stage: "completed",
    });

    expect(promptA).toBe(true);
    expect(promptB).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Same-thread concurrent starts — thread-ref contention
// ---------------------------------------------------------------------------

describe("slack race regression – same-thread concurrent starts", () => {
  it("accepts exactly one session_id per (channel, thread) under concurrent claims", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    const claims = await Promise.all([
      claimSlackThreadSessionRef(db, "biz-1", "T_RACE", "C_RACE", "1111.000100", "session-first"),
      claimSlackThreadSessionRef(db, "biz-1", "T_RACE", "C_RACE", "1111.000100", "session-second"),
    ]);

    expect(claims).toEqual([true, false]);
    const backing = db as unknown as FakeSlackD1;
    expect(backing.slackThreadRefs.size).toBe(1);

    const resolved = await getSessionIdBySlackThreadRef(db, "biz-1", "T_RACE", "C_RACE", "1111.000100");
    expect(resolved).toBe("session-first");
  });

  it("ignores empty channel/thread identifiers so stray events cannot poison the index", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    await claimSlackThreadSessionRef(db, "", "T_TEST", "C_TEST", "1111.0", "session-bad-business");
    await claimSlackThreadSessionRef(db, "biz-1", "", "C_TEST", "1111.0", "session-bad-team");
    await claimSlackThreadSessionRef(db, "biz-1", "T_TEST", "", "1111.0", "session-bad-channel");
    await claimSlackThreadSessionRef(db, "biz-1", "T_TEST", "C_TEST", "", "session-bad-thread");
    // Empty sessionId is also a no-op: otherwise a broken upstream could
    // implicitly clear a real thread ref.
    await claimSlackThreadSessionRef(db, "biz-1", "T_TEST", "C_TEST", "1111.0", "");

    const backing = db as unknown as FakeSlackD1;
    expect(backing.slackThreadRefs.size).toBe(0);
  });

  it("sequential claims on the same thread preserve the first session", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    const first = await claimSlackThreadSessionRef(db, "biz-1", "T_REUSE", "C_REUSE", "3333.000300", "session-old");
    const second = await claimSlackThreadSessionRef(db, "biz-1", "T_REUSE", "C_REUSE", "3333.000300", "session-new");

    const resolved = await getSessionIdBySlackThreadRef(db, "biz-1", "T_REUSE", "C_REUSE", "3333.000300");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(resolved).toBe("session-old");
  });

  it("resolves migrated empty-team Slack thread refs after team-scoped lookup", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;
    const backing = db as unknown as FakeSlackD1;
    backing.slackThreadRefs.set("biz-1::C_LEGACY:4444.000400", {
      business_id: "biz-1",
      team_id: "",
      channel_id: "C_LEGACY",
      thread_ts: "4444.000400",
      session_id: "session-legacy",
      updated_at: 1,
    });

    const resolved = await getSessionIdBySlackThreadRef(db, "biz-1", "T_CURRENT", "C_LEGACY", "4444.000400");

    expect(resolved).toBe("session-legacy");
  });

  it("distinct threads on the same channel do not collide", async () => {
    const db = new FakeSlackD1() as unknown as D1Database;

    await claimSlackThreadSessionRef(db, "biz-1", "T_SHARED", "C_SHARED", "1111.000100", "session-thread-A");
    await claimSlackThreadSessionRef(db, "biz-1", "T_SHARED", "C_SHARED", "2222.000200", "session-thread-B");

    const resolvedA = await getSessionIdBySlackThreadRef(db, "biz-1", "T_SHARED", "C_SHARED", "1111.000100");
    const resolvedB = await getSessionIdBySlackThreadRef(db, "biz-1", "T_SHARED", "C_SHARED", "2222.000200");
    expect(resolvedA).toBe("session-thread-A");
    expect(resolvedB).toBe("session-thread-B");
  });
});

// ---------------------------------------------------------------------------
// 3. Concise Slack output — block shape snapshot
// ---------------------------------------------------------------------------

describe("slack UX regression – durable status block shape", () => {
  const sessionId = "sess-blocks";
  const frontendUrl = "https://app.trycycloid.com";
  const repoFullName = "acme/widgets";

  type Block = Record<string, unknown>;

  it("starting status renders the minimum 2-block concise shape", () => {
    const blocks = buildStatusBlocks({
      stage: "starting",
      sessionId,
      frontendUrl,
      repoFullName,
      repoHint: "default",
    }) as Block[];

    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions"]);

    const headline = blocks[0] as { text: { text: string } };
    expect(headline.text.text).toContain("*Starting*");
    expect(headline.text.text).toContain("`acme/widgets`");
    expect(headline.text.text).toContain("(your default repo)");

    const actions = blocks[1] as { elements: Array<{ text: { text: string }; url: string }> };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].text.text).toBe("View Session");
    expect(actions.elements[0].url).toBe(`${frontendUrl}/sessions/${sessionId}`);
  });

  it("running status with a PR stays at the bounded 2-block status shape", () => {
    const blocks = buildStatusBlocks({
      stage: "running",
      sessionId,
      frontendUrl,
      repoFullName,
      prUrl: "https://github.com/acme/widgets/pull/1",
      prNumber: 1,
    }) as Block[];

    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect((blocks[0] as { text: { text: string } }).text.text).toContain("PR #1");
    expect((blocks[0] as { text: { text: string } }).text.text).not.toContain("elapsed");

    const actions = blocks[1] as {
      elements: Array<{ text: { text: string }; url?: string; value?: string; action_id: string; style?: string }>;
    };
    expect(actions.elements).toHaveLength(3);
    expect(actions.elements[0].text.text).toBe("View PR");
    expect(actions.elements[0].url).toBe("https://github.com/acme/widgets/pull/1");
    expect(actions.elements[1]).toMatchObject({
      action_id: "stop_session",
      style: "danger",
      value: sessionId,
      text: { text: "Stop" },
    });
    expect(actions.elements[2].text.text).toBe("View Session");
  });

  it("terminal status cards hide the stop action", () => {
    const blocks = buildStatusBlocks({
      stage: "done",
      sessionId,
      frontendUrl,
      repoFullName,
    }) as Block[];

    expect((blocks[0] as { text: { text: string } }).text.text).not.toContain("elapsed");
    const actions = blocks[blocks.length - 1] as { elements: Array<{ action_id: string }> };
    expect(actions.elements.map((element) => element.action_id)).toEqual(["view_session"]);
  });

  it("renders the full coding-flow outcome as one section per paragraph", () => {
    const verbose = `Done.\n\n${Array.from({ length: 30 }, (_, i) => `Edited file-${i}.ts`).join("\n")}`;
    const blocks = buildStatusBlocks({
      stage: "done",
      sessionId,
      frontendUrl,
      repoFullName,
      summaryText: verbose,
      prUrl: "https://github.com/acme/widgets/pull/1",
      prNumber: 1,
    }) as Block[];

    // Full-fidelity rendering: headline + one section per paragraph + actions.
    // Single newlines stay inside one paragraph, so the tool-call list does
    // not fan out into one block per line.
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => b.type)).toEqual(["section", "section", "section", "actions"]);
    expect((blocks[1] as { text: { text: string } }).text.text).toBe("Done.");
    expect((blocks[2] as { text: { text: string } }).text.text).toContain("Edited file-0.ts");
    expect((blocks[2] as { text: { text: string } }).text.text).toContain("Edited file-29.ts");
  });

  it("truncates oversized coding-flow paragraphs at Slack's section-text limit", () => {
    const verbose = "A".repeat(SLACK_BLOCK_SECTION_TEXT_LIMIT + 500);
    const blocks = buildStatusBlocks({
      stage: "done",
      sessionId,
      frontendUrl,
      repoFullName,
      prUrl: "https://github.com/acme/widgets/pull/1",
      prNumber: 1,
      summaryText: verbose,
    }) as Block[];

    const textBlock = blocks[1] as { text: { text: string } };
    expect(textBlock.text.text.length).toBeLessThanOrEqual(SLACK_BLOCK_SECTION_TEXT_LIMIT);
    expect(textBlock.text.text.endsWith(" ...truncated for Slack")).toBe(true);
  });

  it("supplies a non-empty fallback text on success and on failure with error code", () => {
    // Q&A reply (no prUrl): headline becomes "Reply" and the answer paragraphs
    // are joined into the fallback line.
    expect(
      buildStatusFallbackText({
        stage: "done",
        sessionId,
        frontendUrl,
        summaryText: "Short answer.",
      }),
    ).toBe("Reply - Short answer. | Session: https://app.trycycloid.com/sessions/sess-blocks");
    expect(
      buildStatusFallbackText({
        stage: "done",
        sessionId,
        frontendUrl,
      }),
    ).toBe(
      "Reply - No reply produced — open the session for details. | Session: https://app.trycycloid.com/sessions/sess-blocks",
    );
    expect(
      buildStatusFallbackText({
        stage: "failed",
        sessionId,
        frontendUrl,
        errorCode: "codex_startup_timeout",
      }),
    ).toBe(
      "Failed: Agent runtime startup timed out — not verified - The agent runtime did not start in time. Retry in a few minutes. | Session: https://app.trycycloid.com/sessions/sess-blocks",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Visible setup-failure replies
// ---------------------------------------------------------------------------

describe("slack UX regression – setup-failure visibility", () => {
  const sessionId = "sess-setup-fail";
  const frontendUrl = "https://app.trycycloid.com";

  type Block = Record<string, unknown>;

  it("codex_startup_timeout surfaces a labeled user-visible failure footer", () => {
    const blocks = buildStatusBlocks({
      stage: "failed",
      sessionId,
      frontendUrl,
      errorCode: "codex_startup_timeout",
    }) as Block[];

    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const headline = blocks[0] as { text: { text: string } };
    expect(headline.text.text).toContain(":warning:");
    expect(headline.text.text).toContain("Failed: Agent runtime startup timed out");

    const hint = blocks[1] as { text: { text: string } };
    expect(hint.text.text).toBe("The agent runtime did not start in time. Retry in a few minutes.");

    const actions = blocks[blocks.length - 1] as { elements: Array<{ text: { text: string } }> };
    expect(actions.elements[0].text.text).toBe("View Session");
  });

  it("sandbox_terminated produces a distinct labeled failure footer", () => {
    const blocks = buildStatusBlocks({
      stage: "failed",
      sessionId,
      frontendUrl,
      repoFullName: "acme/widgets",
      errorCode: "sandbox_terminated",
    }) as Block[];

    const headline = blocks[0] as { text: { text: string } };
    expect(headline.text.text).toContain(":warning:");
    expect(headline.text.text).toContain("Failed: Sandbox terminated");
    // The repo context stays visible on failure so the user can tell which
    // session this Slack reply is about.
    expect(headline.text.text).toContain("acme/widgets");

    const hint = blocks[1] as { text: { text: string } };
    expect(hint.text.text).toBe("The sandbox stopped before finishing. Retry the request.");
  });

  it("failure without an error code still says Failed (never silently posts an empty block)", () => {
    const blocks = buildStatusBlocks({ stage: "failed", sessionId, frontendUrl }) as Block[];

    const headline = blocks[0] as { text: { text: string } };
    expect(headline.text.text).toContain(":warning:");
    expect(headline.text.text).toMatch(/Failed\b/);
  });
});
