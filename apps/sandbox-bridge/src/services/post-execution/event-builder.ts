import type { BridgeEvent } from "../../../../../shared/events/bridge.js";

export type PostExecutionEvent = Extract<BridgeEvent, { type: "post_execution" }>;

/**
 * Per-branch fields of a `post_execution` event. The shared envelope
 * (`type`/`messageId`/`sandboxId`/`timestamp`) is filled in by {@link buildPostExecutionEvent}, so
 * callers only describe what differs between the prep-failed / no-diff / failure / success terminal
 * paths. Keeping the envelope in one builder means a new envelope field is added once, not four
 * times.
 */
export type PostExecutionEventPartial = Omit<PostExecutionEvent, "type" | "messageId" | "sandboxId" | "timestamp">;

export function buildPostExecutionEvent(
  ctx: { messageId: string; sandboxId: string; timestamp: number },
  partial: PostExecutionEventPartial,
): PostExecutionEvent {
  // Spread `partial` first so the envelope identity fields always win at runtime, even if a caller
  // bypasses the Omit type (e.g. via a cast) and smuggles in a `type`/`messageId`/`sandboxId`/
  // `timestamp`. The envelope is the single source of truth for those four fields.
  return {
    ...partial,
    type: "post_execution",
    messageId: ctx.messageId,
    sandboxId: ctx.sandboxId,
    timestamp: ctx.timestamp,
  };
}
