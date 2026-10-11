// ARC-1330 (PR 36) — transport-reducer producer: reducer-decision → spine-event mapping.
//
// The PR-36 contract test: drive the REAL `reduceLifecycle` for each transport boundary event, then map
// its decisions through `mapLifecycleEventToFsmEvents` and assert the produced spine `FsmEvent`. Proves
// (a) the genuine-progress edges map to the right spine event, (b) staled/noop reducer decisions emit
// NOTHING (soundness — the shadow row must not move when legacy didn't), and (c) the deferred/transient
// events produce no emission. Plus a small integration leg driving `applyEvent` over a real migrated
// D1 (the Wave-1 createMigratedSqlite/asD1 idiom) to prove the producer's resolver + emissions actually
// advance the shadow `pr_coordination` row CREATED→PROVISIONING→GENERATING→FINALIZING→PUBLISHING.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEvent,
  noopSideEffectSink,
  noopWorklistSink,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  buildPlanAwaitingInputEmission,
  buildPlanUserInputEmission,
  buildPostexecDoneEmission,
  mapLifecycleEventToFsmEvents,
  transportShadowResolver,
} from "../../../apps/control-plane-worker/src/session/fsm/transport-producer";
import { defaultLifecycleConfig } from "../../../apps/control-plane-worker/src/session/lifecycle/deadlines";
import { reduceLifecycle } from "../../../apps/control-plane-worker/src/session/lifecycle/reducer";
import type { LifecycleEvent, LifecycleState } from "../../../apps/control-plane-worker/src/session/lifecycle/types";
import { createEmptyLifecycleState } from "../../../apps/control-plane-worker/src/session/lifecycle/types";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;
const CONFIG = defaultLifecycleConfig();

/** Drive the real reducer for `(state, event)`, then map → the spine emissions. */
function mapFromReducer(state: LifecycleState, event: LifecycleEvent) {
  const decisions = reduceLifecycle(state, event, CONFIG, NOW);
  return mapLifecycleEventToFsmEvents(event, decisions);
}

function withSandbox(over: Partial<LifecycleState["sandbox"]>): LifecycleState {
  const s = createEmptyLifecycleState();
  s.sandbox = { ...s.sandbox, ...over };
  return s;
}

function withPrompt(over: Partial<LifecycleState["prompt"]>): LifecycleState {
  const s = createEmptyLifecycleState();
  s.prompt = { ...s.prompt, ...over };
  return s;
}

describe("transport producer — reducer-decision → spine-event mapping (PR 36)", () => {
  it("sandbox.spawn_requested → sandbox.spawn_requested when the reducer launches a spawn", () => {
    const out = mapFromReducer(createEmptyLifecycleState(), {
      type: "sandbox.spawn_requested",
      startupAttemptId: "a1",
    });
    expect(out).toEqual([
      { event: { type: "sandbox.spawn_requested" }, metadata: { type: "sandbox.spawn_requested" }, actor: "transport" },
    ]);
  });

  it("sandbox.spawn_requested → nothing when the spawn circuit is open (reducer noop)", () => {
    const state = withSandbox({ spawnFailureCount: 3, lastSpawnFailureAt: NOW });
    const decisions = reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "a1" }, CONFIG, NOW);
    expect(decisions.every((d) => d.action === "noop")).toBe(true);
    expect(
      mapLifecycleEventToFsmEvents({ type: "sandbox.spawn_requested", startupAttemptId: "a1" }, decisions),
    ).toEqual([]);
  });

  it("sandbox.ws_connected → sandbox.ready (transport accepted)", () => {
    const out = mapFromReducer(withSandbox({ state: "spawning" }), {
      type: "sandbox.ws_connected",
      sandboxId: "sb-1",
    });
    expect(out).toEqual([
      { event: { type: "sandbox.ready" }, metadata: { type: "sandbox.ready" }, actor: "transport" },
    ]);
  });

  it("sandbox.spawn_failed → sandbox.spawn_failed (matched attempt), nothing when stale", () => {
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "sandbox.spawn_failed", startupAttemptId: "a1" }),
    ).toEqual([
      { event: { type: "sandbox.spawn_failed" }, metadata: { type: "sandbox.spawn_failed" }, actor: "transport" },
    ]);
    // Stale attempt → reducer noops → no emission.
    const stale = mapFromReducer(withSandbox({ startupAttemptId: "a1" }), {
      type: "sandbox.spawn_failed",
      startupAttemptId: "a2",
    });
    expect(stale).toEqual([]);
  });

  it("sandbox.liveness_expired → sandbox.liveness_expired, nothing when the sandbox is stale", () => {
    expect(
      mapFromReducer(withSandbox({ state: "ready", sandboxId: "sb-1" }), {
        type: "sandbox.liveness_expired",
        sandboxId: "sb-1",
      }),
    ).toEqual([
      {
        event: { type: "sandbox.liveness_expired" },
        metadata: { type: "sandbox.liveness_expired" },
        actor: "transport",
      },
    ]);
    const stale = mapFromReducer(withSandbox({ sandboxId: "sb-1" }), {
      type: "sandbox.liveness_expired",
      sandboxId: "sb-OTHER",
    });
    expect(stale).toEqual([]);
  });

  it("sandbox.reconnect_grace_expired → sandbox.death (the unexpected-teardown give-up)", () => {
    const out = mapFromReducer(withSandbox({ state: "reconnecting", sandboxId: "sb-1" }), {
      type: "sandbox.reconnect_grace_expired",
      sandboxId: "sb-1",
    });
    expect(out).toEqual([
      { event: { type: "sandbox.death" }, metadata: { type: "sandbox.death" }, actor: "transport" },
    ]);
  });

  it("prompt.enqueued → prompt.enqueued", () => {
    expect(mapFromReducer(createEmptyLifecycleState(), { type: "prompt.enqueued", promptId: "p1" })).toEqual([
      { event: { type: "prompt.enqueued" }, metadata: { type: "prompt.enqueued" }, actor: "transport" },
    ]);
  });

  it("prompt.terminal_received (success) → prompt.terminal{changes}", () => {
    const out = mapFromReducer(withPrompt({ phase: "running", promptId: "p1", sandboxId: "sb-1" }), {
      type: "prompt.terminal_received",
      promptId: "p1",
      sandboxId: "sb-1",
      errorCode: null,
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.terminal", outcome: "changes" },
        metadata: { type: "prompt.terminal", outcome: "changes" },
        actor: "transport",
      },
    ]);
  });

  it("prompt.terminal_received (error) → prompt.terminal{error} carrying the reducer's errorCode", () => {
    const out = mapFromReducer(withPrompt({ phase: "running", promptId: "p1", sandboxId: "sb-1" }), {
      type: "prompt.terminal_received",
      promptId: "p1",
      sandboxId: "sb-1",
      errorCode: "unknown",
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.terminal", outcome: "error", errorCode: "unknown", stoppedByUser: false },
        metadata: { type: "prompt.terminal", outcome: "error", errorCode: "unknown", stoppedByUser: false },
        actor: "transport",
      },
    ]);
  });

  it("prompt.terminal_received (corroborated user stop) → prompt.terminal{error, aborted, stoppedByUser}", () => {
    // The bridge encodes a user stop of an active prompt as errorCode "aborted" and the DO stamps
    // stoppedByUser from the terminal's error text; the spine event carries both so the transition
    // can route it to STOPPED instead of FAILED(codegen_error).
    const out = mapFromReducer(withPrompt({ phase: "running", promptId: "p1", sandboxId: "sb-1" }), {
      type: "prompt.terminal_received",
      promptId: "p1",
      sandboxId: "sb-1",
      errorCode: "aborted",
      stoppedByUser: true,
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.terminal", outcome: "error", errorCode: "aborted", stoppedByUser: true },
        metadata: { type: "prompt.terminal", outcome: "error", errorCode: "aborted", stoppedByUser: true },
        actor: "transport",
      },
    ]);
  });

  it("prompt.terminal_received (UNCORROBORATED abort) → stoppedByUser false (routes to the loud FAILED path)", () => {
    // classifyError text-matches (AbortError/cancelled), external session deletes, and failsafe aborts
    // also emit errorCode "aborted" — with no DO corroboration the emission must not read as a stop.
    const out = mapFromReducer(withPrompt({ phase: "running", promptId: "p1", sandboxId: "sb-1" }), {
      type: "prompt.terminal_received",
      promptId: "p1",
      sandboxId: "sb-1",
      errorCode: "aborted",
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.terminal", outcome: "error", errorCode: "aborted", stoppedByUser: false },
        metadata: { type: "prompt.terminal", outcome: "error", errorCode: "aborted", stoppedByUser: false },
        actor: "transport",
      },
    ]);
  });

  it("prompt.terminal_received → nothing when stale (precedence-merge / no phase move)", () => {
    // Active prompt already terminal with no new error → reducer noops (no phase persist).
    const out = mapFromReducer(withPrompt({ phase: "terminal", promptId: "p1", terminalErrorCode: null }), {
      type: "prompt.terminal_received",
      promptId: "p1",
      errorCode: null,
    });
    expect(out).toEqual([]);
  });

  it("prompt.running_inactivity_elapsed → prompt.max_duration_exceeded", () => {
    const out = mapFromReducer(withPrompt({ phase: "running", promptId: "p1" }), {
      type: "prompt.running_inactivity_elapsed",
      promptId: "p1",
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.max_duration_exceeded" },
        metadata: { type: "prompt.max_duration_exceeded" },
        actor: "transport",
      },
    ]);
  });

  it("prompt.startup_deadline_elapsed → prompt.terminal{error}", () => {
    const out = mapFromReducer(withPrompt({ phase: "dispatching", promptId: "p1", codexPromptSentAt: null }), {
      type: "prompt.startup_deadline_elapsed",
      promptId: "p1",
    });
    expect(out).toEqual([
      {
        event: { type: "prompt.terminal", outcome: "error" },
        metadata: { type: "prompt.terminal", outcome: "error" },
        actor: "transport",
      },
    ]);
  });

  it("transient / boundary / review-listening events → no transport emission", () => {
    const cases: LifecycleEvent[] = [
      { type: "sandbox.heartbeat_received", sandboxId: "sb-1" },
      { type: "prompt.running_keepalive", promptId: "p1", sandboxId: "sb-1", activeToolCall: false },
      { type: "prompt.sent_to_bridge", promptId: "p1", sandboxId: "sb-1" },
      { type: "prompt.abort_requested", promptId: "p1" },
      { type: "boundary.stop_finalize", stopReason: "user", reason: "test" },
      { type: "review_listening.entered", prUrl: "u", currentHeadSha: "h" },
    ];
    for (const event of cases) {
      const decisions = reduceLifecycle(createEmptyLifecycleState(), event, CONFIG, NOW);
      expect(mapLifecycleEventToFsmEvents(event, decisions)).toEqual([]);
    }
  });

  it("boundary.close_finalize[fsm_kill_verification] → session.archived — the verifier-kill close-out (F26, ARC-1470)", () => {
    const out = mapFromReducer(createEmptyLifecycleState(), {
      type: "boundary.close_finalize",
      reason: "fsm_kill_verification",
    });
    expect(out).toEqual([
      { event: { type: "session.archived" }, metadata: { type: "session.archived" }, actor: "transport" },
    ]);
  });

  it("boundary.close_finalize with terminal archive reasons → session.archived", () => {
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "session_archived" }),
    ).toEqual([{ event: { type: "session.archived" }, metadata: { type: "session.archived" }, actor: "transport" }]);
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "dashboard_archive" }),
    ).toEqual([{ event: { type: "session.archived" }, metadata: { type: "session.archived" }, actor: "transport" }]);
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "api_archive" }),
    ).toEqual([{ event: { type: "session.archived" }, metadata: { type: "session.archived" }, actor: "transport" }]);
  });

  it("boundary.close_finalize with non-terminal PR reasons or unknown reasons → no emission", () => {
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "pr_merged" }),
    ).toEqual([]);
    expect(
      mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "pr_closed" }),
    ).toEqual([]);
    expect(mapFromReducer(createEmptyLifecycleState(), { type: "boundary.close_finalize", reason: "test" })).toEqual(
      [],
    );
  });

  it("boundary.close_finalize[fsm_kill_verification] emits even when the transport sub-state is already archived (idempotent close-out)", () => {
    const s = createEmptyLifecycleState();
    s.sessionStatus = "archived";
    const out = mapFromReducer(s, { type: "boundary.close_finalize", reason: "fsm_kill_verification" });
    // ARCHIVED is a final terminal — applyEvent noops the re-delivery; the mapping must not gate on
    // reducer freshness or a genuinely-un-archived spine row could be missed.
    expect(out).toEqual([
      { event: { type: "session.archived" }, metadata: { type: "session.archived" }, actor: "transport" },
    ]);
  });

  it("transportShadowResolver guards are record-sourced for the stop fields (STOPPED re-prompt re-entry reads them)", () => {
    // The STOPPED — prompt.enqueued re-entry routes on pre_stop_state; the transport resolver must
    // surface the record's stop fields or a post-publish stop would always re-enter GENERATING.
    const rec = buildGenesisRecord("s-guards", NOW);
    const stopped = {
      ...rec,
      state: "STOPPED" as const,
      stopMode: "resumable" as const,
      preStopState: "REVIEW" as const,
    };
    expect(transportShadowResolver("s-guards").guards(stopped, { type: "prompt.enqueued" })).toMatchObject({
      sandboxAlive: true,
      stopMode: "resumable",
      preStopState: "REVIEW",
    });
    // Null record fields surface as undefined (the resume guard comment: absent ⇒ unhandled, never wrong).
    expect(transportShadowResolver("s-guards").guards(rec, { type: "prompt.enqueued" })).toMatchObject({
      sandboxAlive: true,
      stopMode: undefined,
      preStopState: undefined,
    });
  });

  it("buildPostexecDoneEmission carries hasChanges + promptIntendsChange on both event and metadata", () => {
    expect(buildPostexecDoneEmission(true, false)).toEqual({
      event: { type: "postexec.done", hasChanges: true, promptIntendsChange: false },
      metadata: { type: "postexec.done", hasChanges: true, promptIntendsChange: false },
      actor: "transport",
    });
    expect(buildPostexecDoneEmission(false, true).event).toEqual({
      type: "postexec.done",
      hasChanges: false,
      promptIntendsChange: true,
    });
  });

  it("builds plan approval wait/resume events through the transport producer", () => {
    expect(buildPlanAwaitingInputEmission()).toEqual({
      event: { type: "prompt.awaiting_input" },
      metadata: { type: "prompt.awaiting_input" },
      actor: "transport",
    });
    expect(buildPlanUserInputEmission()).toEqual({
      event: { type: "user.input" },
      metadata: { type: "user.input" },
      actor: "user",
    });
  });
});

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("transport producer — applyEvent integration over the shadow row (PR 36)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("drives the shadow pr_coordination row CREATED→PROVISIONING→GENERATING→FINALIZING→PUBLISHING", async () => {
    const sid = "sess-tx";
    await insertPrCoordination(db, buildGenesisRecord(sid, NOW));
    const deps = {
      db,
      env: { DD_API_KEY: undefined, WORKER_ENV: "test" },
      mode: "shadow" as const,
      now: () => NOW,
      resolver: transportShadowResolver(sid),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };

    const apply = (emission: ReturnType<typeof buildPostexecDoneEmission>) =>
      applyEvent(deps, { sessionId: sid, event: emission.event, metadata: emission.metadata, actor: emission.actor });

    // CREATED → PROVISIONING
    let r = await apply(
      mapFromReducer(createEmptyLifecycleState(), { type: "sandbox.spawn_requested", startupAttemptId: "a1" })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "PROVISIONING" });
    // PROVISIONING → GENERATING
    r = await apply(
      mapFromReducer(withSandbox({ state: "spawning" }), { type: "sandbox.ws_connected", sandboxId: "sb-1" })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "GENERATING" });
    // GENERATING → FINALIZING (successful prompt terminal)
    r = await apply(
      mapFromReducer(withPrompt({ phase: "running", promptId: "p1", sandboxId: "sb-1" }), {
        type: "prompt.terminal_received",
        promptId: "p1",
        sandboxId: "sb-1",
        errorCode: null,
      })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "FINALIZING" });
    // FINALIZING → PUBLISHING (postexec.done with a diff)
    r = await apply(buildPostexecDoneEmission(true, true));
    expect(r).toMatchObject({ outcome: "handled", to: "PUBLISHING" });

    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("PUBLISHING");
    expect(rec?.promptIntendsChange).toBe(true);
  });

  it("postexec.done with ¬hasChanges settles FINALIZING → ANSWERED_NO_PR", async () => {
    const sid = "sess-noprr";
    // Seed straight into FINALIZING.
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "FINALIZING" });
    const deps = {
      db,
      env: { DD_API_KEY: undefined, WORKER_ENV: "test" },
      mode: "shadow" as const,
      now: () => NOW,
      resolver: transportShadowResolver(sid),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };
    const e = buildPostexecDoneEmission(false, false);
    const r = await applyEvent(deps, { sessionId: sid, event: e.event, metadata: e.metadata, actor: e.actor });
    expect(r).toMatchObject({ outcome: "handled", to: "ANSWERED_NO_PR" });
  });

  it("ARC-1470 incident replay: transient error latches FAILED, retry enqueue recovers, close settles ARCHIVED", async () => {
    const sid = "sess-arc1470";
    // Seed straight into GENERATING (spawned + ready, verify prompt p-1 dispatched).
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "GENERATING" });
    const deps = {
      db,
      env: { DD_API_KEY: undefined, WORKER_ENV: "test" },
      mode: "shadow" as const,
      now: () => NOW,
      resolver: transportShadowResolver(sid),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };
    const apply = (emission: ReturnType<typeof buildPostexecDoneEmission>) =>
      applyEvent(deps, { sessionId: sid, event: emission.event, metadata: emission.metadata, actor: emission.actor });

    // p-1 hits a transient setup error (bridge execution_complete{success:false}) → FAILED/codegen_error.
    let r = await apply(
      mapFromReducer(withPrompt({ phase: "running", promptId: "p-1", sandboxId: "sb-1" }), {
        type: "prompt.terminal_received",
        promptId: "p-1",
        sandboxId: "sb-1",
        errorCode: "unknown",
      })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "FAILED" });
    expect((await getPrCoordination(db, sid))?.failureReason).toBe("codegen_error");

    // The platform retry (p-2) is enqueued on the live sandbox → quiet recovery to GENERATING (PR A edge).
    r = await apply(
      mapFromReducer(withPrompt({ phase: "terminal", promptId: "p-1", sandboxId: "sb-1" }), {
        type: "prompt.enqueued",
        promptId: "p-2",
      })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "GENERATING" });
    expect((await getPrCoordination(db, sid))?.failureReason).toBeNull();

    // p-2 completes (verdict delivered) → FINALIZING, then no-diff postexec settles ANSWERED_NO_PR.
    r = await apply(
      mapFromReducer(withPrompt({ phase: "running", promptId: "p-2", sandboxId: "sb-1" }), {
        type: "prompt.terminal_received",
        promptId: "p-2",
        sandboxId: "sb-1",
        errorCode: null,
      })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "FINALIZING" });
    r = await apply(buildPostexecDoneEmission(false, false));
    expect(r).toMatchObject({ outcome: "handled", to: "ANSWERED_NO_PR" });

    // fsm_kill_verification closes the child → boundary.close_finalize settles the spine to ARCHIVED.
    r = await apply(
      mapFromReducer(createEmptyLifecycleState(), {
        type: "boundary.close_finalize",
        reason: "fsm_kill_verification",
      })[0],
    );
    expect(r).toMatchObject({ outcome: "handled", to: "ARCHIVED" });

    // A re-delivered kill-close is an unhandled noop (ARCHIVED is final).
    r = await apply(
      mapFromReducer(createEmptyLifecycleState(), {
        type: "boundary.close_finalize",
        reason: "fsm_kill_verification",
      })[0],
    );
    expect(r).toMatchObject({ outcome: "unhandled" });
    expect((await getPrCoordination(db, sid))?.state).toBe("ARCHIVED");
  });
});
