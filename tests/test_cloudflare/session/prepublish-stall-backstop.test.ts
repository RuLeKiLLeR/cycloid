import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LIFECYCLE_SANDBOX_STATE_STORAGE_KEY } from "../../../apps/control-plane-worker/src/constants/sessions";
import { upsertSessionPlan } from "../../../apps/control-plane-worker/src/session/do-db";
import type { PrCoordinationRecord } from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryPrompts,
  querySandboxState,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const mocks = vi.hoisted(() => ({
  getPrCoordination: vi.fn(),
  shadowFireDueDeadline: vi.fn(),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("../../../apps/control-plane-worker/src/session/pr-coordination-db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPrCoordination: mocks.getPrCoordination,
}));

vi.mock("../../../apps/control-plane-worker/src/session/fsm/deadline-producer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shadowFireDueDeadline: mocks.shadowFireDueDeadline,
}));

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response> };
};

const SESSION_ID = "pre-publish-stall-session";
const NOW = 10_000_000;

function staleRecord(overrides: Partial<PrCoordinationRecord> = {}): PrCoordinationRecord {
  return {
    sessionId: SESSION_ID,
    version: 1,
    state: "GENERATING",
    prUrl: null,
    headSha: null,
    verdict: null,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: 1,
    ...overrides,
  };
}

function request(): Request {
  return new Request("https://internal/internal/session/pre-publish-stall-fail", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cleanup-secret" },
    body: JSON.stringify({ sessionId: SESSION_ID, nowMs: NOW }),
  });
}

describe("SessionDO pre-publish stall backstop", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    mocks.getPrCoordination.mockReset();
    mocks.getPrCoordination.mockResolvedValue(staleRecord());
    mocks.shadowFireDueDeadline.mockReset();
    mocks.shadowFireDueDeadline.mockResolvedValue({ wouldFire: true, from: "GENERATING", to: "FAILED" });
  });

  function build() {
    const state = createFakeState();
    const env = {
      ...createTestEnv(),
      SANDBOX_RUNTIME_CLEANUP_SECRET: "cleanup-secret",
    };
    const instance = new workerModule.SessionDO(state, env);
    seedSession(state.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
    });
    seedSandboxState(state.storage, { sessionId: SESSION_ID, status: "reconnecting" });
    seedPrompt(state.storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "work",
      status: "processing",
      startedAt: 1,
    });
    seedPrompt(state.storage, {
      promptId: "prompt-2",
      sessionId: SESSION_ID,
      promptText: "queued follow-up",
      status: "queued",
      queuePosition: 1,
    });
    return { state, instance };
  }

  function parkForPlanApproval(state: ReturnType<typeof createFakeState>): void {
    upsertSessionPlan(state.storage.sql as unknown as SqlStorage, {
      sessionId: SESSION_ID,
      planPromptId: "plan-prompt-1",
      implementationPromptId: null,
      markdown: "# Plan",
      excerpt: "# Plan",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 1,
    });
  }

  it("terminalizes a stale session with no sandbox identity and drives the FSM deadline", async () => {
    const { state, instance } = build();

    const response = await instance.fetch(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, terminalized: true, reason: "stalled" });
    expect(querySandboxState(state.storage, SESSION_ID)?.status).toBe("failed");
    expect(queryPrompts(state.storage, SESSION_ID).map((prompt) => prompt.status)).toEqual(["failed", "failed"]);
    expect(mocks.shadowFireDueDeadline).toHaveBeenCalledOnce();
  });

  it("does not kill a session with a fresh heartbeat", async () => {
    const { state, instance } = build();
    await state.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { lastHeartbeatAt: NOW - 1_000 });

    const response = await instance.fetch(request());

    expect(await response.json()).toEqual({ ok: true, terminalized: false, reason: "heartbeat_still_live" });
    expect(querySandboxState(state.storage, SESSION_ID)?.status).toBe("reconnecting");
    expect(mocks.shadowFireDueDeadline).not.toHaveBeenCalled();
  });

  it("does not kill a session with a live runtime lease", async () => {
    const { state, instance } = build();
    state.storage.sql.exec(
      `UPDATE sandbox_state SET runtime_state = 'running', runtime_sandbox_id = 'runtime-1',
       runtime_live_lease_expires_at = ? WHERE session_id = ?`,
      NOW + 1_000,
      SESSION_ID,
    );

    const response = await instance.fetch(request());

    expect(await response.json()).toEqual({ ok: true, terminalized: false, reason: "runtime_still_live" });
    expect(mocks.shadowFireDueDeadline).not.toHaveBeenCalled();
  });

  it("does not terminalize when plan approval becomes pending during the liveness recheck", async () => {
    const { state, instance } = build();
    const originalGet = state.storage.get.bind(state.storage);
    let parked = false;
    vi.spyOn(state.storage, "get").mockImplementation((async (keyOrKeys: string | string[]) => {
      if (!parked && keyOrKeys === LIFECYCLE_SANDBOX_STATE_STORAGE_KEY) {
        parked = true;
        parkForPlanApproval(state);
      }
      return Array.isArray(keyOrKeys) ? originalGet(keyOrKeys) : originalGet(keyOrKeys);
    }) as typeof state.storage.get);

    const response = await instance.fetch(request());

    expect(await response.json()).toEqual({ ok: true, terminalized: false, reason: "plan_approval_pending" });
    expect(querySandboxState(state.storage, SESSION_ID)?.status).toBe("reconnecting");
    expect(queryPrompts(state.storage, SESSION_ID).map((prompt) => prompt.status)).toEqual(["processing", "queued"]);
    expect(mocks.shadowFireDueDeadline).not.toHaveBeenCalled();
  });

  it("does not act when the FSM moved out of the candidate state before the DO call", async () => {
    const { instance } = build();
    mocks.getPrCoordination.mockResolvedValue(staleRecord({ state: "REVIEW" }));

    const response = await instance.fetch(request());

    expect(await response.json()).toEqual({ ok: true, terminalized: false, reason: "not_stalled" });
    expect(mocks.shadowFireDueDeadline).not.toHaveBeenCalled();
  });
});
