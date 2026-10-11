import { SLACK_LOST_ANCHOR_ERROR_CODES } from "../constants/slack-thread-budget";
import { createLogger } from "../logger";
import { postThreadReply, updateMessage } from "./notify";

const log = createLogger({ bindings: { component: "slack-thread-budget" } });
const SUPERSEDED_ASK_TEXT = "Superseded by the ask below ↓";

/**
 * Thread-budget substrate: the ONLY legal way to post a NEW message into a
 * session-bound Slack thread. Budget law: status card + one notifying message
 * for each ball-in-user-court ask/result moment, with compacting where safe.
 *
 * - `ask`: notifying rule. Every ask posts a new reply. When `askMessageTs`
 *   exists, the previous ask is best-effort collapsed to a one-line stub.
 * - `result`: keyed single-shot. Duplicate deliveries for the same `promptId`
 *   update in place; a different `promptId` posts a fresh reply so each
 *   user prompt's terminal answer can notify independently. Callers without a
 *   `promptId` keep the legacy single-slot update-in-place behavior.
 * - `expansion`: exempt passthrough (user-requested detail only).
 *
 * Anchors are ADVISORY rendering state (last-write-wins); the authoritative
 * "may I post" dedup is the caller's claim row (`slack_posts` /
 * `slack_pr_merged_posts` today, `slack_interaction_requests` once it lands).
 */
export type SessionThreadMessageKind = "ask" | "result" | "expansion";

/** Wire-shape mirror of the anchor fields stored on `SlackCallbackContext`. */
export interface SessionThreadAnchors {
  askMessageTs?: string;
  askRepostCount?: number;
  resultMessageTs?: string;
  resultPromptId?: string;
}

export interface PostSessionThreadMessageParams {
  token: string;
  channel: string;
  threadTs: string | undefined;
  kind: SessionThreadMessageKind;
  text: string;
  blocks?: unknown[];
  attachments?: unknown[];
  /** For logging only. */
  sessionId: string;
  /** Stable prompt/event key used to update duplicate result deliveries without clobbering later replies. */
  promptId?: string;
  /** Current advisory anchors from the session callback context (`{}` when unknown). */
  anchors: SessionThreadAnchors;
  /** Persist anchor changes back onto the session callback context. Best-effort. */
  persistAnchors: (patch: SessionThreadAnchors) => void | Promise<void>;
}

export interface PostSessionThreadMessageResult {
  ok: boolean;
  /** Slack ts of the message now carrying this content (new post or in-place update). */
  ts?: string;
  /** True when a NEW thread message was created (budget growth). */
  posted: boolean;
  updatedInPlace: boolean;
  error?: string;
}

function isLostAnchorError(error: string | undefined): boolean {
  return error !== undefined && (SLACK_LOST_ANCHOR_ERROR_CODES as readonly string[]).includes(error);
}

export async function postSessionThreadMessage(
  params: PostSessionThreadMessageParams,
): Promise<PostSessionThreadMessageResult> {
  const { token, channel, threadTs, kind, text, blocks, attachments, sessionId, promptId, anchors, persistAnchors } =
    params;
  const postReply = (): ReturnType<typeof postThreadReply> =>
    attachments === undefined
      ? postThreadReply(token, channel, threadTs, text, blocks)
      : postThreadReply(token, channel, threadTs, text, blocks, attachments);

  if (kind === "expansion") {
    const result = await postReply();
    return { ok: result.ok, ts: result.ts, posted: result.ok, updatedInPlace: false, error: result.error };
  }

  const anchorTs = kind === "ask" ? anchors.askMessageTs : anchors.resultMessageTs;
  const persistAnchorTs = async (ts: string, options: { repaired: boolean }): Promise<void> => {
    const patch: SessionThreadAnchors =
      kind === "ask"
        ? {
            askMessageTs: ts,
            ...(options.repaired ? { askRepostCount: (anchors.askRepostCount ?? 0) + 1 } : {}),
          }
        : { resultMessageTs: ts, ...(promptId ? { resultPromptId: promptId } : {}) };
    try {
      await persistAnchors(patch);
    } catch (err) {
      // Anchors are advisory rendering state; a failed persist means the next
      // write may repost, which the caller-side claim still dedups.
      log.warn({ sessionId, kind, messageTs: ts, error: String(err) }, "Slack thread-budget anchor persist failed");
    }
  };

  const postNew = async (options: { repaired: boolean }): Promise<PostSessionThreadMessageResult> => {
    const result = await postReply();
    if (result.ok && result.ts) {
      await persistAnchorTs(result.ts, options);
    }
    return { ok: result.ok, ts: result.ts, posted: result.ok, updatedInPlace: false, error: result.error };
  };

  if (kind === "ask") {
    const result = await postNew({ repaired: false });
    if (result.ok && anchorTs) {
      try {
        const collapseResult = await updateMessage(token, channel, anchorTs, SUPERSEDED_ASK_TEXT, []);
        if (!collapseResult.ok) {
          log.warn(
            { sessionId, kind, channel, anchorTs, slackError: collapseResult.error },
            "Slack previous ask collapse failed after posting replacement ask",
          );
        }
      } catch (err) {
        log.warn(
          { sessionId, kind, channel, anchorTs, error: String(err) },
          "Slack previous ask collapse threw after posting replacement ask",
        );
      }
    }
    return result;
  }

  if (!anchorTs) {
    return postNew({ repaired: false });
  }

  if (kind === "result" && promptId && anchors.resultPromptId !== promptId) {
    return postNew({ repaired: false });
  }

  const updateResult = await updateMessage(token, channel, anchorTs, text, blocks, attachments);
  if (updateResult.ok) {
    return { ok: true, ts: anchorTs, posted: false, updatedInPlace: true };
  }

  if (!isLostAnchorError(updateResult.error)) {
    // Transient/API failure with the anchor still standing: never post a new
    // message here — that would grow the thread past the budget. Callers'
    // retry machinery re-enters this path.
    return { ok: false, ts: anchorTs, posted: false, updatedInPlace: false, error: updateResult.error };
  }

  log.info(
    { sessionId, kind, channel, anchorTs, slackError: updateResult.error },
    "Slack thread-budget anchor lost; reposting as repair",
  );
  return postNew({ repaired: false });
}
