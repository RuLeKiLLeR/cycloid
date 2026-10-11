/**
 * writeUsageToD1 emits a `sandbox_agent.usage_event` structured log so sandbox agent
 * inference spend is queryable in Datadog (ARC-1397). The load-bearing property is
 * idempotency: writeUsageToD1 fires for BOTH session_idle and execution_complete on the
 * same prompt, and the D1 write is upsert-idempotent -- but a log-derived spend metric
 * counts every line, so the emit must be deduped per prompt or the guardrail double-counts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertPromptUsage } from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedPrompt,
  seedSession,
} from "./helpers.ts";

// D1 write is pre-existing behavior; stub it so the test focuses on the emit + dedup and does
// not depend on the no-op session-test FakeD1 resolving a business id.
const insertUsageRecordMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../apps/control-plane-worker/src/session/usage-db", () => ({
  insertUsageRecord: insertUsageRecordMock,
}));

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response> };
};

type UsageDO = {
  log: { info: (...args: unknown[]) => void };
  state: { storage: { get(key: string): Promise<unknown> } };
  writeUsageToD1(sessionId: string, ownerUserId: string, promptId: string): Promise<void>;
};

const SESSION_ID = "usage-event-session";
const OWNER = "user-1";
const BUSINESS = "biz-1";

function newInstance(workerModule: WorkerModule) {
  const state = createFakeState();
  const instance = new workerModule.SessionDO(state, createTestEnv()) as unknown as UsageDO & {
    sandboxWs: unknown | null;
  };
  instance.sandboxWs = null;
  return { state, instance };
}

/** Cast the exec-only fake SQL surface to the SqlStorage shape the do-db seed helpers expect. */
function seedSql(storage: { sql: unknown }): SqlStorage {
  return storage.sql as unknown as SqlStorage;
}

function findUsageEvent(infoSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  const call = infoSpy.mock.calls.find((c: unknown[]) => {
    const payload = c[0] as Record<string, unknown> | undefined;
    return payload?.event === "sandbox_agent.usage_event";
  });
  return call ? ((call as unknown[])[0] as Record<string, unknown>) : undefined;
}

describe("writeUsageToD1 sandbox usage event log (ARC-1397)", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    insertUsageRecordMock.mockClear();
  });

  it("emits one usage event with the inference provider tag and spend fields for a nonzero-cost prompt", async () => {
    const { state, instance } = newInstance(workerModule);
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: OWNER, businessId: BUSINESS });
    // seedSession does not set the backend column; opencode inference bills Baseten.
    state.storage.sql.exec("UPDATE session SET agent_runtime_backend = ? WHERE session_id = ?", "opencode", SESSION_ID);
    seedPrompt(state.storage, { promptId: "p-1", sessionId: SESSION_ID, promptText: "hi", status: "completed" });
    upsertPromptUsage(seedSql(state.storage), "p-1", {
      promptId: "p-1",
      model: "moonshotai/Kimi-K2.7-Code",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 500,
      cacheWriteTokens: 60,
      totalCostUsd: 0.5,
    });

    const infoSpy = vi.spyOn(instance.log, "info");
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-1");

    expect(insertUsageRecordMock).toHaveBeenCalledTimes(1);
    const payload = findUsageEvent(infoSpy);
    expect(payload).toBeDefined();
    expect(payload).toMatchObject({
      event: "sandbox_agent.usage_event",
      version: 1,
      provider: "baseten",
      agentRuntimeBackend: "opencode",
      model: "moonshotai/Kimi-K2.7-Code",
      costUsdMicros: 500000,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 500,
      cacheWriteTokens: 60,
      totalTokens: 700,
      sessionId: SESSION_ID,
      promptId: "p-1",
      businessId: BUSINESS,
      ownerUserId: OWNER,
      source: "sandbox",
    });
  });

  it("does not re-emit when writeUsageToD1 fires twice for the same prompt (session_idle + execution_complete)", async () => {
    const { state, instance } = newInstance(workerModule);
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: OWNER, businessId: BUSINESS });
    seedPrompt(state.storage, { promptId: "p-1", sessionId: SESSION_ID, promptText: "hi", status: "completed" });
    upsertPromptUsage(seedSql(state.storage), "p-1", {
      promptId: "p-1",
      model: "gpt",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0.25,
    });

    const infoSpy = vi.spyOn(instance.log, "info");
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-1");
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-1");

    // D1 write is idempotent-by-upsert and fires both times; the log must not.
    expect(insertUsageRecordMock).toHaveBeenCalledTimes(2);
    const usageEvents = infoSpy.mock.calls.filter((c) => {
      const payload = (c as unknown[])[0] as Record<string, unknown> | undefined;
      return payload?.event === "sandbox_agent.usage_event";
    });
    expect(usageEvents).toHaveLength(1);
    expect(await instance.state.storage.get("usage_events_logged")).toEqual({ "p-1": true });
  });

  it("does not emit when persisting the dedup marker fails, and the retry emits exactly once", async () => {
    const { state, instance } = newInstance(workerModule);
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: OWNER, businessId: BUSINESS });
    seedPrompt(state.storage, { promptId: "p-1", sessionId: SESSION_ID, promptText: "hi", status: "completed" });
    upsertPromptUsage(seedSql(state.storage), "p-1", {
      promptId: "p-1",
      model: "gpt",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0.25,
    });

    const infoSpy = vi.spyOn(instance.log, "info");
    // First firing: the dedup put throws, so nothing must be emitted (persist-before-emit).
    const putSpy = vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("storage put failed"));
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-1");
    expect(findUsageEvent(infoSpy)).toBeUndefined();

    // Second firing: put succeeds, and the event is emitted exactly once (no double-count).
    putSpy.mockRestore();
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-1");
    const usageEvents = infoSpy.mock.calls.filter((c: unknown[]) => {
      const payload = c[0] as Record<string, unknown> | undefined;
      return payload?.event === "sandbox_agent.usage_event";
    });
    expect(usageEvents).toHaveLength(1);
  });

  it("emits nothing for a zero-cost prompt (early return)", async () => {
    const { state, instance } = newInstance(workerModule);
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: OWNER, businessId: BUSINESS });
    seedPrompt(state.storage, { promptId: "p-zero", sessionId: SESSION_ID, promptText: "hi", status: "completed" });
    upsertPromptUsage(seedSql(state.storage), "p-zero", {
      promptId: "p-zero",
      model: "gpt",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
    });

    const infoSpy = vi.spyOn(instance.log, "info");
    await instance.writeUsageToD1(SESSION_ID, OWNER, "p-zero");

    expect(insertUsageRecordMock).not.toHaveBeenCalled();
    expect(findUsageEvent(infoSpy)).toBeUndefined();
  });
});
