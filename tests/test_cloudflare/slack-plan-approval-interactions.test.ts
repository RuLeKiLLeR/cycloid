import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const slackMocks = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  postThreadReply: vi.fn(),
  uploadFile: vi.fn(),
  getBotTokenForTeam: vi.fn(),
  getSessionPlanMarkdown: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  updateMessage: slackMocks.updateMessage,
  postThreadReply: slackMocks.postThreadReply,
  uploadFile: slackMocks.uploadFile,
}));

vi.mock("../../apps/control-plane-worker/src/slack/workspaces", () => ({
  getBotTokenForTeam: slackMocks.getBotTokenForTeam,
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionPlanMarkdown: slackMocks.getSessionPlanMarkdown,
}));

import { SlackInteractionKind } from "../../apps/control-plane-worker/src/enums/slack-interaction.js";
import {
  consumeInteractionRequest,
  getInteractionRequest,
  insertInteractionRequest,
} from "../../apps/control-plane-worker/src/slack/interaction-requests-db.js";
import {
  planMarkdownToSlackMrkdwn,
  publishPlanApprovalInteractionButton,
  replacePlanApprovalInteractionRequest,
  supersedePlanApprovalInteractionRequests,
  updatePlanApprovalInteractionMessage,
} from "../../apps/control-plane-worker/src/slack/plan-approval-interactions.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATION_SQL = readFileSync(
  new URL("../../apps/control-plane-worker/migrations/0244_slack_interaction_requests.sql", import.meta.url),
  "utf8",
);

let sqlite: Database.Database;
let db: D1Database;
let env: Env;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(MIGRATION_SQL);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  env = {
    DB: db,
    TOKEN_ENCRYPTION_KEY: "test-key",
    FRONTEND_URL: "https://app.example.com",
  } as unknown as Env;
  vi.clearAllMocks();
  slackMocks.updateMessage.mockResolvedValue({ ok: true });
  slackMocks.postThreadReply.mockResolvedValue({ ok: true });
  slackMocks.uploadFile.mockResolvedValue({ ok: true });
  slackMocks.getBotTokenForTeam.mockResolvedValue("xoxb-test");
  slackMocks.getSessionPlanMarkdown.mockResolvedValue(null);
});

function planSectionText(): string | undefined {
  const call = slackMocks.updateMessage.mock.calls.at(-1);
  const blocks = (call?.[4] ?? []) as Array<{ type: string; text?: { text?: string } }>;
  // Plan body is the second section; the first is the headline/link section.
  const sections = blocks.filter((b) => b.type === "section");
  return sections[1]?.text?.text;
}

function planThreadReplyText(): string | undefined {
  const blocks = (slackMocks.postThreadReply.mock.calls.at(-1)?.[4] ?? []) as Array<{
    type: string;
    text?: { text?: string };
  }>;
  return blocks.find((block) => block.type === "section")?.text?.text;
}

async function seedPlanRequest(): Promise<string> {
  return insertInteractionRequest(db, {
    businessId: "biz-1",
    sessionId: "sess-1",
    kind: SlackInteractionKind.ApprovePlan,
    payloadJson: JSON.stringify({ revision: 7 }),
    slackTeamId: "T1",
    slackChannelId: "D1",
    messageTs: "1000.1",
    expiresAt: null,
    now: 100,
  });
}

describe("Plan approval Slack interaction requests", () => {
  // ci-sync
  it("publishes a revision-bound Approve button backed by a non-expiring request", async () => {
    const requestId = await publishPlanApprovalInteractionButton(env, {
      businessId: "biz-1",
      sessionId: "sess-1",
      revision: 7,
      slackTeamId: "T1",
      slackChannelId: "D1",
      messageTs: "1000.1",
      botToken: "xoxb-test",
      planMarkdown: null,
    });

    expect(requestId).toEqual(expect.any(String));
    const row = await getInteractionRequest(db, requestId as string);
    expect(row).toMatchObject({
      kind: "approve_plan",
      payloadJson: JSON.stringify({ revision: 7 }),
      status: "pending",
      expiresAt: null,
      slackChannelId: "D1",
      messageTs: "1000.1",
    });
    expect(slackMocks.updateMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "D1",
      "1000.1",
      expect.stringContaining("The plan is attached to this message"),
      expect.arrayContaining([
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              type: "button",
              action_id: `cycloid:approve_plan:${requestId}`,
              text: { type: "plain_text", text: "Approve" },
            }),
          ],
        }),
      ]),
    );
  });

  it("burns no retry path: a consumed request is replaced with the same revision and a fresh button", async () => {
    const consumedId = await seedPlanRequest();
    expect(await consumeInteractionRequest(db, consumedId, "1", 200)).toBe(true);
    const consumed = await getInteractionRequest(db, consumedId);
    expect(consumed).not.toBeNull();
    if (!consumed) throw new Error("Expected consumed request");

    const replacementId = await replacePlanApprovalInteractionRequest(env, consumed);

    expect(replacementId).toEqual(expect.any(String));
    expect(replacementId).not.toBe(consumedId);
    await expect(getInteractionRequest(db, replacementId as string)).resolves.toMatchObject({
      kind: "approve_plan",
      payloadJson: JSON.stringify({ revision: 7 }),
      status: "pending",
      expiresAt: null,
    });
    expect(slackMocks.updateMessage).toHaveBeenLastCalledWith(
      "xoxb-test",
      "D1",
      "1000.1",
      expect.stringContaining("try again"),
      expect.arrayContaining([
        expect.objectContaining({
          elements: [expect.objectContaining({ action_id: `cycloid:approve_plan:${replacementId}` })],
        }),
      ]),
    );
  });

  it("does not turn a post-commit DM update failure into an approval failure", async () => {
    const requestId = await seedPlanRequest();
    const row = await getInteractionRequest(db, requestId);
    expect(row).not.toBeNull();
    if (!row) throw new Error("Expected plan request");
    slackMocks.updateMessage.mockRejectedValue(new Error("Slack unavailable"));

    await expect(updatePlanApprovalInteractionMessage(env, row, "approved")).resolves.toBeUndefined();
  });

  it.each(["edited", "discussed", "approved"] as const)(
    "supersedes and disables the outstanding button when the plan is %s",
    async (reason) => {
      const requestId = await seedPlanRequest();

      await supersedePlanApprovalInteractionRequests(env, "sess-1", reason);

      await expect(getInteractionRequest(db, requestId)).resolves.toMatchObject({ status: "superseded" });
      expect(slackMocks.updateMessage).toHaveBeenCalledWith(
        "xoxb-test",
        "D1",
        "1000.1",
        expect.any(String),
        expect.not.arrayContaining([expect.objectContaining({ type: "actions" })]),
      );
    },
  );

  it("uploads the raw DO-supplied plan into the ready thread", async () => {
    const markdown = `## Goal\n\nDo **the thing**.\n${"long line\n".repeat(1200)}`;
    await publishPlanApprovalInteractionButton(env, {
      businessId: "biz-1",
      sessionId: "sess-1",
      revision: 7,
      slackTeamId: "T1",
      slackChannelId: "D1",
      messageTs: "1000.1",
      botToken: "xoxb-test",
      planMarkdown: markdown,
    });

    // The DO passes its in-hand plan; no re-entrant self-fetch is issued.
    expect(slackMocks.getSessionPlanMarkdown).not.toHaveBeenCalled();
    expect(slackMocks.uploadFile).toHaveBeenCalledWith(
      "xoxb-test",
      "D1",
      "1000.1",
      "plan-sess-1.md",
      markdown.trim(),
      "Here's the full plan.",
    );
    expect(slackMocks.uploadFile.mock.calls[0][4].length).toBeGreaterThan(2800);
    expect(slackMocks.postThreadReply).not.toHaveBeenCalled();
  });

  it("falls back to a rendered and truncated thread reply when file upload is unavailable", async () => {
    slackMocks.uploadFile.mockResolvedValue({ ok: false, error: "missing_scope" });
    await publishPlanApprovalInteractionButton(env, {
      businessId: "biz-1",
      sessionId: "sess-1",
      revision: 7,
      slackTeamId: "T1",
      slackChannelId: "D1",
      messageTs: "1000.1",
      botToken: "xoxb-test",
      planMarkdown: `## Goal\n\nDo **the thing**.\n${"long line\n".repeat(1200)}`,
    });

    expect(slackMocks.postThreadReply).toHaveBeenCalledWith("xoxb-test", "D1", "1000.1", "Here's the full plan.", [
      expect.objectContaining({ type: "section" }),
    ]);
    expect(planThreadReplyText()).toContain("*Goal*");
    expect(planThreadReplyText()).toContain("Do *the thing*");
    expect(planThreadReplyText()).toContain("Plan truncated.");
    expect(planThreadReplyText()).toContain("Open in Cycloid");
  });

  it("does not post a plan thread when there is no plan text", async () => {
    await publishPlanApprovalInteractionButton(env, {
      businessId: "biz-1",
      sessionId: "sess-1",
      revision: 7,
      slackTeamId: "T1",
      slackChannelId: "D1",
      messageTs: "1000.1",
      botToken: "xoxb-test",
      planMarkdown: null,
    });

    expect(slackMocks.uploadFile).not.toHaveBeenCalled();
    expect(slackMocks.postThreadReply).not.toHaveBeenCalled();
  });

  it("renders the DO-supplied plan into the approved supersession message", async () => {
    await seedPlanRequest();

    await supersedePlanApprovalInteractionRequests(env, "sess-1", "approved", { planMarkdown: "Ship it." });

    expect(slackMocks.getSessionPlanMarkdown).not.toHaveBeenCalled();
    expect(planSectionText()).toBe("Ship it.");
  });

  it("fetches and renders the plan on the worker-side approved repaint", async () => {
    slackMocks.getSessionPlanMarkdown.mockResolvedValue({ markdown: "Fetched plan." });
    const requestId = await seedPlanRequest();
    const row = await getInteractionRequest(db, requestId);
    if (!row) throw new Error("Expected plan request");

    await updatePlanApprovalInteractionMessage(env, row, "approved");

    expect(slackMocks.getSessionPlanMarkdown).toHaveBeenCalledWith(env, "sess-1");
    expect(planSectionText()).toBe("Fetched plan.");
  });

  it("falls back to a link-only notice when there is no plan text", async () => {
    await seedPlanRequest();

    await supersedePlanApprovalInteractionRequests(env, "sess-1", "approved", { planMarkdown: null });

    const blocks = (slackMocks.updateMessage.mock.calls.at(-1)?.[4] ?? []) as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "section")).toHaveLength(1);
  });

  it("does not attach the plan to superseded states that no longer reflect it", async () => {
    slackMocks.getSessionPlanMarkdown.mockResolvedValue({ markdown: "Old plan." });
    await seedPlanRequest();

    await supersedePlanApprovalInteractionRequests(env, "sess-1", "edited");

    expect(slackMocks.getSessionPlanMarkdown).not.toHaveBeenCalled();
    expect(planSectionText()).toBeUndefined();
  });

  it("converts GitHub markdown glyphs to Slack mrkdwn", () => {
    expect(planMarkdownToSlackMrkdwn("## Plan")).toBe("*Plan*");
    expect(planMarkdownToSlackMrkdwn("a **bold** b")).toBe("a *bold* b");
    expect(planMarkdownToSlackMrkdwn("an __also__ c")).toBe("an *also* c");
    expect(planMarkdownToSlackMrkdwn("see [here](https://x.example/y)")).toBe("see <https://x.example/y|here>");
    expect(planMarkdownToSlackMrkdwn("- keep bullets")).toBe("- keep bullets");
  });

  it("escapes Slack control sequences so plan text cannot ping or render as mentions", () => {
    // <!here>, <@U123>, <!channel>, <!subteam^...> must be neutralized, not sent raw.
    expect(planMarkdownToSlackMrkdwn("ping <!here> and <@U0AK0Q5CW8M>")).toBe(
      "ping &lt;!here&gt; and &lt;@U0AK0Q5CW8M&gt;",
    );
    expect(planMarkdownToSlackMrkdwn("notify <!channel>")).toBe("notify &lt;!channel&gt;");
    // Bare angle brackets in code/generics are escaped too.
    expect(planMarkdownToSlackMrkdwn("uses Array<Foo> & Bar")).toBe("uses Array&lt;Foo&gt; &amp; Bar");
  });

  it("does not truncate markdown links whose URL contains balanced parentheses", () => {
    expect(planMarkdownToSlackMrkdwn("[C](https://en.wikipedia.org/wiki/C_(programming_language))")).toBe(
      "<https://en.wikipedia.org/wiki/C_(programming_language)|C>",
    );
    // Query-string ampersands survive un-escaped inside the link URL.
    expect(planMarkdownToSlackMrkdwn("[q](https://x.example/s?a=1&b=2)")).toBe("<https://x.example/s?a=1&b=2|q>");
  });

  it("truncates an oversized plan in the inline fallback", async () => {
    slackMocks.uploadFile.mockResolvedValue({ ok: false, error: "missing_scope" });

    await publishPlanApprovalInteractionButton(env, {
      businessId: "biz-1",
      sessionId: "sess-1",
      revision: 7,
      slackTeamId: "T1",
      slackChannelId: "D1",
      messageTs: "1000.1",
      botToken: "xoxb-test",
      planMarkdown: "para\n".repeat(2000),
    });

    const text = planThreadReplyText() ?? "";
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain("Plan truncated.");
    expect(text).toContain("Open in Cycloid");
  });

  it("resolves after the D1 flip when the Slack repaint is deferred, without waiting for chat.update", async () => {
    const requestId = await seedPlanRequest();
    let releaseUpdate!: (value: { ok: boolean }) => void;
    slackMocks.updateMessage.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          releaseUpdate = resolve;
        }),
    );
    let deferred: Promise<void> | null = null;

    await supersedePlanApprovalInteractionRequests(env, "sess-1", "edited", {
      deferSlackUpdates: (work) => {
        deferred = work;
      },
    });

    await expect(getInteractionRequest(db, requestId)).resolves.toMatchObject({ status: "superseded" });
    expect(deferred).not.toBeNull();
    await vi.waitFor(() => expect(slackMocks.updateMessage).toHaveBeenCalled());
    releaseUpdate({ ok: true });
    await deferred;
    expect(slackMocks.updateMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "D1",
      "1000.1",
      expect.any(String),
      expect.anything(),
    );
  });
});
