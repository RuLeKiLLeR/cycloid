import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

type Classification = {
  file: string;
  match: string;
  classification: "inspect-and-report" | "already-handled-elsewhere" | "intentionally-ignored";
  rationale: string;
};

const CLASSIFIED_SLACK_POST_CALLS: Classification[] = [
  {
    file: "apps/control-plane-worker/src/slack/thread-budget.ts",
    match: "? postThreadReply(token, channel, threadTs, text, blocks)",
    classification: "already-handled-elsewhere",
    rationale:
      "postSessionThreadMessage returns ok:false to its budget callers (session notifications, webhook responders), which report via reportSlackPostFailure and schedule retries.",
  },
  {
    file: "apps/control-plane-worker/src/slack/thread-budget.ts",
    match: ": postThreadReply(token, channel, threadTs, text, blocks, attachments);",
    classification: "already-handled-elsewhere",
    rationale:
      "postSessionThreadMessage returns ok:false to its budget callers (session notifications, webhook responders), which report via reportSlackPostFailure and schedule retries.",
  },
  {
    file: "apps/control-plane-worker/src/session/pr-notifications.ts",
    match: "const result = await deliverThreadStatus({",
    classification: "inspect-and-report",
    rationale:
      "PR-created status checks ok:false and successful fallback posts after failed updates, then reports via reportSlackPostFailure.",
  },
  {
    file: "apps/control-plane-worker/src/automation/slack-channel-service.ts",
    match: "await params.postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text);",
    classification: "intentionally-ignored",
    rationale: "Context-only automation reply has no Env in the helper; failures are logged on throw only.",
  },
  {
    file: "apps/control-plane-worker/src/automation/slack-channel-service.ts",
    match: "const postResult = await params.postThreadReply(",
    classification: "inspect-and-report",
    rationale: "Automation starting status checks ok:false and reports via reportSlackPostFailure.",
  },
  {
    file: "apps/control-plane-worker/src/session/slack-notifications.ts",
    match: "const result = await deliverThreadStatus({",
    classification: "inspect-and-report",
    rationale:
      "Prompt status notification checks ok:false and successful fallback posts after failed updates, then reports via reportSlackPostFailure.",
  },
  {
    file: "apps/control-plane-worker/src/session/slack-notifications.ts",
    match: "const statusWithReplyResult = await deliverThreadStatus({",
    classification: "inspect-and-report",
    rationale: "Fallback status update checks ok:false and reports via reportSlackPostFailure.",
  },
  {
    file: "apps/control-plane-worker/src/slack/notify.ts",
    match: "const replyResult = await postThreadReply(token, channel, threadTs, text, blocks, attachments);",
    classification: "already-handled-elsewhere",
    rationale: "deliverThreadStatus returns ok:false to env-owning callers, which report the failure.",
  },
  {
    file: "apps/control-plane-worker/src/slack/plan-approval-interactions.ts",
    match: "const result = await postThreadReply(",
    classification: "intentionally-ignored",
    rationale: "Best-effort pre-session plan fallback logs its own Slack failure and never throws into approval flow.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/slack-thread-responder.ts",
    match: "? await postThreadReply(this.params.slackBotToken, this.params.channelId, this.params.threadTs, text)",
    classification: "inspect-and-report",
    rationale:
      "Env-owning responder wrappers pass a failureReporter; env-free calls remain intentionally context-only.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/slack-thread-responder.ts",
    match: ": await postThreadReply(",
    classification: "inspect-and-report",
    rationale:
      "Env-owning responder wrappers pass a failureReporter; env-free calls remain intentionally context-only.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/slack-events.ts",
    match: "const replyResult = await postThreadReply(slackBotToken as string, channelId, threadTs, reply);",
    classification: "inspect-and-report",
    rationale: "Unconnected-user reply checks ok:false and reports via reportSlackPostFailure.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/shared.ts",
    match: "? await postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text)",
    classification: "inspect-and-report",
    rationale: "Shared wrapper reports ok:false for Slack webhook operational replies.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/shared.ts",
    match:
      ": await postThreadReply(params.slackBotToken, params.channelId, params.threadTs, params.text, params.blocks);",
    classification: "inspect-and-report",
    rationale: "Shared wrapper reports ok:false for Slack webhook operational replies.",
  },
  {
    file: "apps/control-plane-worker/src/webhooks/shared.ts",
    match: "await postThreadReply(",
    classification: "inspect-and-report",
    rationale: "Shared wrapper reports ok:false for Slack webhook operational replies.",
  },
];

function walkTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return walkTsFiles(fullPath);
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

function productionSlackPostCalls(): Array<{ file: string; line: string }> {
  const sourceRoot = path.join(repoRoot, "apps/control-plane-worker/src");
  const files = walkTsFiles(sourceRoot).map((file) => path.relative(repoRoot, file));
  return files.flatMap((file) => {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\b(postThreadReply|deliverThreadStatus)\(/.test(line))
      .filter((line) => !line.startsWith("export async function"))
      .map((line) => ({ file, line }));
  });
}

describe("Slack post failure surface", () => {
  it("classifies every production Slack post/status delivery call site", () => {
    const calls = productionSlackPostCalls();
    const unclassified = calls.filter(
      (call) =>
        !CLASSIFIED_SLACK_POST_CALLS.some((entry) => entry.file === call.file && call.line.includes(entry.match)),
    );
    const staleClassifications = CLASSIFIED_SLACK_POST_CALLS.filter(
      (entry) => !calls.some((call) => call.file === entry.file && call.line.includes(entry.match)),
    );

    expect(unclassified).toEqual([]);
    expect(staleClassifications).toEqual([]);
  });
});
