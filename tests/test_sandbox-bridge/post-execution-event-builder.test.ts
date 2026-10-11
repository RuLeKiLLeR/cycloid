import { describe, expect, it } from "vitest";

import { buildPostExecutionEvent } from "../../apps/sandbox-bridge/src/services/post-execution/event-builder.js";

const CTX = { messageId: "msg-1", sandboxId: "sandbox-1", timestamp: 1_700_000_000_000 };

describe("buildPostExecutionEvent", () => {
  it("fills the shared envelope around the per-branch fields", () => {
    const event = buildPostExecutionEvent(CTX, { hasChanges: false, noChangeReason: "no_diff" });
    expect(event).toMatchObject({
      type: "post_execution",
      messageId: "msg-1",
      sandboxId: "sandbox-1",
      timestamp: 1_700_000_000_000,
      hasChanges: false,
      noChangeReason: "no_diff",
    });
  });

  it("carries through the success-path fields", () => {
    const event = buildPostExecutionEvent(CTX, {
      hasChanges: true,
      branch: "cycloid/x",
      commitSha: "abc123",
      pushed: true,
      diffSummary: "1 file changed",
    });
    expect(event.hasChanges).toBe(true);
    expect(event.branch).toBe("cycloid/x");
    expect(event.pushed).toBe(true);
    expect(event.noChangeReason).toBeUndefined();
  });

  it("omits fields the branch did not provide (old-sandbox payload stays minimal)", () => {
    const event = buildPostExecutionEvent(CTX, { hasChanges: false, noChangeReason: "prep_failed" });
    // A field a control-plane consumer reads optionally (e.g. pushed) must be absent, not null,
    // so the consumer's missing-field fallback path runs.
    expect("pushed" in event).toBe(false);
    expect("verification" in event).toBe(false);
  });

  it("does not let the partial override the envelope identity fields", () => {
    // Bypass the Omit type to prove the runtime guard: even when the partial smuggles in conflicting
    // envelope fields, the ctx-provided envelope must win. (This fails under an envelope-first spread.)
    const event = buildPostExecutionEvent(CTX, {
      hasChanges: true,
      type: "other",
      messageId: "injected",
      sandboxId: "injected-sbx",
      timestamp: 9999,
    } as unknown as Parameters<typeof buildPostExecutionEvent>[1]);
    expect(event.type).toBe("post_execution");
    expect(event.messageId).toBe("msg-1");
    expect(event.sandboxId).toBe("sandbox-1");
    expect(event.timestamp).toBe(CTX.timestamp);
  });
});
