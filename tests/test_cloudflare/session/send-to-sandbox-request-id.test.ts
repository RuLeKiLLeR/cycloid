import { beforeAll, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => object;
};

const SESSION_ID = "request-id-session";

describe("SessionDO sendToSandbox requestId handling", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/session/durable-object.ts")) as WorkerModule;
  });

  it("preserves caller requestId for respond commands", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      sandboxId: "sandbox-1",
      status: "ready",
    });

    const socket = {
      readyState: 1,
      send: vi.fn(),
    };

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as {
      sandboxWs: typeof socket;
      requestId: string | null;
      sendToSandbox(command: unknown): Promise<void>;
    };
    instance.sandboxWs = socket;
    instance.requestId = "outer-request-id";

    await instance.sendToSandbox({ type: "respond", answer: "yes", requestId: "question-123" });

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0] as string)).toMatchObject({
      type: "respond",
      answer: "yes",
      requestId: "question-123",
    });
  });

  it("attaches one-shot platform LLM capabilities to prompt commands", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      sandboxId: "sandbox-1",
      status: "ready",
    });

    const socket = {
      readyState: 1,
      send: vi.fn(),
    };
    const instance = new workerModule.SessionDO(fakeState, {
      ...createTestEnv(),
    }) as {
      sandboxWs: typeof socket;
      sendToSandbox(command: unknown): Promise<void>;
    };
    instance.sandboxWs = socket;

    await instance.sendToSandbox({
      type: "prompt",
      messageId: "prompt-1",
      content: "Fix the broker",
      branchNameHint: "fix-the-broker",
    });

    expect(socket.send).toHaveBeenCalledTimes(1);
    const command = JSON.parse(socket.send.mock.calls[0][0] as string);
    expect(command.branchNameHint).toBe("fix-the-broker");
    expect(command.platformLlmCapabilities.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callType: "pr_template_fill", phase: "post_execution", token: expect.any(String) }),
      ]),
    );
    expect(command.platformLlmCapabilities.capabilities).toHaveLength(1);

    const capabilityRows = fakeState.storage.sql
      .exec("SELECT call_type, phase, used_at FROM platform_llm_capabilities WHERE prompt_id = ?", "prompt-1")
      .toArray();
    expect(capabilityRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ call_type: "pr_template_fill", phase: "post_execution", used_at: null }),
      ]),
    );
    expect(capabilityRows).toHaveLength(1);
    expect(doDb.getPlatformLlmPromptStatus(fakeState.storage.sql as unknown as SqlStorage, "prompt-1")).toMatchObject({
      sessionId: SESSION_ID,
      status: "executing",
    });
  });

  it("revokes platform LLM capabilities when prompt dispatch fails", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      sandboxId: "sandbox-1",
      status: "ready",
    });

    const socket = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error("socket closed");
      }),
    };
    const instance = new workerModule.SessionDO(fakeState, {
      ...createTestEnv(),
    }) as {
      sandboxWs: typeof socket;
      sendToSandbox(command: unknown): Promise<void>;
    };
    instance.sandboxWs = socket;

    await instance.sendToSandbox({ type: "prompt", messageId: "prompt-dispatch-fail", content: "Fix the broker" });

    const capabilityRows = fakeState.storage.sql
      .exec("SELECT call_type, used_at FROM platform_llm_capabilities WHERE prompt_id = ?", "prompt-dispatch-fail")
      .toArray();
    expect(capabilityRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ call_type: "pr_template_fill" })]),
    );
    expect(capabilityRows).toHaveLength(1);
    expect(capabilityRows.every((row) => typeof (row as { used_at: unknown }).used_at === "number")).toBe(true);
    expect(
      doDb.getPlatformLlmPromptStatus(fakeState.storage.sql as unknown as SqlStorage, "prompt-dispatch-fail"),
    ).toMatchObject({
      sessionId: SESSION_ID,
      status: "terminal",
    });
  });
});
