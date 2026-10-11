import { describe, expect, it } from "vitest";

import { mergeCallbackContextUpdate } from "../../apps/control-plane-worker/src/session/callback-context";
import * as doDb from "../../apps/control-plane-worker/src/session/do-db.js";
import { initSchema } from "../../apps/control-plane-worker/src/session/schema.js";
import { FakeSqlStorage } from "./helpers/worker-harness";

type Sql = Parameters<typeof initSchema>[0];

function freshSql(): Sql {
  const { sql } = new FakeSqlStorage();
  initSchema(sql as unknown as Sql);
  return sql as unknown as Sql;
}

describe("mergeCallbackContextUpdate", () => {
  it("preserves stored Slack statusMessageTs when follow-up updates omit it", () => {
    const merged = mergeCallbackContextUpdate(
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000150"],
        statusMessageTs: "1712345678.000500",
      },
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000200"],
      },
    );

    expect(merged).toEqual({
      source: "slack",
      channel: "C_TEST",
      threadTs: "1712345678.000100",
      slackTeamId: "T_TEST",
      reactionMessageTimestamps: ["1712345678.000150", "1712345678.000200"],
      statusMessageTs: "1712345678.000500",
    });
  });

  it("uses the next Slack statusMessageTs when explicitly provided", () => {
    const merged = mergeCallbackContextUpdate(
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        statusMessageTs: "1712345678.000500",
      },
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        statusMessageTs: "1712345678.000700",
      },
    );

    expect(merged.statusMessageTs).toBe("1712345678.000700");
  });

  it("preserves stored thread-budget anchors when a partial update omits them", () => {
    const merged = mergeCallbackContextUpdate(
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        statusMessageTs: "1712345678.000500",
        askMessageTs: "1712345678.000600",
        askRepostCount: 2,
        resultMessageTs: "1712345678.000700",
        resultPromptId: "prompt-1",
      },
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000200"],
      },
    );

    expect(merged).toMatchObject({
      statusMessageTs: "1712345678.000500",
      askMessageTs: "1712345678.000600",
      askRepostCount: 2,
      resultMessageTs: "1712345678.000700",
      resultPromptId: "prompt-1",
    });
  });

  it("uses explicit next thread-budget anchors when provided", () => {
    const merged = mergeCallbackContextUpdate(
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        askMessageTs: "1712345678.000600",
        askRepostCount: 1,
        resultMessageTs: "1712345678.000700",
        resultPromptId: "prompt-1",
      },
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        askMessageTs: "1712345678.000800",
        askRepostCount: 2,
        resultMessageTs: "1712345678.000900",
        resultPromptId: "prompt-2",
      },
    );

    expect(merged).toMatchObject({
      askMessageTs: "1712345678.000800",
      askRepostCount: 2,
      resultMessageTs: "1712345678.000900",
      resultPromptId: "prompt-2",
    });
  });

  it("accumulates reaction timestamps across multiple Slack follow-ups", () => {
    const initial = mergeCallbackContextUpdate(undefined, {
      source: "slack",
      channel: "C_TEST",
      threadTs: "1712345678.000100",
      slackTeamId: "T_TEST",
      reactionMessageTimestamps: ["1712345678.000150"],
    });

    const afterFirstFollowUp = mergeCallbackContextUpdate(initial, {
      source: "slack",
      channel: "C_TEST",
      threadTs: "1712345678.000100",
      slackTeamId: "T_TEST",
      reactionMessageTimestamps: ["1712345678.000200"],
    });

    const afterSecondFollowUp = mergeCallbackContextUpdate(afterFirstFollowUp, {
      source: "slack",
      channel: "C_TEST",
      threadTs: "1712345678.000100",
      slackTeamId: "T_TEST",
      reactionMessageTimestamps: ["1712345678.000300"],
    });

    expect(afterSecondFollowUp).toMatchObject({
      reactionMessageTimestamps: ["1712345678.000150", "1712345678.000200", "1712345678.000300"],
    });
  });

  it("deduplicates repeated reaction timestamps", () => {
    const merged = mergeCallbackContextUpdate(
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000150", "1712345678.000200"],
      },
      {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000200", "1712345678.000300"],
      },
    );

    expect(merged).toMatchObject({
      reactionMessageTimestamps: ["1712345678.000150", "1712345678.000200", "1712345678.000300"],
    });
  });

  it("keeps GitHub QA callback contexts separate from Slack merge semantics", () => {
    const githubContext = {
      source: "github_qa_issue_comment" as const,
      installationId: 123,
      repoOwner: "acme",
      repoName: "repo",
      issueNumber: 73,
      commentId: 77,
      targetPrUrl: "https://github.com/acme/repo/pull/73",
    };

    expect(
      mergeCallbackContextUpdate(
        {
          source: "slack",
          channel: "C_TEST",
          threadTs: "1712345678.000100",
          slackTeamId: "T_TEST",
          reactionMessageTimestamps: ["1712345678.000150"],
          statusMessageTs: "1712345678.000500",
        },
        githubContext,
      ),
    ).toEqual(githubContext);
  });
});

describe("patchSessionCallbackContext", () => {
  it("returns null and skips writes when the session has no callback context", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
    });

    const result = doDb.patchSessionCallbackContext(sql, "s-1", {
      statusMessageTs: "1712345678.000900",
    });

    expect(result).toBeNull();
    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toBeNull();
  });

  it("persists GitHub QA callback context without Slack patch merging", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 123,
        repoOwner: "acme",
        repoName: "repo",
        issueNumber: 73,
        commentId: 77,
        targetPrUrl: "https://github.com/acme/repo/pull/73",
      },
    });

    const result = doDb.patchSessionCallbackContext(sql, "s-1", {
      statusMessageTs: "1712345678.000900",
    });

    expect(result).toBeNull();
    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toEqual({
      source: "github_qa_issue_comment",
      installationId: 123,
      repoOwner: "acme",
      repoName: "repo",
      issueNumber: 73,
      commentId: 77,
      targetPrUrl: "https://github.com/acme/repo/pull/73",
    });
  });

  it("preserves a newer stored reaction timestamp when applying a stale status timestamp patch", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        statusMessageTs: "1712345678.000500",
      },
    });

    doDb.patchSessionCallbackContext(sql, "s-1", {
      addReactionMessageTimestamp: "1712345678.000200",
    });
    doDb.patchSessionCallbackContext(sql, "s-1", {
      statusMessageTs: "1712345678.000900",
    });

    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toEqual({
      source: "slack",
      channel: "C_TEST",
      threadTs: "1712345678.000100",
      slackTeamId: "T_TEST",
      reactionMessageTimestamps: ["1712345678.000200"],
      statusMessageTs: "1712345678.000900",
    });
  });

  it("keeps explicit fallback status timestamp semantics while re-reading stored context", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        statusMessageTs: "1712345678.000500",
      },
    });
    doDb.patchSessionCallbackContext(sql, "s-1", {
      statusMessageTs: "1712345678.000700",
    });

    doDb.patchSessionCallbackContext(sql, "s-1", {
      statusMessageTs: "1712345678.000900",
    });

    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toEqual(
      expect.objectContaining({
        source: "slack",
        statusMessageTs: "1712345678.000900",
      }),
    );
  });

  it("keeps thread-budget anchors across unrelated patches", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
      },
    });

    doDb.patchSessionCallbackContext(sql, "s-1", {
      askMessageTs: "1712345678.000600",
      askRepostCount: 1,
    });
    doDb.patchSessionCallbackContext(sql, "s-1", {
      resultMessageTs: "1712345678.000700",
      resultPromptId: "prompt-1",
    });
    doDb.patchSessionCallbackContext(sql, "s-1", { statusMessageTs: "1712345678.000900" });

    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toMatchObject({
      statusMessageTs: "1712345678.000900",
      askMessageTs: "1712345678.000600",
      askRepostCount: 1,
      resultMessageTs: "1712345678.000700",
      resultPromptId: "prompt-1",
    });
  });

  it("supports adding one reaction timestamp without replacing existing timestamps", () => {
    const sql = freshSql();
    doDb.createSession(sql, {
      sessionId: "s-1",
      ownerUserId: "1",
      callbackContext: {
        source: "slack",
        channel: "C_TEST",
        threadTs: "1712345678.000100",
        slackTeamId: "T_TEST",
        reactionMessageTimestamps: ["1712345678.000150"],
      },
    });

    doDb.patchSessionCallbackContext(sql, "s-1", {
      addReactionMessageTimestamp: "1712345678.000200",
    });

    expect(doDb.getSessionExtended(sql, "s-1")?.callbackContext).toEqual(
      expect.objectContaining({
        source: "slack",
        reactionMessageTimestamps: ["1712345678.000150", "1712345678.000200"],
      }),
    );
  });
});
