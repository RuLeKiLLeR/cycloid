/**
 * ARC-1330 — the no-signal advance deadline key's alarm() cleanup is retry-safe.
 *
 * The bounded `fsm_no_signal_advance_deadline` key drives a periodic CI poll for the no-expected-signal
 * cohort. The fire result owns the key's fate: re-arm while the PR remains in REVIEW/VERIFYING, delete
 * after a terminal/other state, and re-arm on transient faults so a flaky poll cannot orphan the advance
 * path. Exercised through the real DO `alarm()` tick with the advance FIRE mocked so its outcome is
 * deterministic.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_SIGNAL_ADVANCE_WINDOW_MS } from "../../../apps/control-plane-worker/src/constants/review-loop.ts";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY } from "../../../apps/control-plane-worker/src/session/fsm/no-signal-advance-producer.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

const mockFireDueNoSignalAdvance = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/session/fsm/no-signal-advance-producer.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../apps/control-plane-worker/src/session/fsm/no-signal-advance-producer.ts")
    >();
  return { ...actual, shadowFireDueNoSignalAdvance: mockFireDueNoSignalAdvance };
});

mockCloudflareWorkers();
mockSentryCloudflare();

describe("no-signal advance deadline cleanup (DO alarm wiring)", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let agent: InstanceType<typeof SessionDO>;

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFireDueNoSignalAdvance.mockResolvedValue({ ok: true, reArm: true, emitted: false, ciState: "pending" });
    state = createFakeState();
    env = { ...createTestEnv(), FSM_MODE: "shadow" };
    agent = new SessionDO(state as never, env as never);
    doDb.createSession(state.storage.sql, { sessionId: "s-1", ownerUserId: "1" });
  });

  function readNoSignalDeadline(): Promise<number | undefined> {
    return state.storage.get(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY) as Promise<number | undefined>;
  }

  it("re-arms a due no-signal advance key when the producer asks to continue", async () => {
    mockFireDueNoSignalAdvance.mockResolvedValue({ ok: true, reArm: true, emitted: false, ciState: "pending" });
    await state.storage.put(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY, Date.now() - 1_000);
    const before = Date.now();

    await agent.alarm();

    expect(mockFireDueNoSignalAdvance).toHaveBeenCalledTimes(1);
    const deadline = await readNoSignalDeadline();
    expect(deadline).toBeTypeOf("number");
    expect(deadline!).toBeGreaterThanOrEqual(before + NO_SIGNAL_ADVANCE_WINDOW_MS);
    expect(await state.storage.getAlarm()).toBeGreaterThan(before + NO_SIGNAL_ADVANCE_WINDOW_MS - 5_000);
  });

  it("deletes a due no-signal advance key when the producer stops", async () => {
    mockFireDueNoSignalAdvance.mockResolvedValue({ ok: true, reArm: false, emitted: false, ciState: null });
    await state.storage.put(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY, Date.now() - 1_000);

    await agent.alarm();

    expect(mockFireDueNoSignalAdvance).toHaveBeenCalledTimes(1);
    expect(await readNoSignalDeadline()).toBeUndefined();
  });

  it("does not poll no-signal advance before its key is due", async () => {
    const future = Date.now() + 10 * 60_000;
    await state.storage.put(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY, future);

    await agent.alarm();

    expect(mockFireDueNoSignalAdvance).not.toHaveBeenCalled();
    expect(await readNoSignalDeadline()).toBe(future);
  });

  // Standing-stock self-heal: a review-listening row published BEFORE the universal publish-time arm has
  // no deadline armed, so it never drains (the wedge). The alarm tick self-arms it once; the existing fire
  // machinery drains it thereafter. Proves the two dogfood sessions (both review-listening, active DOs)
  // get a carrier armed without any re-publish.
  it("self-arms a review-listening row that has no no-signal advance deadline (standing-stock heal)", async () => {
    doDb.updateSessionFields(state.storage.sql, "s-1", { reviewListeningActive: true });
    const before = Date.now();

    await agent.alarm();

    // A fresh future deadline is armed; the just-armed key is not yet due, so no poll fires this tick.
    const deadline = await readNoSignalDeadline();
    expect(deadline).toBeTypeOf("number");
    expect(deadline!).toBeGreaterThanOrEqual(before + NO_SIGNAL_ADVANCE_WINDOW_MS);
    expect(mockFireDueNoSignalAdvance).not.toHaveBeenCalled();
    expect(await state.storage.getAlarm()).toBeGreaterThan(before + NO_SIGNAL_ADVANCE_WINDOW_MS - 5_000);
  });

  it("does not self-arm a session that is not review-listening", async () => {
    await agent.alarm();

    expect(await readNoSignalDeadline()).toBeUndefined();
    expect(mockFireDueNoSignalAdvance).not.toHaveBeenCalled();
  });

  it("does not overwrite an already-armed deadline for a review-listening row (idempotent self-heal)", async () => {
    doDb.updateSessionFields(state.storage.sql, "s-1", { reviewListeningActive: true });
    const future = Date.now() + 10 * 60_000;
    await state.storage.put(FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY, future);

    await agent.alarm();

    expect(await readNoSignalDeadline()).toBe(future);
    expect(mockFireDueNoSignalAdvance).not.toHaveBeenCalled();
  });
});
