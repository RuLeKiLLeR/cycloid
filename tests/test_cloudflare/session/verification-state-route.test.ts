/**
 * Route handler tests for POST /session/verification/state.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import * as spineDoneMirror from "../../../apps/control-plane-worker/src/session/fsm/spine-done-mirror.ts";
import { QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY } from "../../../shared/types/qa-run.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

const mockSyncVerificationStateLabelsForPr = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../../apps/control-plane-worker/src/session/verification-state.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../apps/control-plane-worker/src/session/verification-state.ts")>();
  return {
    ...actual,
    syncVerificationStateLabelsForPr: mockSyncVerificationStateLabelsForPr,
  };
});

mockCloudflareWorkers();
mockSentryCloudflare();

const INTERNAL = "https://internal";

describe("POST /session/verification/state", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let agent: InstanceType<typeof SessionDO>;

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  beforeEach(() => {
    state = createFakeState();
    env = createTestEnv();
    agent = new SessionDO(state as never, env as never);
    mockSyncVerificationStateLabelsForPr.mockReset();
    doDb.createSession(state.storage.sql, { sessionId: "s-1", ownerUserId: "1" });
  });

  afterEach(() => vi.restoreAllMocks());

  function post(body: unknown): Request {
    return new Request(`${INTERNAL}/session/verification/state`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "s-1" },
      body: JSON.stringify(body),
    });
  }

  function postResult(body: unknown): Request {
    return new Request(`${INTERNAL}/session/verification/result`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "s-1" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing requestId with 400", async () => {
    const res = await agent.fetch(post({ state: "verification-in-progress" }));
    expect(res.status).toBe(400);
  });

  it("writes state, counters, broadcast, and returns updated:true", async () => {
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");

    const res = await agent.fetch(
      post({
        requestId: "r-1",
        state: "verification-in-progress",
        attemptCount: 2,
        maxAttempts: 3,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: true });

    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-in-progress");
    expect(ext.verificationAttemptCount).toBe(2);
    expect(ext.verificationMaxAttempts).toBe(3);
    // ARC-1330 D-59c: the D1 `qa_testing_state` mirror is written by `project()` from the spine, not by this
    // route; the route keeps the DO-SQLite copy + broadcasts.
    expect(broadcastSpy).toHaveBeenCalled();
    const message = broadcastSpy.mock.calls.at(-1)?.[0] as {
      type: string;
      session?: {
        verificationState?: unknown;
        verificationAttemptCount?: unknown;
        verificationMaxAttempts?: unknown;
      };
    };
    expect(message.type).toBe("subscribed");
    expect(message.session?.verificationState).toBe("verification-in-progress");
    expect(message.session?.verificationAttemptCount).toBe(2);
    expect(message.session?.verificationMaxAttempts).toBe(3);
  });

  it("returns updated:false when the state and counters are unchanged", async () => {
    await agent.fetch(
      post({
        requestId: "r-1",
        state: "verification-in-progress",
        attemptCount: 1,
        maxAttempts: 3,
      }),
    );
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");
    mockSyncVerificationStateLabelsForPr.mockClear();

    const res = await agent.fetch(
      post({
        requestId: "r-2",
        state: "verification-in-progress",
        attemptCount: 1,
        maxAttempts: 3,
      }),
    );
    expect(await res.json()).toEqual({ ok: true, updated: false });
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateLabelsForPr).not.toHaveBeenCalled();
  });

  it("does not sync PR labels when the PR-aware state update is unchanged", async () => {
    doDb.updateSessionFields(state.storage.sql, "s-1", {
      verificationState: "verification-in-progress",
      verificationAttemptCount: 1,
      verificationMaxAttempts: 3,
    });
    mockSyncVerificationStateLabelsForPr.mockClear();

    await (
      agent as unknown as {
        setCurrentSessionVerificationStateForPr(input: {
          sessionId: string;
          prUrl: string;
          state: "verification-in-progress";
          attemptCount: number;
          maxAttempts: number;
        }): Promise<void>;
      }
    ).setCurrentSessionVerificationStateForPr({
      sessionId: "s-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "verification-in-progress",
      attemptCount: 1,
      maxAttempts: 3,
    });

    expect(mockSyncVerificationStateLabelsForPr).not.toHaveBeenCalled();
  });

  it("keeps verification-exhausted terminal when a later update tries to demote it", async () => {
    await agent.fetch(
      post({
        requestId: "r-1",
        state: "verification-exhausted",
        attemptCount: 3,
        maxAttempts: 3,
      }),
    );
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");

    const res = await agent.fetch(
      post({
        requestId: "r-2",
        state: "verification-pending",
        attemptCount: 0,
        maxAttempts: 3,
      }),
    );
    expect(await res.json()).toEqual({ ok: true, updated: false });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-exhausted");
    expect(ext.verificationAttemptCount).toBe(3);
    expect(ext.verificationMaxAttempts).toBe(3);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  // ARC-1330 D-59c: the DO route no longer recomputes the cycloid_done aggregate (the deleted
  // `recomputeCycloidDoneStatus` fold — `project()` owns `cycloid_done` from the spine). The
  // exhaust → needs_attention projection is covered by the FSM projection tests (fsm/project*.test.ts).

  it("clears verification-exhausted on a null write when allowExhaustedClear is set (head change, ARC-1243)", async () => {
    await agent.fetch(post({ requestId: "r-1", state: "verification-exhausted", attemptCount: 3, maxAttempts: 3 }));

    const res = await agent.fetch(
      post({ requestId: "r-2", state: null, attemptCount: 0, maxAttempts: 3, allowExhaustedClear: true }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: true });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState ?? null).toBeNull();
  });

  it("still preserves verification-exhausted for a null write WITHOUT the bypass flag", async () => {
    await agent.fetch(post({ requestId: "r-1", state: "verification-exhausted", attemptCount: 3, maxAttempts: 3 }));

    const res = await agent.fetch(post({ requestId: "r-2", state: null, attemptCount: 0, maxAttempts: 3 }));

    expect(await res.json()).toEqual({ ok: true, updated: false });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-exhausted");
  });

  it("keeps the pending-demotion guard even when allowExhaustedClear is set", async () => {
    await agent.fetch(post({ requestId: "r-1", state: "verification-in-progress", attemptCount: 1, maxAttempts: 3 }));

    const res = await agent.fetch(
      post({
        requestId: "r-2",
        state: "verification-pending",
        attemptCount: 0,
        maxAttempts: 3,
        allowExhaustedClear: true,
      }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: false });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-in-progress");
  });

  it("still persists legacy verification run baseline fields when provided", async () => {
    const res = await agent.fetch(
      post({
        requestId: "r-1",
        state: null,
        attemptCount: 0,
        maxAttempts: 3,
        allowExhaustedClear: true,
        runBaseline: 4,
      }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: true });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationRunBaseline).toBe(4);
  });

  it("does not let a late pending demote an in-progress state (ARC-1219)", async () => {
    await agent.fetch(post({ requestId: "r-1", state: "verification-in-progress", attemptCount: 1, maxAttempts: 3 }));
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");

    const res = await agent.fetch(
      post({ requestId: "r-2", state: "verification-pending", attemptCount: 0, maxAttempts: 3 }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: false });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-in-progress");
    expect(ext.verificationAttemptCount).toBe(1);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("allows in-progress to replace a prior terminal state for a new run (ARC-1219)", async () => {
    await agent.fetch(post({ requestId: "r-1", state: "verification-done", attemptCount: 1, maxAttempts: 3 }));

    const res = await agent.fetch(
      post({ requestId: "r-2", state: "verification-in-progress", attemptCount: 2, maxAttempts: 3 }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: true });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationState).toBe("verification-in-progress");
    expect(ext.verificationAttemptCount).toBe(2);
  });

  it("stores terminal QA run metadata with verification results", async () => {
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");

    const res = await agent.fetch(
      postResult({
        requestId: "r-result-1",
        result: "needs-work",
        needsWorkLabel: "verification-gap",
        qaRun: {
          childSessionId: "qa-child",
          runId: 4,
          head: "verified-head",
          evidenceCount: 2,
          blockers: ["Runtime smoke failed."],
        },
      }),
    );

    expect(await res.json()).toEqual({ ok: true, updated: true });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationResult).toBe("needs-work");
    expect(ext.verificationNeedsWorkLabel).toBe("verification-gap");
    await expect(state.storage.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY)).resolves.toEqual({
      childSessionId: "qa-child",
      runId: 4,
      head: "verified-head",
      evidenceCount: 2,
      blockers: ["Runtime smoke failed."],
    });
    const message = broadcastSpy.mock.calls.at(-1)?.[0] as {
      type: string;
      session?: { qaRun?: unknown };
    };
    expect(message.type).toBe("subscribed");
    expect(message.session?.qaRun).toMatchObject({
      childSessionId: "qa-child",
      runId: 4,
      head: "verified-head",
      evidenceCount: 2,
      blockers: ["Runtime smoke failed."],
    });
  });

  it("clears stale terminal QA run metadata when the verification result resets", async () => {
    await agent.fetch(
      postResult({
        requestId: "r-result-1",
        result: "merge-ready",
        qaRun: {
          childSessionId: "qa-child",
          runId: 4,
          head: "verified-head",
          evidenceCount: 2,
          blockers: [],
        },
      }),
    );
    await expect(state.storage.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY)).resolves.toMatchObject({
      childSessionId: "qa-child",
    });

    const res = await agent.fetch(postResult({ requestId: "r-result-2", result: null }));

    expect(await res.json()).toEqual({ ok: true, updated: true });
    const ext = doDb.getSessionExtended(state.storage.sql, "s-1")!;
    expect(ext.verificationResult).toBeNull();
    await expect(state.storage.get(QA_RUN_TERMINAL_SUMMARY_STORAGE_KEY)).resolves.toBeUndefined();
  });

  // ARC-1330 D-59c+: the ARC-1322 sidebar feed delta emitted by `broadcastSessionSnapshot` must source
  // review-loop / cycloid-done from the spine (`resolveSpineDoneMirror` — the same read-path the /state
  // snapshot builders use), not the removed DO-SQLite copies.
  it("snapshot feed delta sources done-state from the spine", async () => {
    doDb.updateSessionFields(state.storage.sql, "s-1", {
      reviewListeningActive: true,
    });

    const deltas: Array<Record<string, unknown>> = [];
    vi.spyOn(
      agent as unknown as { publishFeedDelta: (delta: Record<string, unknown>) => void },
      "publishFeedDelta",
    ).mockImplementation((delta) => {
      deltas.push(delta);
    });

    const spineSpy = vi.spyOn(spineDoneMirror, "resolveSpineDoneMirror");
    const broadcast = (
      agent as unknown as { broadcastSessionSnapshot(sessionId: string): Promise<void> }
    ).broadcastSessionSnapshot.bind(agent);

    // Spine settles to a needs-attention verdict; the DO-SQLite copy still reads "working".
    spineSpy.mockResolvedValue({
      cycloidDone: { state: "done", outcome: "needs_attention", reasons: ["ci_red"] },
      reviewLoopDoneState: "done",
    });
    await broadcast("s-1");

    // Spine advances again to a clean success; the frozen copy has not (and cannot) move.
    spineSpy.mockResolvedValue({
      cycloidDone: { state: "done", outcome: "success", reasons: [] },
      reviewLoopDoneState: "done",
    });
    await broadcast("s-1");

    const snapshotDeltas = deltas.filter((delta) => delta.type === "verification" && delta.source === "snapshot");
    expect(snapshotDeltas).toHaveLength(2);
    expect(snapshotDeltas[0]).toMatchObject({
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
      cycloidDoneOutcome: "needs_attention",
      cycloidDoneReasons: ["ci_red"],
    });
    expect(snapshotDeltas[1]).toMatchObject({
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
      cycloidDoneOutcome: "success",
      cycloidDoneReasons: [],
    });
  });
});
