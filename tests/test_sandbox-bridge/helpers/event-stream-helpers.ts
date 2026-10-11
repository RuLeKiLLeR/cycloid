// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

/**
 * Point the durable outbox at a unique per-call temp directory so a bridge
 * created in one test cannot replay another test's persisted critical events at
 * startup. Returns the directory; pass it to {@link cleanupOutboxDir} in
 * afterEach. Use in bridge tests that construct/run an AgentBridge without the
 * full harness (which already isolates outbox paths via isolated-bridge-paths).
 */
export function isolateOutboxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-outbox-"));
  process.env.ARCANIST_OUTBOX_DIR = dir;
  return dir;
}

export function cleanupOutboxDir(dir: string | undefined): void {
  delete process.env.ARCANIST_OUTBOX_DIR;
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Default Codex assistant message ID used when the harness back-fills
 *  text/reasoning parts that don't carry their own messageID. Distinct from
 *  the bridge-side prompt messageId; this is Codex's internal message ID. */
export const DEFAULT_CODEX_ASSISTANT_MESSAGE_ID = "msg-oc-assistant";
/** Default Codex session ID used by harness mocks. */
export const DEFAULT_CODEX_SESSION_ID = "codex-session-1";

/**
 * Annotate a list of Codex events so they pass the bridge's ARC-761 role
 * gate. Inserts a `message.updated` (role: assistant) immediately before the
 * first text/reasoning part needing it, and back-fills `messageID` on
 * text/reasoning parts that don't already carry one. Inserting at the right
 * spot (rather than prepending) avoids triggering `markPromptStarted` early
 * in tests that need to observe pre-prompt events like a stale `session.idle`.
 *
 * Single-message limitation: every back-filled part is stamped with the same
 * `messageID`. Tests exercising turn-boundary logic across multiple assistant
 * messages should inject explicit `message.updated` events and pre-set
 * `messageID` on each part rather than relying on this helper.
 */
export function withAssistantMessage(
  events: Array<Record<string, unknown>>,
  opts: { messageID?: string; sessionID?: string } = {},
): Array<Record<string, unknown>> {
  const messageID = opts.messageID ?? DEFAULT_CODEX_ASSISTANT_MESSAGE_ID;
  const sessionID = opts.sessionID ?? DEFAULT_CODEX_SESSION_ID;
  const annotated: Array<Record<string, unknown>> = [];
  let injectedMessageUpdated = false;
  for (const event of events) {
    if (event.type !== "message.part.updated") {
      annotated.push(event);
      continue;
    }
    const properties = event.properties as { part?: Record<string, unknown> } | undefined;
    const part = properties?.part;
    if (!part || (part.type !== "text" && part.type !== "reasoning") || typeof part.messageID === "string") {
      annotated.push(event);
      continue;
    }
    if (!injectedMessageUpdated) {
      annotated.push({
        type: "message.updated",
        properties: { info: { id: messageID, sessionID, role: "assistant" } },
      });
      injectedMessageUpdated = true;
    }
    annotated.push({
      ...event,
      properties: { ...properties, part: { ...part, messageID } },
    });
  }
  return annotated;
}

/** Create an async iterator from an array of events.
 *
 *  Auto-applies `withAssistantMessage` so tests that don't care about the
 *  ARC-761 role gate work unchanged. Pass `{ annotateRole: false }` to keep
 *  the raw stream (e.g., when testing user-message parts or race ordering). */
export function makeAsyncIterator(events: Array<Record<string, unknown>>, opts: { annotateRole?: boolean } = {}) {
  const stream = opts.annotateRole === false ? events : withAssistantMessage(events);
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < stream.length) {
            return { value: stream[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    return: vi.fn().mockResolvedValue(undefined),
  };
}
