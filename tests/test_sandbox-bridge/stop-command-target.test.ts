// @ts-nocheck — tests private bridge state for targeted stop fencing.
import { rmSync } from "fs";
import { afterAll, describe, expect, it, vi } from "vitest";

import { AgentBridge } from "../../apps/sandbox-bridge/src/bridge";
import { createRealGitRepoFixture } from "./helpers/repo-fixture.ts";

// This suite does not mock child_process, so the constructor's repo
// validation runs real git; an explicit fixture keeps it host-independent.
const repoFixturePath = createRealGitRepoFixture();
afterAll(() => rmSync(repoFixturePath, { recursive: true, force: true }));

function bridgeWithAbort(messageId: string) {
  const abort = vi.fn();
  const bridge = new AgentBridge({
    repoPath: repoFixturePath,
    sandboxId: "sbx-1",
    sessionId: "sess-1",
    controlPlaneUrl: "https://control.example.com",
    authToken: "secret",
    dependencies: {
      createCodex: vi.fn(),
      createWebSocket: vi.fn(),
    },
  }) as unknown as {
    currentPromptAbort: (() => void) | null;
    currentPromptMessageId: string | null;
    handleStop(command: { type: "stop"; messageId?: string }): void;
  };
  bridge.currentPromptMessageId = messageId;
  bridge.currentPromptAbort = abort;
  return { bridge, abort };
}

describe("targeted bridge stop command", () => {
  // Stop fencing is messageId-only. The startup-attempt branch was removed as
  // dead: no stop sender ever populates startupAttemptId. (The bridge still
  // emits startupAttemptId on prompt_accepted — that side is intentionally kept.)
  it("ignores delayed stop commands for a previous prompt", () => {
    const { bridge, abort } = bridgeWithAbort("p-2");

    bridge.handleStop({ type: "stop", messageId: "p-1" });

    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts the matching prompt", () => {
    const { bridge, abort } = bridgeWithAbort("p-2");

    bridge.handleStop({ type: "stop", messageId: "p-2" });

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts on a broadcast stop with no messageId", () => {
    const { bridge, abort } = bridgeWithAbort("p-2");

    bridge.handleStop({ type: "stop" });

    expect(abort).toHaveBeenCalledTimes(1);
  });
});
