import { createLogger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { reportSlackPostFailure } from "../observability/swallowed-failure";
import type { RepoResolutionFallbackFailureCategory } from "../services/repo-resolver";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import { getSessionState, updateSessionCallbackContext } from "../session/state";
import type { SkippedSlackAttachment } from "../slack/attachments";
import { postThreadReply } from "../slack/notify";
import { postSessionThreadMessage, type SessionThreadAnchors } from "../slack/thread-budget";
import type { CallbackContext, Env } from "../types";
import {
  SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY,
  slackRepoClarificationReply,
  slackSkippedAttachmentsReply,
  slackThreadAlreadyAssociatedReply,
} from "./slack-operational-replies";

const log = createLogger({ bindings: { component: "webhook" } });

export const TRANSIENT_LLM_FAILURE_CATEGORIES = new Set<RepoResolutionFallbackFailureCategory>([
  "provider_5xx",
  "rate_limited",
  "timeout",
  "transport",
]);

export function slackSettingsUrl(env: Env, path = "/settings/preferences"): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${(env.FRONTEND_URL || DEFAULT_FRONTEND_URL).replace(/\/$/, "")}${normalizedPath}`;
}

export function slackGeneralSettingsUrl(env: Env): string {
  return slackSettingsUrl(env, "/settings/preferences");
}

export function slackIntegrationsSettingsUrl(env: Env): string {
  return slackSettingsUrl(env, "/settings/integrations");
}

export function slackWorkspaceIntegrationsSettingsUrl(env: Env): string {
  return slackSettingsUrl(env, "/settings/workspace-integrations");
}

function slackRepoClarificationText(
  llmFailure: RepoResolutionFallbackFailureCategory | undefined,
  settingsUrl: string,
): string {
  if (!llmFailure) {
    return slackRepoClarificationReply("unknown", settingsUrl);
  }
  if (TRANSIENT_LLM_FAILURE_CATEGORIES.has(llmFailure)) {
    return slackRepoClarificationReply("transient", settingsUrl);
  }
  return slackRepoClarificationReply("unavailable", settingsUrl);
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatSkippedSlackAttachments(skipped: readonly SkippedSlackAttachment[]): string {
  const visible = skipped.slice(0, 5);
  const lines = visible.map((skip) => {
    const filename = escapeSlackText(skip.filename.replace(/\s+/g, " ").slice(0, 120));
    return `- ${filename}: ${escapeSlackText(skip.reason)}`;
  });
  if (skipped.length > visible.length) {
    lines.push(`- ${skipped.length - visible.length} more attachment(s) were skipped.`);
  }
  return slackSkippedAttachmentsReply(lines);
}

/**
 * Binds a responder to a claimed session so its replies flow through the
 * thread-budget substrate (`slack/thread-budget.ts`) instead of posting new
 * thread messages. Pre-session operational replies (no claimed session yet)
 * stay on the direct post path.
 */
export interface SlackThreadResponderSessionBudget {
  env: Env;
  sessionId: string;
  slackTeamId: string;
}

export class SlackThreadResponder {
  constructor(
    private readonly params: {
      slackBotToken: string;
      channelId: string;
      threadTs: string;
      ctx?: ExecutionContext;
      sessionBudget?: SlackThreadResponderSessionBudget;
    },
  ) {}

  post(operation: string, text: string, blocks?: Parameters<typeof postThreadReply>[4]): void {
    this.dispatchPost(operation, text, blocks);
  }

  private dispatchPost(
    operation: string,
    text: string,
    blocks?: Parameters<typeof postThreadReply>[4],
    failureReporter?: (result: { ok: boolean; error?: string }) => Promise<unknown>,
  ): void {
    const task = runWithSentryTag(
      operation,
      async () => {
        const result = this.params.sessionBudget
          ? await this.postViaSessionBudget(this.params.sessionBudget, text, blocks)
          : blocks === undefined
            ? await postThreadReply(this.params.slackBotToken, this.params.channelId, this.params.threadTs, text)
            : await postThreadReply(
                this.params.slackBotToken,
                this.params.channelId,
                this.params.threadTs,
                text,
                blocks,
              );
        if (!result.ok && failureReporter) await failureReporter(result);
        return result;
      },
      log,
    );
    if (this.params.ctx) {
      this.params.ctx.waitUntil(task);
      return;
    }
    void task;
  }

  /**
   * Session-bound operational replies are error/attention notices, so they use
   * the ask policy: post a notifying reply and compact any previous ask.
   */
  private async postViaSessionBudget(
    budget: SlackThreadResponderSessionBudget,
    text: string,
    blocks?: unknown[],
  ): Promise<{ ok: boolean; error?: string }> {
    let anchors: SessionThreadAnchors = {};
    try {
      const session = await getSessionState(budget.env, budget.sessionId);
      if (session?.callbackContext?.source === "slack") {
        anchors = session.callbackContext;
      }
    } catch (err) {
      // Anchor lookup is advisory; a starting session (DO not up yet) simply
      // posts without an anchor and persists one for later writers.
      log.info(
        { sessionId: budget.sessionId, error: String(err) },
        "Slack session-budget anchor lookup failed; posting without anchors",
      );
    }
    return postSessionThreadMessage({
      token: this.params.slackBotToken,
      channel: this.params.channelId,
      threadTs: this.params.threadTs,
      kind: "ask",
      text,
      blocks,
      sessionId: budget.sessionId,
      anchors,
      persistAnchors: async (patch) => {
        const context: CallbackContext = {
          source: "slack",
          channel: this.params.channelId,
          threadTs: this.params.threadTs,
          slackTeamId: budget.slackTeamId,
          ...patch,
        };
        await updateSessionCallbackContext(budget.env, budget.sessionId, context);
      },
    });
  }

  postRepoClarification(env: Env, llmFailure?: RepoResolutionFallbackFailureCategory): void {
    this.dispatchPost(
      "postRepoClarificationReply",
      slackRepoClarificationText(llmFailure, slackGeneralSettingsUrl(env)),
      undefined,
      (result) =>
        reportSlackPostFailure(env, {
          operation: "postRepoClarificationReply",
          slackErrorCode: result.error,
        }),
    );
  }

  postSetupError(message: string, operation: string): void {
    this.post(operation, message);
  }

  postThreadAssociation(operation: string): void {
    this.post(operation, slackThreadAlreadyAssociatedReply());
  }

  postSkippedAttachments(skipped: readonly SkippedSlackAttachment[], operation: string): void {
    if (skipped.length === 0) return;
    this.post(operation, formatSkippedSlackAttachments(skipped));
  }

  postAttachmentOnlyNewSession(): void {
    this.post("postSlackAttachmentOnlyNewSessionReply", SLACK_ATTACHMENT_ONLY_NEW_SESSION_REPLY);
  }
}
