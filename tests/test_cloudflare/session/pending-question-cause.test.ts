import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PhaseTransitionCause } from "../../../apps/control-plane-worker/src/observability/phase-metrics";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

interface PendingQuestionInternal {
  setHasPendingQuestion(value: boolean): Promise<void>;
  persistAndBroadcastSessionStatus(sessionId: string, cause?: PhaseTransitionCause): Promise<string>;
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

function createDOWithPrompt(hasPendingQuestion: number | null) {
  const fakeState = createFakeState();
  const env = {
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
  };
  const instance = new workerModule.SessionDO(fakeState, env);
  const sessionId = "pending-question-cause-session";
  seedSession(fakeState.storage, { sessionId, ownerUserId: "user-1", status: "active" });
  seedSandboxState(fakeState.storage, { sessionId, status: "ready" });
  if (hasPendingQuestion !== null) {
    seedPrompt(fakeState.storage, {
      promptId: "prompt-1",
      sessionId,
      promptText: "work",
      status: "processing",
      hasPendingQuestion,
    });
  }
  return { fakeState, internal: instance as unknown as PendingQuestionInternal, sessionId };
}

describe("setHasPendingQuestion phase-transition cause", () => {
  it("skips broadcast when clearing a prompt that has no pending question", async () => {
    const { fakeState, internal } = createDOWithPrompt(0);
    const broadcast = vi.spyOn(internal, "persistAndBroadcastSessionStatus").mockResolvedValue("running");

    await internal.setHasPendingQuestion(false);

    expect(broadcast).not.toHaveBeenCalled();
    expect(doDb.getPromptHasPendingQuestion(fakeState.storage.sql as unknown as SqlStorage, "prompt-1")).toBe(false);
  });

  it("skips broadcast when there is no active processing prompt", async () => {
    const { internal } = createDOWithPrompt(null);
    const broadcast = vi.spyOn(internal, "persistAndBroadcastSessionStatus").mockResolvedValue("idle");

    await internal.setHasPendingQuestion(false);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts pending_question_cleared when answering a real pending question", async () => {
    const { fakeState, internal, sessionId } = createDOWithPrompt(1);
    const broadcast = vi.spyOn(internal, "persistAndBroadcastSessionStatus").mockResolvedValue("running");

    await internal.setHasPendingQuestion(false);

    expect(doDb.getPromptHasPendingQuestion(fakeState.storage.sql as unknown as SqlStorage, "prompt-1")).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(sessionId, "pending_question_cleared");
    expect(broadcast).not.toHaveBeenCalledWith(sessionId, "pending_question_set");
  });
});
