import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLogBlockedDmOutcome,
  mockNotifyUserBlocked,
  mockPostStructuredEventToDd,
  mockSupersedePlanApprovalInteractionRequests,
} = vi.hoisted(() => ({
  mockLogBlockedDmOutcome: vi.fn(),
  mockNotifyUserBlocked: vi.fn(),
  mockPostStructuredEventToDd: vi.fn(),
  mockSupersedePlanApprovalInteractionRequests: vi.fn(),
}));
vi.mock("../../../apps/control-plane-worker/src/session/notify-user-blocked", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/session/notify-user-blocked")
  >("../../../apps/control-plane-worker/src/session/notify-user-blocked");
  return {
    ...actual,
    logBlockedDmOutcome: (...args: unknown[]) => mockLogBlockedDmOutcome(...args),
    notifyUserBlocked: (...args: unknown[]) => mockNotifyUserBlocked(...args),
  };
});
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));
vi.mock("../../../apps/control-plane-worker/src/slack/plan-approval-interactions", () => ({
  supersedePlanApprovalInteractionRequests: (...args: unknown[]) =>
    mockSupersedePlanApprovalInteractionRequests(...args),
}));

import {
  PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY,
  PLAN_READY_DELIVERY_STORAGE_KEY,
} from "../../../apps/control-plane-worker/src/constants/plan-approval";
import { PLAN_APPROVAL_PENDING_STORAGE_KEY } from "../../../apps/control-plane-worker/src/constants/sessions";
import { SandboxIdlePauseReason } from "../../../apps/control-plane-worker/src/enums/sandbox";
import {
  getLatestSessionPlan,
  getPrompts,
  getSandboxState,
  updateSessionFields,
  upsertSessionPlan,
} from "../../../apps/control-plane-worker/src/session/do-db";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "../sqlite-d1-helper";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers";

mockCloudflareWorkers();
mockSentryCloudflare();

type PlanParkHarness = {
  planApprovalPending: boolean;
  fetch(request: Request): Promise<Response>;
  fireDuePlanParkPause(sessionId: string): Promise<void>;
  fireDuePlanReadyDelivery(sessionId: string): Promise<void>;
  cancelPlanParkPause(): Promise<void>;
  persistAndBroadcastSessionStatus(sessionId: string, cause: "active_prompt_started"): Promise<string>;
  rescheduleSessionAlarm(): Promise<void>;
  onPlanApprovalParked(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    valid: boolean;
    missingReason: string | null;
  }): Promise<void>;
  onPlanApprovalDiscussion(args: {
    sessionId: string;
    planPromptId: string;
    revision: number;
    promptId: string;
  }): Promise<void>;
  onPlanApprovalApproved(sessionId: string): Promise<void>;
  onPlanApprovalStopped(sessionId: string): Promise<void>;
  reconcilePlanApprovalSpine(sessionId: string): Promise<void>;
  releasePlanApprovalPark(sessionId: string, cause: "unknown"): Promise<void>;
  pauseE2BRuntimeForIdle(
    sessionId: string,
    runtimeSandboxId: string,
    parkedAt: number,
    reason: SandboxIdlePauseReason,
  ): Promise<boolean>;
  startSpawnAttempt(sessionId: string, operation: string): Promise<string>;
};

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => PlanParkHarness;
};

const SID = "plan-park-session";
let workerModule: WorkerModule;

function createMigratedD1(): D1Database {
  const sqlite = new Database(":memory:");
  const migrationsDir = resolve(__dirname, "../../../apps/control-plane-worker/migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function seedPendingPlan(fakeState: ReturnType<typeof createFakeState>): void {
  seedSession(fakeState.storage, {
    sessionId: SID,
    ownerUserId: "7",
    planMode: 1,
    planApprovalRequired: 1,
  });
  seedSandboxState(fakeState.storage, { sessionId: SID, status: "ready" });
  upsertSessionPlan(fakeState.storage.sql as unknown as SqlStorage, {
    sessionId: SID,
    planPromptId: "p-1",
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

function seedApprovalScenario(
  fakeState: ReturnType<typeof createFakeState>,
  options: { planStatus?: "none" | "pending" | "approved" | "superseded"; revision?: number } = {},
): void {
  const revision = options.revision ?? 2;
  seedPendingPlan(fakeState);
  seedPrompt(fakeState.storage, {
    sessionId: SID,
    promptId: "p-1",
    promptText: "Implement the approved plan",
    actorUserId: "7",
    status: "completed",
    queuePosition: 0,
    completedAt: Date.now() - 1_000,
  });
  seedPrompt(fakeState.storage, {
    sessionId: SID,
    promptId: "p-2",
    promptText: "Held follow-up",
    actorUserId: "7",
    status: "queued",
    queuePosition: 1,
  });
  updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, SID, { promptCounter: 2 });
  upsertSessionPlan(fakeState.storage.sql as unknown as SqlStorage, {
    sessionId: SID,
    planPromptId: "p-1",
    implementationPromptId: null,
    markdown: "# Plan\n\nEdited implementation plan",
    excerpt: "# Plan\n\nEdited implementation plan",
    artifactId: "plan-artifact-1",
    valid: true,
    missingReason: null,
    missingHeadings: [],
    status: options.planStatus ?? "pending",
    revision,
    userEdited: true,
    source: "generated",
    createdAt: new Date(Date.now() - 30_000).toISOString(),
  });
}

function approveRequest(revision: number): Request {
  return new Request("https://internal/session/plan/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, actorUserId: "7", source: "web" }),
  });
}

describe("plan approval park durability", () => {
  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as unknown as WorkerModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyUserBlocked.mockResolvedValue("sent");
    mockSupersedePlanApprovalInteractionRequests.mockResolvedValue(undefined);
    mockPostStructuredEventToDd.mockResolvedValue(undefined);
  });

  it("supersedes the Slack approval button when discussion starts", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalDiscussion({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      promptId: "p-2",
    });
    await fakeState.flushWaitUntil();

    expect(mockSupersedePlanApprovalInteractionRequests).toHaveBeenCalledWith(expect.anything(), SID, "discussed", {
      planMarkdown: null,
    });
  });

  it("supersedes the Slack approval button when approval commits", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalApproved(SID);
    await fakeState.flushWaitUntil();

    expect(mockSupersedePlanApprovalInteractionRequests).toHaveBeenCalledWith(expect.anything(), SID, "approved", {
      planMarkdown: "# Plan",
    });
  });

  it("supersedes the Slack approval button when the parked session is stopped", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalStopped(SID);
    await fakeState.flushWaitUntil();

    expect(mockSupersedePlanApprovalInteractionRequests).toHaveBeenCalledWith(expect.anything(), SID, "stopped", {
      planMarkdown: null,
    });
  });

  it("atomically approves the edited revision, splices one implementation prompt, and releases held follow-ups", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    fakeState.storage.sql.exec("UPDATE sandbox_state SET status = 'spawning' WHERE session_id = ?", SID);
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() + 300_000,
      parkedAt: Date.now() - 30_000,
      planPromptId: "p-1",
      runtimeSandboxId: null,
    });

    const response = await instance.fetch(approveRequest(2));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      revision: 2,
      implementationPromptId: "p-3",
      idempotent: false,
    });
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)).toMatchObject({
      status: "approved",
      revision: 2,
      approvedBy: "7",
      implementationPromptId: "p-3",
      source: "web",
    });
    expect(
      getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID).map((prompt) => [
        prompt.promptId,
        prompt.status,
        prompt.prompt,
      ]),
    ).toEqual([
      ["p-1", "completed", "Implement the approved plan"],
      ["p-3", "processing", "Implement the plan now."],
      ["p-2", "queued", "Held follow-up"],
    ]);
    expect(getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID)[1]?.planContext).toMatchObject({
      planPromptId: "p-1",
      excerpt: "# Plan\n\nEdited implementation plan",
      artifactId: "plan-artifact-1",
      valid: true,
      missingReason: null,
      revision: 2,
      userEdited: true,
    });
    expect(getSandboxState(fakeState.storage.sql as unknown as SqlStorage, SID)?.pendingPromptDispatch).toBe(true);
    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "arcanist.plan_mode.approved", sessionId: SID, revision: 2 }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "arcanist.plan_mode.time_to_approval", sessionId: SID }),
    );
  });

  it("replaces the planning-only request with an implementation instruction after approval", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    fakeState.storage.sql.exec(
      "UPDATE prompts SET prompt_text = ? WHERE session_id = ? AND prompt_id = ?",
      "Plan the README change. Do not edit files yet.",
      SID,
      "p-1",
    );
    fakeState.storage.sql.exec("UPDATE sandbox_state SET status = 'spawning' WHERE session_id = ?", SID);

    const response = await instance.fetch(approveRequest(2));

    expect(response.status).toBe(200);
    const implementationPrompt = getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID).find(
      (prompt) => prompt.planContext?.planPromptId === "p-1",
    );
    expect(implementationPrompt?.prompt).toBe("Implement the plan now.");
  });

  it("rejects a stale revision without mutating the parked queue", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);

    const response = await instance.fetch(approveRequest(1));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "stale_revision" });
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)?.status).toBe("pending");
    expect(getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID).map((prompt) => prompt.promptId)).toEqual([
      "p-1",
      "p-2",
    ]);
  });

  it("rejects approval while a discuss turn is running", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    fakeState.storage.sql.exec(
      "UPDATE prompts SET status = 'processing', is_plan_prompt = 1 WHERE prompt_id = ?",
      "p-2",
    );

    const response = await instance.fetch(approveRequest(2));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "discuss_turn_running" });
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)?.status).toBe("pending");
  });

  it("supersedes queued discuss turns but preserves ordinary held follow-ups", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    fakeState.storage.sql.exec("UPDATE prompts SET is_plan_prompt = 1 WHERE prompt_id = ?", "p-2");
    seedPrompt(fakeState.storage, {
      sessionId: SID,
      promptId: "p-4",
      promptText: "Ordinary held follow-up",
      actorUserId: "7",
      status: "queued",
      queuePosition: 2,
    });
    updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, SID, { promptCounter: 4 });
    fakeState.storage.sql.exec("UPDATE sandbox_state SET status = 'spawning' WHERE session_id = ?", SID);

    const response = await instance.fetch(approveRequest(2));

    expect(response.status).toBe(200);
    const prompts = getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID);
    expect(prompts.find((prompt) => prompt.promptId === "p-2")).toMatchObject({
      status: "failed",
      error: "Superseded by plan approval",
    });
    expect(prompts.find((prompt) => prompt.promptId === "p-4")?.status).toBe("queued");
    expect(prompts.filter((prompt) => prompt.planContext?.planPromptId === "p-1")).toHaveLength(1);
  });

  it("returns an idempotent success for the same approved revision without duplicating implementation", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    fakeState.storage.sql.exec("UPDATE sandbox_state SET status = 'spawning' WHERE session_id = ?", SID);

    expect((await instance.fetch(approveRequest(2))).status).toBe(200);
    const replay = await instance.fetch(approveRequest(2));

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ ok: true, revision: 2, idempotent: true });
    expect(
      getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID).filter(
        (prompt) => prompt.planContext?.planPromptId === "p-1",
      ),
    ).toHaveLength(1);
  });

  it("rejects approval when the latest plan is not parked", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState, { planStatus: "superseded" });

    const response = await instance.fetch(approveRequest(2));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "plan_not_pending" });
  });

  it("keeps the approval commit durable and retries post-commit dispatch on idempotent replay", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedApprovalScenario(fakeState);
    const spawn = vi
      .spyOn(instance, "startSpawnAttempt")
      .mockRejectedValueOnce(new Error("injected post-commit dispatch failure"))
      .mockResolvedValueOnce("spawn-attempt-2");

    await expect(instance.fetch(approveRequest(2))).rejects.toThrow("injected post-commit dispatch failure");
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)).toMatchObject({
      status: "approved",
      implementationPromptId: "p-3",
    });
    expect(getSandboxState(fakeState.storage.sql as unknown as SqlStorage, SID)?.pendingPromptDispatch).toBe(true);

    const replay = await instance.fetch(approveRequest(2));

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true, implementationPromptId: "p-3" });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(
      getPrompts(fakeState.storage.sql as unknown as SqlStorage, SID).filter(
        (prompt) => prompt.planContext?.planPromptId === "p-1",
      ),
    ).toHaveLength(1);
  });

  it("fires the dedicated deadline through idle pause with the captured sandbox/activity fences", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    const parkedAt = Date.now() - 5 * 60_000;
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() - 1,
      parkedAt,
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });
    const pause = vi.spyOn(instance, "pauseE2BRuntimeForIdle").mockResolvedValue(true);

    await instance.fireDuePlanParkPause(SID);

    expect(pause).toHaveBeenCalledWith(SID, "sb-1", parkedAt, SandboxIdlePauseReason.PLAN_APPROVAL_PARK);
    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("cancels the park deadline and reprojects the shared alarm", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() + 300_000,
      parkedAt: Date.now(),
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });

    await instance.cancelPlanParkPause();

    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("exposes the later approval release seam that cancels park and notification deadlines", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() + 300_000,
      parkedAt: Date.now(),
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });
    await fakeState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      planPromptId: "p-1",
      attempts: 1,
      status: "pending",
      nextAttemptAt: Date.now() + 30_000,
    });
    fakeState.storage.sql.exec(
      "UPDATE session_plans SET status = 'approved' WHERE session_id = ? AND plan_prompt_id = ?",
      SID,
      "p-1",
    );

    await instance.releasePlanApprovalPark(SID, "unknown");

    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("archive terminalizes the pending plan and clears park delivery state", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() + 300_000,
      parkedAt: Date.now(),
      planPromptId: "p-1",
      runtimeSandboxId: null,
    });
    await fakeState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      planPromptId: "p-1",
      attempts: 1,
      status: "pending",
      nextAttemptAt: Date.now() + 30_000,
    });

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_closed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(
      fakeState.storage.sql
        .exec("SELECT status FROM session_plans WHERE session_id = ? AND plan_prompt_id = ?", SID, "p-1")
        .toArray()[0]?.status,
    ).toBe("superseded");
    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toBeUndefined();
    await fakeState.flushWaitUntil();
    expect(mockSupersedePlanApprovalInteractionRequests).toHaveBeenCalledWith(expect.anything(), SID, "archived", {
      planMarkdown: null,
    });
  });

  it("tolerates an idle-pause provider failure and consumes the one-shot deadline", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() - 1,
      parkedAt: Date.now() - 300_000,
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });
    vi.spyOn(instance, "pauseE2BRuntimeForIdle").mockResolvedValue(false);

    await expect(instance.fireDuePlanParkPause(SID)).resolves.toBeUndefined();
    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("rehydrates the deadline from storage after DO eviction", async () => {
    const fakeState = createFakeState();
    seedPendingPlan(fakeState);
    const deadlineAt = Date.now() + 300_000;
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt,
      parkedAt: Date.now(),
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });

    const rehydrated = new workerModule.SessionDO(fakeState, createTestEnv());
    await rehydrated.rescheduleSessionAlarm();

    await expect(fakeState.storage.getAlarm()).resolves.toBe(deadlineAt);
  });

  it("keeps authoritative Discuss supersession cleared after DO eviction even if the mirror is stale", async () => {
    const db = createMigratedD1();
    await insertPrCoordination(db, { ...buildGenesisRecord(SID, Date.now()), state: "AWAITING_INPUT" });
    const env = { ...createTestEnv(), DB: db };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env);
    seedPendingPlan(fakeState);
    seedPrompt(fakeState.storage, {
      sessionId: SID,
      promptId: "p-1",
      promptText: "Original task",
      actorUserId: "7",
      status: "completed",
      queuePosition: 0,
      completedAt: Date.now() - 1_000,
    });
    updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, SID, { promptCounter: 1 });
    await fakeState.storage.put(PLAN_APPROVAL_PENDING_STORAGE_KEY, 1);
    vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("discuss-spawn-attempt");
    vi.spyOn(instance, "persistAndBroadcastSessionStatus").mockResolvedValue("running");

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Revise step two", actorUserId: "7" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)?.status).toBe("superseded");
    expect((await getPrCoordination(db, SID))?.state).toBe("GENERATING");

    // Model a stale hot mirror surviving while the DO instance is evicted. Rehydrate
    // must trust session_plans, clear the mirror, and never re-park the session.
    await fakeState.storage.put(PLAN_APPROVAL_PENDING_STORAGE_KEY, 1);
    const rehydrated = new workerModule.SessionDO(fakeState, env);
    await rehydrated.reconcilePlanApprovalSpine(SID);

    expect(rehydrated.planApprovalPending).toBe(false);
    await expect(fakeState.storage.get(PLAN_APPROVAL_PENDING_STORAGE_KEY)).resolves.toBeUndefined();
    expect(getLatestSessionPlan(fakeState.storage.sql as unknown as SqlStorage, SID)?.status).toBe("superseded");
  });

  it("is a no-op when the runtime is already paused", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state
       SET runtime_provider = 'e2b', runtime_state = 'paused', runtime_sandbox_id = 'sb-1'
       WHERE session_id = ?`,
      SID,
    );
    await fakeState.storage.put(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY, {
      deadlineAt: Date.now() - 1,
      parkedAt: Date.now() - 300_000,
      planPromptId: "p-1",
      runtimeSandboxId: "sb-1",
    });

    await expect(instance.fireDuePlanParkPause(SID)).resolves.toBeUndefined();
    await expect(fakeState.storage.get(PLAN_PARK_PAUSE_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("persists PlanReady delivery state and retries a failed send on the bounded alarm seam", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    mockNotifyUserBlocked.mockResolvedValueOnce("failed").mockResolvedValueOnce("sent");

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });
    const afterFailure = await fakeState.storage.get<Record<string, unknown>>(PLAN_READY_DELIVERY_STORAGE_KEY);
    expect(afterFailure).toMatchObject({ planPromptId: "p-1", revision: 1, attempts: 1, status: "pending" });
    expect(mockNotifyUserBlocked).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "plan_ready", dedupKey: "p-1:1" }),
    );
    await fakeState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, { ...afterFailure, nextAttemptAt: Date.now() - 1 });

    await instance.fireDuePlanReadyDelivery(SID);

    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(2);
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedupKey: "p-1:1" }),
    );
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toMatchObject({
      planPromptId: "p-1",
      attempts: 2,
      status: "sent",
      nextAttemptAt: null,
    });
  });

  it("supersedes the outstanding button and re-delivers PlanReady when the plan is edited", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });
    mockNotifyUserBlocked.mockClear();

    // The PUT /plan handler bumps the authoritative row before invoking the hook.
    fakeState.storage.sql.exec(
      "UPDATE session_plans SET revision = 2, user_edited = 1 WHERE session_id = ? AND plan_prompt_id = ?",
      SID,
      "p-1",
    );
    // The supersede must complete BEFORE the replacement delivery notifies —
    // a deferred supersede can match the freshly minted interaction row and
    // dead-button the new Approve message. The Slack repaint, however, is
    // handed to ctx.waitUntil: a hanging chat.update must not block the edit.
    let supersedeSettled = false;
    mockSupersedePlanApprovalInteractionRequests.mockImplementationOnce(
      async (...args: [unknown, unknown, unknown, { deferSlackUpdates?: (work: Promise<void>) => void }?]) => {
        args[3]?.deferSlackUpdates?.(new Promise(() => {}));
        await new Promise((resolve) => setTimeout(resolve, 5));
        supersedeSettled = true;
      },
    );
    mockNotifyUserBlocked.mockImplementationOnce(async () => {
      expect(supersedeSettled).toBe(true);
      return "sent";
    });
    await instance.onPlanApprovalEdited({ sessionId: SID, planPromptId: "p-1", revision: 2 });

    expect(mockSupersedePlanApprovalInteractionRequests).toHaveBeenCalledWith(
      expect.anything(),
      SID,
      "edited",
      expect.objectContaining({ deferSlackUpdates: expect.any(Function) }),
    );
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "plan_ready", dedupKey: "p-1:2" }),
    );
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toMatchObject({
      planPromptId: "p-1",
      revision: 2,
      status: "sent",
    });
  });

  it("re-fires PlanReady for a re-parked Discuss revision with a fresh revision-scoped dedup key", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });
    fakeState.storage.sql.exec(
      "UPDATE session_plans SET status = 'superseded' WHERE session_id = ? AND plan_prompt_id = ?",
      SID,
      "p-1",
    );
    await instance.onPlanApprovalDiscussion({ sessionId: SID, planPromptId: "p-1", revision: 1, promptId: "p-2" });
    upsertSessionPlan(fakeState.storage.sql as unknown as SqlStorage, {
      sessionId: SID,
      planPromptId: "p-2",
      implementationPromptId: null,
      markdown: "# Plan\n\nRevised plan",
      excerpt: "# Plan\n\nRevised plan",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 2,
    });

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-2",
      revision: 2,
      valid: true,
      missingReason: null,
    });

    expect(mockNotifyUserBlocked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ dedupKey: "p-1:1" }),
    );
    expect(mockNotifyUserBlocked).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ dedupKey: "p-2:2" }),
    );
  });

  it("dedupes duplicate parks without resetting or re-sending the same plan revision", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    const park = {
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    } as const;
    await instance.onPlanApprovalParked(park);
    const firstState = await fakeState.storage.get<Record<string, unknown>>(PLAN_READY_DELIVERY_STORAGE_KEY);
    await instance.onPlanApprovalParked(park);

    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(1);
    expect(mockLogBlockedDmOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "skipped_duplicate_park",
      SID,
      "plan_ready",
      undefined,
    );
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toEqual(firstState);
  });

  it("does not race an in-flight first PlanReady delivery on a duplicate park", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    await fakeState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      planPromptId: "p-1",
      revision: 1,
      approvable: true,
      attempts: 0,
      status: "pending",
      nextAttemptAt: Date.now(),
    });

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });

    expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
  });

  it("logs stale and ownerless PlanReady delivery attempts", async () => {
    const staleState = createFakeState();
    const stale = new workerModule.SessionDO(staleState, createTestEnv());
    seedPendingPlan(staleState);
    await staleState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      planPromptId: "different-prompt",
      revision: 1,
      approvable: true,
      attempts: 0,
      status: "pending",
      nextAttemptAt: Date.now() - 1,
    });
    await stale.fireDuePlanReadyDelivery(SID);

    const ownerlessState = createFakeState();
    const ownerless = new workerModule.SessionDO(ownerlessState, createTestEnv());
    seedPendingPlan(ownerlessState);
    ownerlessState.storage.sql.exec("UPDATE session SET owner_user_id = 'not-an-owner' WHERE session_id = ?", SID);
    await ownerlessState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
      planPromptId: "p-1",
      revision: 1,
      approvable: true,
      attempts: 0,
      status: "pending",
      nextAttemptAt: Date.now() - 1,
    });
    await ownerless.fireDuePlanReadyDelivery(SID);

    expect(mockLogBlockedDmOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "skipped_stale_plan",
      SID,
      "plan_ready",
      undefined,
    );
    expect(mockLogBlockedDmOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "skipped_bad_owner",
      SID,
      "plan_ready",
      undefined,
    );
  });

  it("re-fires PlanReady when the same plan prompt parks at a new revision", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });
    fakeState.storage.sql.exec(
      "UPDATE session_plans SET revision = 2 WHERE session_id = ? AND plan_prompt_id = ?",
      SID,
      "p-1",
    );
    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 2,
      valid: true,
      missingReason: null,
    });

    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(2);
    expect(mockNotifyUserBlocked.mock.calls.map(([, args]) => args.dedupKey)).toEqual(["p-1:1", "p-1:2"]);
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toMatchObject({
      planPromptId: "p-1",
      revision: 2,
      status: "sent",
    });
  });

  it("bounds PlanReady delivery retries and leaves an exhausted durable state", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    seedPendingPlan(fakeState);
    mockNotifyUserBlocked.mockResolvedValue("failed");

    await instance.onPlanApprovalParked({
      sessionId: SID,
      planPromptId: "p-1",
      revision: 1,
      valid: true,
      missingReason: null,
    });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const delivery = await fakeState.storage.get<Record<string, unknown>>(PLAN_READY_DELIVERY_STORAGE_KEY);
      await fakeState.storage.put(PLAN_READY_DELIVERY_STORAGE_KEY, {
        ...delivery,
        nextAttemptAt: Date.now() - 1,
      });
      await instance.fireDuePlanReadyDelivery(SID);
    }

    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(3);
    await expect(fakeState.storage.get(PLAN_READY_DELIVERY_STORAGE_KEY)).resolves.toMatchObject({
      attempts: 3,
      status: "exhausted",
      nextAttemptAt: null,
    });
    await instance.fireDuePlanReadyDelivery(SID);
    expect(mockNotifyUserBlocked).toHaveBeenCalledTimes(3);
  });

  it("reconciles pending and stale-waiting spine states through applyEvent only", async () => {
    const db = createMigratedD1();
    await insertPrCoordination(db, { ...buildGenesisRecord(SID, Date.now()), state: "GENERATING" });
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, { ...createTestEnv(), DB: db });
    seedPendingPlan(fakeState);

    await instance.reconcilePlanApprovalSpine(SID);
    expect((await getPrCoordination(db, SID))?.state).toBe("AWAITING_INPUT");

    fakeState.storage.sql.exec(
      "UPDATE session_plans SET status = 'superseded' WHERE session_id = ? AND plan_prompt_id = ?",
      SID,
      "p-1",
    );
    await instance.reconcilePlanApprovalSpine(SID);
    expect((await getPrCoordination(db, SID))?.state).toBe("GENERATING");
  });
});
