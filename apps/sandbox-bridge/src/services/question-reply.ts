import type { BridgeEvent as SandboxEvent } from "../../../../shared/events/bridge.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import type { BridgeLogger } from "../logger.js";
import type { CodexBridgeClient } from "./codex-server.js";

interface PendingQuestion {
  id: string;
  resolve: () => void;
}

export interface QuestionReplyDeps {
  getClient: () => Pick<CodexBridgeClient, "question"> | null;
  sendEvent: (event: SandboxEvent) => void;
  sandboxId: string;
  log: BridgeLogger;
  getPendingQuestion: () => PendingQuestion | null;
  setPendingQuestion: (question: PendingQuestion | null) => void;
  // 9.3: the control plane redelivers an answer whose `respond` frame was lost to
  // a disconnect. Track delivered question ids so a redelivered duplicate is a
  // benign no-op instead of replying again to an already-resolved question (which
  // Codex rejects, spuriously emitting `question_delivery_failed`).
  isQuestionResolved: (questionId: string) => boolean;
  markQuestionResolved: (questionId: string) => void;
}

function emitQuestionDeliveryError(deps: QuestionReplyDeps, messageId: string, errorMessage: string): void {
  deps.sendEvent({
    type: "error",
    error: errorMessage,
    code: "question_delivery_failed",
    messageId,
    sandboxId: deps.sandboxId,
    timestamp: Date.now(),
  });
}

/**
 * Deliver a user's answer to a pending Codex question. Three branches:
 *  1. child-session question (requestId set, does not match the pending parent)
 *     -> reply directly, leave the parent pending,
 *  2. no pending parent but a requestId is present (DO-mediated flow),
 *  3. the normal parent-question resolve.
 *
 * Every branch replies via the local Codex client. There is no control-plane
 * callback and no bearer token on this path.
 */
export function handleRespond(deps: QuestionReplyDeps, answer: string, requestId?: string): void {
  void (async () => {
    const formatError = (err: unknown): string => stringifyError(err);

    const replyToQuestion = async (questionId: string): Promise<void> => {
      const client = deps.getClient();
      if (!client) throw new Error("Codex client unavailable");
      const response = await client.question.reply({ id: questionId, answer });
      if (response.data.ok) return;
      throw new Error("Codex question reply was not accepted");
    };

    const pendingQuestion = deps.getPendingQuestion();

    // A redelivered answer (the control plane resends on reconnect when the first
    // `respond` frame may have been lost) for a question already delivered is a
    // no-op: the agent has moved on, and replying again would be rejected. (9.3.)
    if (requestId && deps.isQuestionResolved(requestId)) {
      deps.log.debug({ requestId }, "Ignoring redelivered answer for an already-resolved question");
      return;
    }

    // If there is a pending parent question but the incoming requestId does NOT
    // match it, this answer belongs to a child-session question. Route it directly
    // and leave pendingQuestion intact so the parent question resolves later.
    if (requestId && pendingQuestion && pendingQuestion.id !== requestId) {
      if (!deps.getClient()) {
        deps.log.warn({ requestId }, "Failed to respond to child question because client is unavailable");
        return;
      }
      replyToQuestion(requestId)
        .then(() => deps.markQuestionResolved(requestId))
        .catch((err) => {
          const error = formatError(err);
          deps.log.warn({ requestId, error }, "Failed to respond to child question");
          emitQuestionDeliveryError(deps, requestId, `Failed to deliver child answer: ${error}`);
        });
      return;
    }

    if (!pendingQuestion) {
      // Fallback: use requestId from command (DO-mediated question flow)
      if (requestId) {
        if (!deps.getClient()) {
          deps.log.warn({ requestId }, "Respond received but client is unavailable");
          return;
        }
        replyToQuestion(requestId)
          .then(() => deps.markQuestionResolved(requestId))
          .catch((err) => {
            const error = formatError(err);
            deps.log.warn({ requestId, error }, "Failed to respond to question");
            emitQuestionDeliveryError(deps, requestId, `Failed to deliver answer: ${error}`);
          });
        return;
      }
      deps.log.warn({}, "Respond received but no pending question");
      return;
    }
    const { id, resolve } = pendingQuestion;
    deps.setPendingQuestion(null);
    // The parent question is consumed synchronously here, so any redelivery now
    // falls through to the no-pending-question path above and is suppressed. (9.3.)
    deps.markQuestionResolved(id);
    const client = deps.getClient();
    if (!client) {
      deps.log.warn({ questionId: id }, "Question reply skipped because client is unavailable");
      emitQuestionDeliveryError(deps, id, "Failed to deliver answer: Codex client unavailable");
      resolve();
      return;
    }

    client.question
      .reply({ id, answer })
      .then((response) => {
        if (!response.data.ok) {
          deps.log.warn({ questionId: id }, "Question reply failed");
          emitQuestionDeliveryError(deps, id, "Failed to deliver answer: Codex question reply was not accepted");
        }
        resolve();
      })
      .catch((err) => {
        const error = formatError(err);
        deps.log.warn({ questionId: id, error }, "Question reply error");
        emitQuestionDeliveryError(deps, id, `Failed to deliver answer: ${error}`);
        resolve();
      });
  })();
}
