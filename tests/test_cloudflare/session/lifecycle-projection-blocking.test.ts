/**
 * Tests for the lifecycle-blocking rich_status projection contract introduced
 * in PR "session phase projection sync".
 *
 * Contract under test (apps/control-plane-worker/README.md
 * "Projection write ownership"):
 *   1. Canonical lifecycle phase transitions await the rich_status UPDATE
 *      before broadcasting `session_status`.
 *   2. The UPDATE fails closed when no row matches
 *      (`MissingSessionIndexRowError`).
 *   3. The lastObservedPhase cache is seeded synchronously before any await
 *      so concurrent re-entry cannot fire duplicate drift checks.
 *   4. If DO-local state moves during the projection await, the stale frame
 *      is dropped instead of broadcast.
 *   5. Datadog drift egress is kept off the lifecycle critical path.
 *   6. Per-class fail-closed: propagate vs swallow + Sentry depending on
 *      caller class.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DriftCheckConfig,
  PhaseTransitionCause,
} from "../../../apps/control-plane-worker/src/observability/phase-metrics";
import { MissingSessionIndexRowError } from "../../../apps/control-plane-worker/src/services/session-projection.ts";
import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const mockResolveSlackBotTokenForCallback = vi.hoisted(() => vi.fn(async () => "xoxb-test-token"));

vi.mock("../../../apps/control-plane-worker/src/slack/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/tokens.ts")>();
  return {
    ...actual,
    resolveSlackBotTokenForCallback: mockResolveSlackBotTokenForCallback,
  };
});

vi.mock("../../../apps/control-plane-worker/src/slack/tokens.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/control-plane-worker/src/slack/tokens.ts")>();
  return {
    ...actual,
    resolveSlackBotTokenForCallback: mockResolveSlackBotTokenForCallback,
  };
});

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

interface LifecycleInternal {
  persistAndRecordSessionStatusFrame: (
    sessionId: string,
    cause?: PhaseTransitionCause,
    drift?: DriftCheckConfig,
  ) => Promise<{ richStatus: string }>;
  persistAndBroadcastSessionStatus: (sessionId: string, cause?: PhaseTransitionCause) => Promise<string>;
  persistRichStatusToD1: (sessionId: string, richStatus: string) => Promise<void>;
  finalizeSandboxStopped: (sessionId: string, options?: Record<string, unknown>) => Promise<string>;
  lastObservedPhase: Map<string, string>;
  broadcast: (message: Record<string, unknown>) => void;
}

interface ScriptedD1Statement {
  bind(...values: unknown[]): ScriptedD1Statement;
  run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }>;
  all(): Promise<{ results: Array<Record<string, unknown>> }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface ScriptedD1Options {
  persistedRichStatus?: string | null;
  /** When true, every UPDATE returns meta.changes = 0. */
  missingSessionIndexRow?: boolean;
  /** Holds the UPDATE; release with d1.releaseProjection() to unblock the await. */
  deferProjection?: boolean;
  /** Holds the drift SELECT; release with d1.releaseDriftSelect() to unblock it. */
  deferDriftSelect?: boolean;
  /** Make the UPDATE reject with a synthetic D1 error. */
  rejectProjection?: Error;
}

class ScriptedD1 {
  readonly queryLog: string[] = [];
  readonly updateRichStatuses: string[] = [];
  private releaseProjectionPromise: ((value: void) => void) | null = null;
  private projectionGate: Promise<void> | null = null;
  private releaseDriftSelectPromise: ((value: void) => void) | null = null;
  private driftSelectGate: Promise<void> | null = null;

  constructor(private readonly opts: ScriptedD1Options) {
    if (opts.deferProjection) {
      this.projectionGate = new Promise<void>((resolve) => {
        this.releaseProjectionPromise = resolve;
      });
    }
    if (opts.deferDriftSelect) {
      this.driftSelectGate = new Promise<void>((resolve) => {
        this.releaseDriftSelectPromise = resolve;
      });
    }
  }

  prepare(query: string): ScriptedD1Statement {
    const log = this.queryLog;
    const updateRichStatuses = this.updateRichStatuses;
    const opts = this.opts;
    const projectionGate = this.projectionGate;
    const driftSelectGate = this.driftSelectGate;
    const boundValues: unknown[] = [];
    return {
      bind(...values: unknown[]): ScriptedD1Statement {
        boundValues.splice(0, boundValues.length, ...values);
        return this;
      },
      async run() {
        log.push(`RUN:${query.slice(0, 80)}`);
        if (query.includes("UPDATE session_index SET rich_status")) {
          if (opts.rejectProjection) throw opts.rejectProjection;
          if (projectionGate) await projectionGate;
          updateRichStatuses.push(String(boundValues[0]));
          if (opts.missingSessionIndexRow) {
            return { success: true, meta: { last_row_id: 0, changes: 0 } };
          }
          return { success: true, meta: { last_row_id: 0, changes: 1 } };
        }
        return { success: true, meta: { last_row_id: 0, changes: 1 } };
      },
      async all() {
        log.push(`ALL:${query.slice(0, 80)}`);
        return { results: [] };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        log.push(`FIRST:${query.slice(0, 80)}`);
        if (query.includes("SELECT rich_status FROM session_index")) {
          if (driftSelectGate) await driftSelectGate;
          if (opts.persistedRichStatus === undefined) return null;
          return { rich_status: opts.persistedRichStatus } as T;
        }
        return null;
      },
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }

  releaseProjection(): void {
    this.releaseProjectionPromise?.();
    this.releaseProjectionPromise = null;
  }

  releaseDriftSelect(): void {
    this.releaseDriftSelectPromise?.();
    this.releaseDriftSelectPromise = null;
  }
}

function envWith(db: ScriptedD1): Record<string, unknown> {
  return {
    DB: db,
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
    DD_API_KEY: "dd-key",
  };
}

// Flush a generous number of microtask turns so the deferred-projection helper
// reaches its awaited rich_status UPDATE regardless of how many internal awaits
// the phase-projection seam introduces before it (e.g. the plan-approval mirror
// refresh added by the plan-gate). The ScriptedD1 projection gate stays closed,
// so extra turns never advance past the parked UPDATE — they only make the "has
// the UPDATE been issued yet" probe robust to the exact pre-write await count.
async function flushMicrotasks(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

const SESSION_ID = "lifecycle-blocking-session";

function buildInstance(opts: ScriptedD1Options): {
  internal: LifecycleInternal;
  db: ScriptedD1;
  fakeState: ReturnType<typeof createFakeState>;
  broadcasts: Array<Record<string, unknown>>;
} {
  const fakeState = createFakeState();
  const db = new ScriptedD1(opts);
  const env = envWith(db);
  const instance = new workerModule.SessionDO(fakeState, env);
  seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
  seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

  const broadcasts: Array<Record<string, unknown>> = [];
  const internal = instance as unknown as LifecycleInternal;
  // Capture broadcasts without touching the underlying WebSocket bookkeeping.
  internal.broadcast = (message) => {
    broadcasts.push(message);
  };
  return { internal, db, fakeState, broadcasts };
}

describe("lifecycle-blocking rich_status projection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockResolveSlackBotTokenForCallback.mockReset().mockResolvedValue("xoxb-test-token");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("does NOT broadcast session_status until the rich_status UPDATE has completed", async () => {
    const { internal, db, broadcasts } = buildInstance({ deferProjection: true, persistedRichStatus: "idle" });

    const broadcastPromise = internal.persistAndBroadcastSessionStatus(SESSION_ID, "active_prompt_started");

    // Settle pending microtasks. The helper should be parked on the awaited
    // UPDATE, which the ScriptedD1 deferred.
    await flushMicrotasks();
    expect(broadcasts, "no session_status frame should fan out until projection lands").toHaveLength(0);
    expect(db.queryLog.some((q) => q.startsWith("RUN:UPDATE session_index SET rich_status"))).toBe(true);

    db.releaseProjection();
    await broadcastPromise;
    const sessionStatusFrames = broadcasts.filter((m) => m.type === "session_status");
    expect(sessionStatusFrames.length, "session_status must fan out after projection lands").toBeGreaterThan(0);
  });

  it("seeds lastObservedPhase synchronously before any await", async () => {
    // The pre-await seed closes the reentrancy window: a concurrent
    // alarm/transport/socket event arriving during the projection await
    // must observe "already seeded" so it does not double-fire phase
    // transition telemetry. Drift checks are gated on the explicit
    // `drift.mode` parameter now, not on first observation, so this is a
    // pure cache-seed assertion.
    const { internal, db } = buildInstance({ deferProjection: true, persistedRichStatus: "running" });
    expect(internal.lastObservedPhase.has(SESSION_ID)).toBe(false);

    const first = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");
    expect(internal.lastObservedPhase.has(SESSION_ID)).toBe(true);

    const second = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event");

    db.releaseProjection();
    await Promise.all([first, second]);

    // Mutation callsites must never run the drift SELECT, regardless of
    // ordering. (The reconciliation-path test in
    // phase-drift-on-restart.test.ts covers the SELECT-before-UPDATE invariant.)
    const driftSelects = db.queryLog.filter((q) => q.startsWith("FIRST:SELECT rich_status FROM session_index"));
    expect(driftSelects, "mutation paths must not run drift-check SELECTs").toHaveLength(0);
  });

  it("writes exactly one projection matching local state for a non-racing call", async () => {
    const { internal, db } = buildInstance({ persistedRichStatus: "idle" });

    const frame = await internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");

    expect(db.updateRichStatuses).toEqual([frame.richStatus]);
  });

  it("skips a stale projection when local state advances before the D1 UPDATE", async () => {
    const { internal, db, fakeState } = buildInstance({
      deferDriftSelect: true,
      persistedRichStatus: "running",
    });

    const stalePromise = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event", {
      mode: "passive_reconciliation",
      source: "test_reconciliation_path",
    });
    await Promise.resolve();
    await Promise.resolve();

    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET status = ?, spawn_started_at = ? WHERE session_id = ?",
      "spawning",
      Date.now(),
      SESSION_ID,
    );
    const currentPromise = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");

    db.releaseDriftSelect();
    const [staleFrame, currentFrame] = await Promise.all([stalePromise, currentPromise]);

    expect(staleFrame.richStatus, "first invocation captured the pre-race state").toBe("idle");
    expect(currentFrame.richStatus, "second invocation sees the advanced local state").not.toBe(staleFrame.richStatus);
    expect(db.updateRichStatuses, "only the newer local-state value should be written").toEqual([
      currentFrame.richStatus,
    ]);
  });

  it("serializes in-flight projection UPDATEs so the newer value lands last", async () => {
    const { internal, db, fakeState } = buildInstance({
      deferProjection: true,
      persistedRichStatus: "idle",
    });

    const firstPromise = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event");
    await flushMicrotasks();
    expect(db.queryLog.filter((q) => q.startsWith("RUN:UPDATE session_index SET rich_status"))).toHaveLength(1);

    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET status = ?, spawn_started_at = ? WHERE session_id = ?",
      "spawning",
      Date.now(),
      SESSION_ID,
    );
    const secondPromise = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");
    await flushMicrotasks();

    expect(
      db.queryLog.filter((q) => q.startsWith("RUN:UPDATE session_index SET rich_status")),
      "second UPDATE must wait behind the in-flight first UPDATE",
    ).toHaveLength(1);

    db.releaseProjection();
    const [firstFrame, secondFrame] = await Promise.all([firstPromise, secondPromise]);

    expect(secondFrame.richStatus, "second invocation sees the advanced local state").not.toBe(firstFrame.richStatus);
    expect(db.updateRichStatuses, "the newer local-state value must be the final D1 write").toEqual([
      firstFrame.richStatus,
      secondFrame.richStatus,
    ]);
  });

  it("propagates rejection from persistAndBroadcastSessionStatus when the projection fails", async () => {
    const { internal, broadcasts } = buildInstance({ rejectProjection: new Error("synthetic D1 down") });

    await expect(internal.persistAndBroadcastSessionStatus(SESSION_ID, "active_prompt_started")).rejects.toThrow(
      "synthetic D1 down",
    );
    expect(
      broadcasts.filter((m) => m.type === "session_status"),
      "no broadcast on projection failure",
    ).toHaveLength(0);
  });

  it("surfaces MissingSessionIndexRowError when the UPDATE affects zero rows", async () => {
    const { internal, broadcasts } = buildInstance({ missingSessionIndexRow: true });

    await expect(internal.persistAndBroadcastSessionStatus(SESSION_ID, "active_prompt_started")).rejects.toBeInstanceOf(
      MissingSessionIndexRowError,
    );
    expect(
      broadcasts.filter((m) => m.type === "session_status"),
      "no broadcast when row is missing",
    ).toHaveLength(0);
  });

  it("finalizeSandboxStopped swallows projection rejection and preserves local sandbox cleanup", async () => {
    const { internal, broadcasts } = buildInstance({ rejectProjection: new Error("synthetic D1 down") });
    // Should resolve (not reject), returning an empty richStatus to signal
    // the projection was skipped while local cleanup proceeded.
    const result = await internal.finalizeSandboxStopped(SESSION_ID, { stopReason: "user", cause: "stop_requested" });
    expect(result).toBe("");
    expect(
      broadcasts.filter((m) => m.type === "session_status"),
      "no broadcast on projection failure",
    ).toHaveLength(0);
  });

  it("reconciliation path resolves even when the drift metric POST hangs (Datadog off critical path)", async () => {
    // Drift POSTs only fire on the explicit passive-reconciliation entry
    // point now. Assert that a hung Datadog POST still does not block the
    // reconciliation helper from resolving, because the POST is fired via
    // waitUntil.
    const { internal } = buildInstance({ persistedRichStatus: "running" });
    fetchSpy.mockImplementation(
      (url: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          if (String(url).includes("/api/v2/series")) {
            // Never resolves — but it's fired via waitUntil, so it must not
            // block the helper below.
            return;
          }
          resolve(new Response("{}", { status: 202 }));
        }),
    );

    const reconcilePromise = internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event", {
      mode: "passive_reconciliation",
      source: "test_reconciliation_path",
    });
    // The hung Datadog POST is fired via waitUntil, so the helper must resolve
    // without it. Asserting it resolves to a real status frame proves it didn't
    // block on the POST; if it ever blocks, Vitest's own test timeout fails this
    // (no load-sensitive race needed), and a rejection surfaces here directly.
    await expect(reconcilePromise).resolves.toBeDefined();
  });

  it("drops the broadcast when DO state moves during the projection await (stale-frame guard)", async () => {
    // Deferred projection so we can mutate local DO state while the UPDATE is
    // in flight. The stale-frame guard must then drop the broadcast — even
    // when only a phaseFieldsFromInfo field changes (e.g. sandboxSubstate
    // flips inside the same phase). richStatus alone would miss that.
    const { internal, db, broadcasts, fakeState } = buildInstance({
      deferProjection: true,
      persistedRichStatus: "idle",
    });

    const broadcastPromise = internal.persistAndBroadcastSessionStatus(SESSION_ID, "active_prompt_started");
    // Let the helper park on the awaited UPDATE.
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcasts, "no broadcast yet — UPDATE deferred").toHaveLength(0);

    // Move DO-local sandbox_state so the re-derived frame after the await no
    // longer matches the one that was persisted. Switching from "ready" to
    // "spawning" flips both richStatus AND sandboxSubstate, which exercises
    // the wider phaseFieldsFromInfo comparison. UPDATE rather than re-seed
    // because seedSandboxState INSERTs and the row already exists.
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET status = ?, spawn_started_at = ? WHERE session_id = ?",
      "spawning",
      Date.now(),
      SESSION_ID,
    );

    db.releaseProjection();
    await broadcastPromise;

    expect(
      broadcasts.filter((m) => m.type === "session_status"),
      "stale broadcast must be dropped — newer transition owns its own broadcast",
    ).toHaveLength(0);
  });

  it("updates Slack status cards when lifecycle reaches failed", async () => {
    const { internal, fakeState } = buildInstance({ persistedRichStatus: "running" });
    fakeState.storage.sql.exec("UPDATE session SET publish_status = ? WHERE session_id = ?", "failed", SESSION_ID);
    fakeState.storage.sql.exec(
      "UPDATE session SET callback_context_json = ? WHERE session_id = ?",
      JSON.stringify({
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
        statusMessageTs: "100.001",
      }),
      SESSION_ID,
    );

    await internal.persistAndBroadcastSessionStatus(SESSION_ID, "sandbox_transport_event");
    await fakeState.flushWaitUntil();

    expect(fetchSpy).toHaveBeenCalledWith("https://slack.com/api/chat.update", expect.any(Object));
    const body = JSON.parse((fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.channel).toBe("C123");
    expect(body.ts).toBe("100.001");
    expect(JSON.stringify(body.blocks)).toContain(":warning:");
    expect(JSON.stringify(body.blocks)).toContain("Failed");
    expect(body.text).toContain("Failed");
  });
});
