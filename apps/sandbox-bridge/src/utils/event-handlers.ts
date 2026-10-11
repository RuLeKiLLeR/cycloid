/**
 * Pure delta computation helpers extracted from the main and follow-up event loops.
 *
 * No I/O or side effects -- safe for utils/ per project conventions.
 */

import type { PromptLoopState } from "../prompt-loop-state.js";

/**
 * Compute the text delta for a parent-session, non-synthetic text part.
 *
 * Validates that part.id is a string (the follow-up loop's stricter guard).
 * Drops parts whose owning message is a known non-assistant message -- Codex
 * emits `message.part.updated` for both user and assistant messages on the
 * same session, and forwarding user-message text as `text.delta` output
 * causes the user prompt to render as the assistant reply (ARC-761). Parts
 * whose role is not yet known are stashed in loopState's pending buffer
 * (keyed by messageID + partId) and replayed when the matching
 * `message.updated` reveals an assistant role; user-role parts are discarded
 * on flush. See PromptLoopState.flushPendingUnknownRoleParts.
 *
 * Returns the delta string if there is new content, or null otherwise. Null is
 * also returned when the part is stashed pending its role.
 */
export function emitTextDelta(params: {
  part: { type?: string; synthetic?: boolean; sessionID?: string; text?: string; id?: unknown; messageID?: string };
  codexSessionId: string;
  loopState: PromptLoopState;
}): string | null {
  const { part, codexSessionId, loopState } = params;

  if (
    part.type !== "text" ||
    part.synthetic ||
    part.sessionID !== codexSessionId ||
    !part.text ||
    typeof part.id !== "string"
  ) {
    return null;
  }

  const role = loopState.getMessageRole(part.messageID);
  if (role !== "assistant") {
    if (role === undefined && part.messageID) {
      loopState.stashPendingUnknownRolePart(part.messageID, {
        partId: part.id,
        fullText: part.text,
        kind: "text",
      });
    }
    return null;
  }

  return loopState.updateTextDelta(part.id, part.text, part.messageID);
}

/**
 * Compute the reasoning delta for a parent-session reasoning part.
 *
 * Validates that part.id is a string (the follow-up loop's stricter guard).
 * Same role gating as `emitTextDelta` -- reasoning parts only belong to
 * assistant messages, but we apply the check defensively for symmetry and
 * stash unknown-role parts in loopState's pending buffer until their
 * `message.updated` reveals the role, replaying assistant parts and discarding
 * user parts on flush.
 * Returns the delta string if there is new content, or null otherwise. Null is
 * also returned when the part is stashed pending its role.
 */
export function emitReasoningDelta(params: {
  part: { type?: string; sessionID?: string; text?: string; id?: unknown; messageID?: string };
  codexSessionId: string;
  loopState: PromptLoopState;
}): string | null {
  const { part, codexSessionId, loopState } = params;

  if (part.type !== "reasoning" || part.sessionID !== codexSessionId || !part.text || typeof part.id !== "string") {
    return null;
  }

  const role = loopState.getMessageRole(part.messageID);
  if (role !== "assistant") {
    if (role === undefined && part.messageID) {
      loopState.stashPendingUnknownRolePart(part.messageID, {
        partId: part.id,
        fullText: part.text,
        kind: "reasoning",
      });
    }
    return null;
  }

  return loopState.updateTrackedDelta(`reasoning-${part.id}`, part.text);
}
