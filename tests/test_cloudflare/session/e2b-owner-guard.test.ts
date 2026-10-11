import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
  SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS,
} from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sandboxMock = vi.hoisted(() => ({
  kill: vi.fn(),
  pause: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  setTimeout: vi.fn(),
  getInfo: vi.fn(),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
}));

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
  };
};

type Instance = {
  alarm(): Promise<void>;
  fetch(request: Request): Promise<Response>;
};

const SESSION_ID = "owner-guard-session";
const CLEANUP_SECRET = "test-cleanup-secret";
const CLOUD = "e2b_cloud";
const NOW = 1_700_000_000_000;

// Records prepared SQL so the protect-path projection reconcile (an
// `UPDATE session_index ... runtime_sandbox_id = ?`) is observable; the default
// session-test FakeD1 is a silent no-op.
class RecordingD1 {
  readonly queries: Array<{ sql: string; binds: unknown[] }> = [];
  prepare(sql: string) {
    const self = this;
    const stmt = {
      _binds: [] as unknown[],
      bind(...values: unknown[]) {
        this._binds = values;
        return this;
      },
      async run() {
        self.queries.push({ sql, binds: this._binds });
        return { success: true as const, meta: { changes: 1 } };
      },
      async all() {
        return { results: [] as Array<Record<string, unknown>> };
      },
      async first() {
        return null;
      },
    };
    return stmt;
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    return Promise.all(statements.map((s) => s.run()));
  }
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...createTestEnv(),
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    SANDBOX_RUNTIME_CLEANUP_SECRET: CLEANUP_SECRET,
    ...overrides,
  };
}

function newInstance(env: Record<string, unknown>, workerModule: WorkerModule) {
  const state = createFakeState();
  const instance = new workerModule.SessionDO(state, env) as Instance & { sandboxWs: unknown | null };
  instance.sandboxWs = null;
  return { state, instance };
}

interface SeedRuntimeOpts {
  runtimeState?: "paused" | "running" | "killed" | null;
  sandboxId?: string | null;
  backend?: string;
  runtimeProvider?: string | null;
  sessionStatus?: string;
  seedTheSession?: boolean;
}

function seedRuntime(state: ReturnType<typeof createFakeState>, opts: SeedRuntimeOpts = {}) {
  if (opts.seedTheSession !== false) {
    seedSession(state.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: opts.sessionStatus ?? "active",
    });
  }
  seedSandboxState(state.storage, { sessionId: SESSION_ID, status: "running" });
  state.storage.sql.exec(
    `UPDATE sandbox_state SET
       runtime_provider = ?,
       runtime_state = ?,
       runtime_sandbox_id = ?,
       runtime_backend = ?
     WHERE session_id = ?`,
    opts.runtimeProvider === undefined ? "e2b" : opts.runtimeProvider,
    opts.runtimeState ?? null,
    opts.sandboxId === undefined ? "e2b-live" : opts.sandboxId,
    opts.backend ?? CLOUD,
    SESSION_ID,
  );
}

// ARC-1248: seed the bridge heartbeat the liveness guard reads from DO storage
// (`lifecycle:sandbox:state`). `ageMs` is how long ago the last beat was: a small
// positive value is fresh, a value past the reaper bound is stale, a negative
// value is a future-skewed clock, and `null` leaves the record absent (missing).
async function seedHeartbeat(state: ReturnType<typeof createFakeState>, ageMs: number | null): Promise<void> {
  if (ageMs === null) return;
  await state.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { lastHeartbeatAt: Date.now() - ageMs });
}

const FRESH_AGE_MS = 1_000; // 1s ago — well within the 5-min reaper bound
const STALE_AGE_MS = 6 * 60 * 1_000; // 6 min ago — past the 5-min reaper bound

async function callOwnerGuard(
  instance: Instance,
  body: {
    sessionId?: string;
    runtimeSandboxId?: string;
    runtimeBackend?: string;
    candidateE2bStatus?: string;
    sweepStartedAtMs?: number;
  },
  auth: string | null = `Bearer ${CLEANUP_SECRET}`,
): Promise<{
  status: number;
  decision?: string;
  reasonCode?: string;
  runtimeReadUnavailableKind?: string | null;
  runtimeReadUnavailableSweeps?: number | null;
}> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await instance.fetch(
    new Request("https://session.internal/internal/runtime/e2b/owner-guard", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: body.sessionId ?? SESSION_ID,
        runtimeSandboxId: body.runtimeSandboxId ?? "e2b-live",
        runtimeBackend: body.runtimeBackend ?? CLOUD,
        sweepStartedAtMs: body.sweepStartedAtMs ?? Date.now(),
        ...(body.candidateE2bStatus !== undefined ? { candidateE2bStatus: body.candidateE2bStatus } : {}),
      }),
    }),
  );
  if (res.status !== 200) return { status: res.status };
  const json = (await res.json()) as {
    decision: string;
    reasonCode: string;
    runtimeReadUnavailableKind?: string | null;
    runtimeReadUnavailableSweeps?: number | null;
  };
  return {
    status: res.status,
    decision: json.decision,
    reasonCode: json.reasonCode,
    runtimeReadUnavailableKind: json.runtimeReadUnavailableKind ?? null,
    runtimeReadUnavailableSweeps: json.runtimeReadUnavailableSweeps ?? null,
  };
}

describe("SessionDO E2B orphan owner guard", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ---- auth (fail closed) ----

  it("rejects a missing bearer token with 401", async () => {
    const { instance } = newInstance(createEnv(), workerModule);
    expect((await callOwnerGuard(instance, {}, null)).status).toBe(401);
  });

  it("rejects a wrong bearer token with 403", async () => {
    const { instance } = newInstance(createEnv(), workerModule);
    expect((await callOwnerGuard(instance, {}, "Bearer nope")).status).toBe(403);
  });

  it("returns 503 when the cleanup secret is not configured", async () => {
    const { instance } = newInstance(createEnv({ SANDBOX_RUNTIME_CLEANUP_SECRET: undefined }), workerModule);
    expect((await callOwnerGuard(instance, {}, "Bearer anything")).status).toBe(503);
  });

  // ---- protect (the desync fix) ----

  it("protects a live owned runtime and reconciles the session_index projection", async () => {
    const recordingDb = new RecordingD1();
    const env = createEnv({ DB: recordingDb });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live" });

    expect(result).toMatchObject({ status: 200, decision: "protect", reasonCode: "protected_owned" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    // The protect path re-projects the runtime from authoritative DO state,
    // closing the desync that left the live VM unreferenced.
    const reconcile = recordingDb.queries.find(
      (q) => q.sql.includes("UPDATE session_index") && q.sql.includes("runtime_sandbox_id"),
    );
    expect(reconcile).toBeTruthy();
    expect(reconcile?.binds).toContain("e2b-live");
  });

  // ---- terminate (true leftovers) ----

  it("defers a missing session read before terminating after the debounce", async () => {
    const { instance } = newInstance(createEnv(), workerModule);
    // No seedRuntime -> no session, no sandbox_state.
    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", sweepStartedAtMs: NOW + sweep });
      expect(result).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableKind: "session",
        runtimeReadUnavailableSweeps: sweep,
      });
    }

    const final = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(final).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_no_session",
      runtimeReadUnavailableKind: "session",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
  });

  it("defers a missing sandbox runtime read before applying the existing reclaim decision", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeProvider: null, runtimeState: null, sandboxId: null });
    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      const result = await callOwnerGuard(instance, {
        runtimeSandboxId: "e2b-live",
        candidateE2bStatus: "paused",
        sweepStartedAtMs: NOW + sweep,
      });
      expect(result).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableKind: "sandbox_runtime",
        runtimeReadUnavailableSweeps: sweep,
      });
    }

    const final = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      candidateE2bStatus: "paused",
      sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(final).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableKind: "sandbox_runtime",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
  });

  it("defers an unreadable sandbox backend before applying the existing reclaim decision", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    state.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_backend = ? WHERE session_id = ?",
      "legacy-e2b",
      SESSION_ID,
    );

    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", sweepStartedAtMs: NOW + sweep });
      expect(result).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableKind: "sandbox_backend",
        runtimeReadUnavailableSweeps: sweep,
      });
    }

    const final = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(final).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableKind: "sandbox_backend",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
  });

  it("terminates a superseded candidate when a newer runtime owns the row", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-new" });
    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-old" });
    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_superseded" });
  });

  it("terminates when the DO already marked the runtime killed", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live" });
    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_killed" });
  });

  it("terminates an owned runtime whose session is archived", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live", sessionStatus: "archived" });
    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live" });
    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_terminal" });
  });

  // ---- defer (fail closed for owned-but-not-running) ----

  it("defers an owned paused runtime but reconciles it so cleanup can expire it", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeState: "paused", sandboxId: "e2b-live" });
    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live" });
    expect(result).toMatchObject({ decision: "defer", reasonCode: "defer_reconciled" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    // The paused runtime is reconciled back into session_index (otherwise an
    // unreferenced paused VM is deferred every sweep and never expired).
    const reconcile = recordingDb.queries.find(
      (q) => q.sql.includes("UPDATE session_index") && q.sql.includes("runtime_sandbox_id"),
    );
    expect(reconcile?.binds).toContain("e2b-live");
  });

  it("rejects an invalid payload with 400", async () => {
    const { instance } = newInstance(createEnv(), workerModule);
    const res = await instance.fetch(
      new Request("https://session.internal/internal/runtime/e2b/owner-guard", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CLEANUP_SECRET}` },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ---- ARC-1248 liveness guard (proof-of-life via E2B status + heartbeat) ----

  function reconcileRan(db: RecordingD1): boolean {
    return db.queries.some((q) => q.sql.includes("UPDATE session_index") && q.sql.includes("runtime_sandbox_id"));
  }

  // The DO sandbox_state status, so a terminate's `discardStaleSandboxTransport`
  // teardown (status -> "stopped", stopReason "reaped" -> cold-resumable) is
  // observable. seedRuntime starts every runtime at "running", so a flip to
  // "stopped" proves the teardown ran.
  function querySandboxStatus(state: ReturnType<typeof createFakeState>): string | undefined {
    const rows = state.storage.sql.exec("SELECT status FROM sandbox_state WHERE session_id = ?", SESSION_ID).toArray();
    return rows[0]?.status as string | undefined;
  }

  // CHURN FIX: the observed incident. The DO marked the runtime killed (lease
  // lapse / transient disconnect) but the VM is physically running and beating.
  // The guard must NOT honor the bookkeeping kill.
  it("does NOT reap a killed-bookkeeping runtime that is physically running with a fresh heartbeat", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    await seedHeartbeat(state, FRESH_AGE_MS);

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "protect", reasonCode: "protected_owned" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    // Killed bookkeeping has no running row to reproject as healthy; the bridge
    // reconnect performs the real runtimeState heal. Protect-not-kill is the fix.
    expect(reconcileRan(recordingDb)).toBe(false);
  });

  // REGRESSION: the original desync fix still protects + reprojects a running,
  // owned, heartbeat-fresh runtime.
  it("protects and reprojects a running owned runtime with a fresh heartbeat", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    await seedHeartbeat(state, FRESH_AGE_MS);

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "protect", reasonCode: "protected_owned" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    expect(reconcileRan(recordingDb)).toBe(true);
  });

  // LEAK FIX (debounced): a running VM with a stale heartbeat is ambiguous, so it
  // defers (without reprojecting, so it stays a candidate) for K-1 sweeps, then is
  // reclaimed as a confirmed zombie on the Kth.
  it("defers a running-but-stale runtime, then reclaims it as a zombie after K sweeps", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    await seedHeartbeat(state, STALE_AGE_MS);

    for (let sweep = 1; sweep < SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS; sweep++) {
      const deferred = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });
      expect(deferred).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
    }
    // A stale candidate is never reprojected — it must stay unreferenced so the
    // next sweep can re-evaluate it (and the debounce can advance).
    expect(reconcileRan(recordingDb)).toBe(false);

    const final = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });
    expect(final).toMatchObject({ decision: "terminate", reasonCode: "terminate_zombie_confirmed" });
    expect(reconcileRan(recordingDb)).toBe(false);
    // §4: the terminate path tears the transport down as cold-resumable (status
    // -> "stopped"/reaped) so a false-positive zombie self-heals on the next prompt.
    expect(querySandboxStatus(state)).toBe("stopped");
  });

  // A fresh heartbeat mid-debounce resets the zombie counter (a live WS-dropped
  // builder re-beats), so it never reaches the zombie terminate. The counter is
  // first driven to K-1 so a BROKEN reset would cross the terminate threshold on
  // the final stale sweep — making this test discriminate a missing reset.
  it("resets the zombie debounce on a fresh heartbeat so a recovered VM is never reclaimed", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });

    // Drive the debounce to K-1: one stale sweep short of the zombie terminate.
    await seedHeartbeat(state, STALE_AGE_MS);
    for (let sweep = 1; sweep < SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS; sweep++) {
      const deferred = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });
      expect(deferred).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
    }

    // A fresh beat (the builder re-connected) must reset the counter to 0.
    await seedHeartbeat(state, FRESH_AGE_MS);
    const recovered = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });
    expect(recovered).toMatchObject({ decision: "protect", reasonCode: "protected_owned" });

    // Back to stale: with the reset this is sweep 1 of a fresh run → defer. Had
    // the reset NOT happened the counter would already be at K → terminate, so
    // this single assertion catches a broken reset.
    await seedHeartbeat(state, STALE_AGE_MS);
    const reStale = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });
    expect(reStale).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
  });

  // The other reset trigger (spec §3): a new runtime id restarts the debounce,
  // since the counter is keyed on runtimeSandboxId.
  it("resets the zombie debounce on a runtime-id change", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-old" });
    await seedHeartbeat(state, STALE_AGE_MS);

    // Accumulate K-1 stale sweeps against the OLD runtime id.
    for (let sweep = 1; sweep < SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS; sweep++) {
      await callOwnerGuard(instance, { runtimeSandboxId: "e2b-old", candidateE2bStatus: "running" });
    }

    // A new runtime takes the row (still stale). The counter is keyed on the
    // runtime id, so it restarts from 1 — a single stale sweep on the NEW id
    // defers, not terminates (which it would if the old count carried over).
    state.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_sandbox_id = ? WHERE session_id = ?",
      "e2b-new",
      SESSION_ID,
    );
    const onNewId = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-new", candidateE2bStatus: "running" });
    expect(onNewId).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
  });

  // FAIL-SAFE: a missing heartbeat must not kill on the strength of an absent beat.
  it("defers (never kills) a running runtime with a missing heartbeat", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    // No heartbeat seeded — missing.

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  // Review doc (ChatGPT/Greptile): a persistently absent beat is treated like a
  // stale one — one sweep defers (never reaps on a single absent beat), but K
  // consecutive missing-beat sweeps reclaim a dead-bridge VM as a zombie. The
  // debounce resets the instant any beat lands, so a transiently-null-but-alive VM
  // never reaches K; only a bridge that NEVER beats for K sweeps is reclaimed.
  it("reclaims a running runtime with a persistently missing heartbeat after K sweeps", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    // No heartbeat ever seeded — lastHeartbeatAt stays null across every sweep.

    for (let sweep = 1; sweep < SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS; sweep++) {
      expect(
        await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" }),
      ).toMatchObject({ decision: "defer", reasonCode: "defer_unproven_liveness" });
    }
    expect(
      await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" }),
    ).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_zombie_confirmed",
    });
  });

  // FAIL-SAFE: a future-skewed clock protects rather than kills (signed compare,
  // not the Math.abs `fresh` flag).
  it("protects (never kills) a running runtime with a future-skewed heartbeat", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    await seedHeartbeat(state, -(10 * 60 * 1_000)); // 10 min in the future

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "protect", reasonCode: "protected_owned" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  // PAUSED RECLAIM (DISOWNED branch only): a physically paused VM the DO has
  // disowned (here: marked killed) is not in active use — reclaim it.
  it("reclaims a physically paused DISOWNED runtime as terminate_paused_unreferenced", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    await seedHeartbeat(state, FRESH_AGE_MS); // even a fresh beat does not save a disowned paused VM

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "paused" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_paused_unreferenced" });
    // §4: the reclaim tears the transport down as cold-resumable before the kill.
    expect(querySandboxStatus(state)).toBe("stopped");
  });

  // OWNED-RUNNING branch + paused: E2B idle-paused the DO's own running runtime
  // out of band. It is warm-resumable, so the reaper must PROTECT it (the pre-
  // ARC-1248 behavior), NOT destroy it and force a cold resume.
  it("protects (does not reap) an owned running runtime that E2B idle-paused", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    await seedHeartbeat(state, STALE_AGE_MS); // heartbeat is irrelevant on the paused branch

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "paused" });

    expect(result).toMatchObject({ decision: "protect", reasonCode: "protected_owned" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    // Protected, not torn down — the warm VM survives for a fast resume.
    expect(querySandboxStatus(state)).toBe("running");
    // The owned-running protect path reprojects (closing the desync).
    expect(reconcileRan(recordingDb)).toBe(true);
  });

  // W11-B2: a null runtime read must not be rescued by heartbeat/liveness data on
  // the first sweep. The reaper skips with an attributable reason, then only
  // reclaims after repeated null reads.
  it("defers an unreferenced-bookkeeping runtime with a fresh heartbeat before the null-read debounce expires", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeProvider: null, runtimeState: null, sandboxId: null });
    await seedHeartbeat(state, FRESH_AGE_MS);

    const result = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      candidateE2bStatus: "running",
      sweepStartedAtMs: NOW + 1,
    });

    expect(result).toMatchObject({
      decision: "defer",
      reasonCode: "defer_runtime_read_unavailable",
      runtimeReadUnavailableKind: "sandbox_runtime",
      runtimeReadUnavailableSweeps: 1,
    });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  // UNREFERENCED branch: the null-read debounce itself is the fail-closed guard
  // against one bad read. After K distinct sweeps still cannot read a runtime, the
  // existing bookkeeping reclaim reason is allowed so true leftovers do not leak.
  it("reclaims an unreferenced-bookkeeping runtime after the null-read debounce", async () => {
    const recordingDb = new RecordingD1();
    const { state, instance } = newInstance(createEnv({ DB: recordingDb }), workerModule);
    seedRuntime(state, { runtimeProvider: null, runtimeState: null, sandboxId: null });
    await seedHeartbeat(state, STALE_AGE_MS);

    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      const deferred = await callOwnerGuard(instance, {
        runtimeSandboxId: "e2b-live",
        candidateE2bStatus: "running",
        sweepStartedAtMs: NOW + sweep,
      });
      expect(deferred).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableSweeps: sweep,
      });
    }
    const final = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      candidateE2bStatus: "running",
      sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(final).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableKind: "sandbox_runtime",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(reconcileRan(recordingDb)).toBe(false);
  });

  it("does not advance the null-read debounce twice within the same sweep tick", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeProvider: null, runtimeState: null, sandboxId: null });

    const first = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      candidateE2bStatus: "running",
      sweepStartedAtMs: NOW + 1,
    });
    const duplicate = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      candidateE2bStatus: "running",
      sweepStartedAtMs: NOW + 1,
    });

    expect(first).toMatchObject({ decision: "defer", runtimeReadUnavailableSweeps: 1 });
    expect(duplicate).toMatchObject({ decision: "defer", runtimeReadUnavailableSweeps: 1 });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  it("keeps null-read debounce counters scoped by unavailable-read kind", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);

    const missingSession = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      sweepStartedAtMs: NOW + 1,
    });
    expect(missingSession).toMatchObject({
      decision: "defer",
      reasonCode: "defer_runtime_read_unavailable",
      runtimeReadUnavailableKind: "session",
      runtimeReadUnavailableSweeps: 1,
    });

    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live" });
    state.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_backend = ? WHERE session_id = ?",
      "legacy-e2b",
      SESSION_ID,
    );

    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      const backendUnavailable = await callOwnerGuard(instance, {
        runtimeSandboxId: "e2b-live",
        sweepStartedAtMs: NOW + 1 + sweep,
      });
      expect(backendUnavailable).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableKind: "sandbox_backend",
        runtimeReadUnavailableSweeps: sweep,
      });
    }

    const final = await callOwnerGuard(instance, {
      runtimeSandboxId: "e2b-live",
      sweepStartedAtMs: NOW + 1 + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(final).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableKind: "sandbox_backend",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
  });

  // A flaky listing (`unknown`) must not change behavior — fall through to the
  // bookkeeping terminate.
  it("falls through to bookkeeping when the physical status is unknown", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    await seedHeartbeat(state, FRESH_AGE_MS); // fresh beat is ignored when status is unknown

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "unknown" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_killed" });
  });

  // The kill switch reverts to the pure-bookkeeping decision.
  it("reverts to the pure-bookkeeping decision when the guard is disabled", async () => {
    const { state, instance } = newInstance(createEnv({ E2B_ORPHAN_REAPER_LIVENESS_GUARD: "0" }), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    await seedHeartbeat(state, FRESH_AGE_MS); // physically running + fresh, but guard off

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_killed" });
  });

  // The superseded branch is NOT gated — a newer runtime genuinely owns the row.
  it("does not gate the superseded branch", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-new" });
    await seedHeartbeat(state, FRESH_AGE_MS);

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-old", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_superseded" });
  });

  // The archived branch is NOT gated — the session is terminal.
  it("does not gate the archived branch", async () => {
    const { state, instance } = newInstance(createEnv(), workerModule);
    seedRuntime(state, { runtimeState: "running", sandboxId: "e2b-live", sessionStatus: "archived" });
    await seedHeartbeat(state, FRESH_AGE_MS);

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_terminal" });
  });

  // Review fix (ChatGPT): archived is terminal and checked BEFORE the gated
  // branches, so an archived session whose runtime was marked killed (or cleared)
  // but is still physically running + heartbeating must terminate (terminal), not
  // be protected/deferred by the gate.
  it("terminates an archived session before the liveness gate (killed sandbox, running candidate)", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live", sessionStatus: "archived" });
    await seedHeartbeat(state, FRESH_AGE_MS); // a fresh beat must NOT protect a terminal session

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "running" });

    expect(result).toMatchObject({ decision: "terminate", reasonCode: "terminate_terminal" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  // CAS race: sandbox_state identity moves between the gate decision and the
  // terminate re-read → defer rather than tear down a runtime that just changed.
  it("defers (defer_state_changed) when sandbox_state moves between the decision and the terminate re-read", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    // Disowned (killed) + paused -> the reclaim terminate path (hasOwnedRow=true,
    // so it CAS-re-reads). The terminate path reads the zombie-counter key
    // (clearReaperZombieSweeps) right before the CAS re-read; hook that read to
    // land a newer sandbox id first, simulating a concurrent attach.
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    const originalGet = state.storage.get.bind(state.storage);
    let mutated = false;
    state.storage.get = (async (keyOrKeys: string | string[]) => {
      if (!mutated && keyOrKeys === LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY) {
        mutated = true;
        state.storage.sql.exec(
          "UPDATE sandbox_state SET runtime_sandbox_id = ? WHERE session_id = ?",
          "e2b-superseded",
          SESSION_ID,
        );
      }
      return originalGet(keyOrKeys as never);
    }) as typeof state.storage.get;

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "paused" });

    expect(result).toMatchObject({ decision: "defer", reasonCode: "defer_state_changed" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  it("defers as state-changed when the backend becomes invalid before the terminate CAS re-read", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeState: "killed", sandboxId: "e2b-live" });
    const originalGet = state.storage.get.bind(state.storage);
    let mutated = false;
    state.storage.get = (async (keyOrKeys: string | string[]) => {
      if (!mutated && keyOrKeys === LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY) {
        mutated = true;
        state.storage.sql.exec(
          "UPDATE sandbox_state SET runtime_backend = ? WHERE session_id = ?",
          "legacy-e2b",
          SESSION_ID,
        );
      }
      return originalGet(keyOrKeys as never);
    }) as typeof state.storage.get;

    const result = await callOwnerGuard(instance, { runtimeSandboxId: "e2b-live", candidateE2bStatus: "paused" });

    expect(result).toMatchObject({ decision: "defer", reasonCode: "defer_state_changed" });
    expect(result.runtimeReadUnavailableKind).toBeNull();
    expect(result.runtimeReadUnavailableSweeps).toBeNull();
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  // W11-B2: two null-read leftovers of the SAME session route to the same DO;
  // their debounce counters must NOT collide.
  it("debounces multiple same-session unreferenced leftovers independently", async () => {
    const { state, instance } = newInstance(createEnv({ DB: new RecordingD1() }), workerModule);
    seedRuntime(state, { runtimeProvider: null, runtimeState: null, sandboxId: null });
    await seedHeartbeat(state, STALE_AGE_MS);
    const A = "e2b-leftover-a";
    const B = "e2b-leftover-b";

    // Interleave A,B across the first K-1 sweeps: each must keep deferring with
    // its own counter.
    for (let sweep = 1; sweep < SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS; sweep++) {
      expect(
        await callOwnerGuard(instance, {
          runtimeSandboxId: A,
          candidateE2bStatus: "running",
          sweepStartedAtMs: NOW + sweep,
        }),
      ).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableSweeps: sweep,
      });
      expect(
        await callOwnerGuard(instance, {
          runtimeSandboxId: B,
          candidateE2bStatus: "running",
          sweepStartedAtMs: NOW + sweep,
        }),
      ).toMatchObject({
        decision: "defer",
        reasonCode: "defer_runtime_read_unavailable",
        runtimeReadUnavailableSweeps: sweep,
      });
    }
    // Kth distinct sweep: each independently reaches the threshold and is
    // reclaimable (impossible under a colliding single-slot counter).
    expect(
      await callOwnerGuard(instance, {
        runtimeSandboxId: A,
        candidateE2bStatus: "running",
        sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
      }),
    ).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
    expect(
      await callOwnerGuard(instance, {
        runtimeSandboxId: B,
        candidateE2bStatus: "running",
        sweepStartedAtMs: NOW + SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
      }),
    ).toMatchObject({
      decision: "terminate",
      reasonCode: "terminate_unreferenced",
      runtimeReadUnavailableSweeps: SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS,
    });
  });
});
