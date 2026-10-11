/**
 * Drift detection on passive reconciliation: when an alarm or reconnect-grace
 * cleanup path explicitly opts in (`drift.mode === "passive_reconciliation"`),
 * `persistAndRecordSessionStatusFrame` compares the just-derived phase
 * against the persisted `session_index.rich_status`. A mismatch fires
 * `postPhaseDriftMetric` so the Datadog monitor can alert before the
 * divergence spreads to UI/CLI consumers. Mutation callsites (the default)
 * MUST NOT fire drift — the column lagging behind a fresh transition is
 * by-design, not a problem.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DriftCheckConfig,
  PhaseTransitionCause,
} from "../../../apps/control-plane-worker/src/observability/phase-metrics";
import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
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

class StubD1Statement {
  constructor(
    private readonly query: string,
    private readonly persistedRichStatus: string | null | undefined,
    private readonly log: string[],
  ) {}
  bind(..._values: unknown[]): this {
    return this;
  }
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    this.log.push(`RUN:${this.query.slice(0, 60)}`);
    return { success: true, meta: { last_row_id: 0 } };
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    this.log.push(`ALL:${this.query.slice(0, 60)}`);
    return { results: [] };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.log.push(`FIRST:${this.query.slice(0, 60)}`);
    if (this.query.includes("SELECT rich_status FROM session_index")) {
      if (this.persistedRichStatus === undefined) return null;
      return { rich_status: this.persistedRichStatus } as T;
    }
    return null;
  }
}

class StubD1 {
  readonly queryLog: string[] = [];
  constructor(private readonly persistedRichStatus: string | null | undefined) {}
  prepare(query: string): StubD1Statement {
    return new StubD1Statement(query, this.persistedRichStatus, this.queryLog);
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

function envWith(db: StubD1, opts: { ddApiKey?: string } = {}): Record<string, unknown> {
  return {
    DB: db,
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
    DD_API_KEY: opts.ddApiKey,
  };
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

interface DriftInternal {
  checkPhaseDriftOnSeed: (
    sessionId: string,
    derivedPhase: string,
    sessionKind: string | null,
    cause: PhaseTransitionCause,
    reconciliationSource: string,
  ) => Promise<void>;
  persistAndRecordSessionStatusFrame: (
    sessionId: string,
    cause?: PhaseTransitionCause,
    drift?: DriftCheckConfig,
  ) => Promise<unknown>;
}

describe("checkPhaseDriftOnSeed", () => {
  const SESSION_ID = "drift-session";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildInstance(db: StubD1) {
    const fakeState = createFakeState();
    const env = envWith(db, { ddApiKey: "dd-key" });
    const instance = new workerModule.SessionDO(fakeState, env);
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    return instance as unknown as DriftInternal;
  }

  it("emits drift telemetry when persisted phase differs from derived phase", async () => {
    const internal = buildInstance(new StubD1("running"));
    await internal.checkPhaseDriftOnSeed(
      SESSION_ID,
      "stopped",
      "repo",
      "sandbox_transport_event",
      "reaper_alarm_no_session",
    );

    const driftMetricCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/api/v2/series"));
    expect(driftMetricCall, "expected a drift metric POST").toBeDefined();
    // Cycloid-owned Datadog telemetry must POST to us5 (root CLAUDE.md). The
    // exporter pins this internally; assert it here so a future regression
    // doesn't quietly route drift signals to the wrong site.
    expect(String(driftMetricCall![0])).toBe("https://api.us5.datadoghq.com/api/v2/series");
    const body = JSON.parse((driftMetricCall![1] as RequestInit).body as string) as {
      series: Array<{ metric: string; tags: string[] }>;
    };
    expect(body.series[0]!.metric).toBe("arcanist.session.phase.drift");
    // cause + reconciliation_source tags let DD triage locate the entry
    // point and the monitor filter at tag level independently of code logic.
    expect(body.series[0]!.tags).toEqual(
      expect.arrayContaining([
        "persisted_phase:running",
        "derived_phase:stopped",
        "cause:sandbox_transport_event",
        "reconciliation_source:reaper_alarm_no_session",
      ]),
    );
  });

  it("does not emit when persisted phase matches derived phase", async () => {
    const internal = buildInstance(new StubD1("running"));
    await internal.checkPhaseDriftOnSeed(
      SESSION_ID,
      "running",
      "repo",
      "sandbox_transport_event",
      "reaper_alarm_no_session",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips drift check when persisted row is missing (brand-new session)", async () => {
    const internal = buildInstance(new StubD1(undefined));
    await internal.checkPhaseDriftOnSeed(
      SESSION_ID,
      "idle",
      "repo",
      "sandbox_transport_event",
      "reaper_alarm_no_session",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips drift check when persisted rich_status is null", async () => {
    const internal = buildInstance(new StubD1(null));
    await internal.checkPhaseDriftOnSeed(
      SESSION_ID,
      "idle",
      "repo",
      "sandbox_transport_event",
      "reaper_alarm_no_session",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("persistAndRecordSessionStatusFrame drift wiring", () => {
  const SESSION_ID = "drift-wiring-session";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("reconciliation mode reads persisted rich_status BEFORE the awaited projection write and fires drift on mismatch", async () => {
    const fakeState = createFakeState();
    const db = new StubD1("running");
    const env = {
      DB: db,
      WORKER_ENV: "test",
      SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
      LOG_LEVEL: "error",
      DD_API_KEY: "dd-key",
    };
    const instance = new workerModule.SessionDO(fakeState, env);
    // Session active + sandbox ready, no active prompt → computePhase derives
    // "idle". Persisted column says "running". That mismatch is the drift this
    // test asserts gets caught when the alarm/reconnect-grace path explicitly
    // opts in to passive reconciliation.
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const internal = instance as unknown as DriftInternal;
    await internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event", {
      mode: "passive_reconciliation",
      source: "reconnect_grace_cleanup_live_socket",
    });
    // Drift metric POST is fired via waitUntil so external telemetry stays
    // off the lifecycle critical path. Flush before asserting it ran.
    await fakeState.flushWaitUntil();

    const driftMetricCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/api/v2/series"));
    expect(driftMetricCall, "expected a drift metric POST through the wiring path").toBeDefined();
    const body = JSON.parse((driftMetricCall![1] as RequestInit).body as string) as {
      series: Array<{ metric: string; tags: string[] }>;
    };
    expect(body.series[0]!.metric).toBe("arcanist.session.phase.drift");
    expect(body.series[0]!.tags).toEqual(
      expect.arrayContaining([
        "persisted_phase:running",
        "derived_phase:idle",
        "cause:sandbox_transport_event",
        "reconciliation_source:reconnect_grace_cleanup_live_socket",
      ]),
    );

    // Race guard: the drift SELECT must execute before the projection UPDATE,
    // otherwise the write could mask the very drift this check is here to
    // catch. The new awaited helper enforces this inline (SELECT awaits before
    // the UPDATE is issued).
    const selectIdx = db.queryLog.findIndex((q) => q.startsWith("FIRST:SELECT rich_status FROM session_index"));
    const updateIdx = db.queryLog.findIndex((q) => q.startsWith("RUN:UPDATE session_index SET rich_status"));
    expect(selectIdx, "drift SELECT must run").toBeGreaterThanOrEqual(0);
    expect(updateIdx, "projection UPDATE must run").toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeLessThan(updateIdx);
  });

  it("mutation mode (default) does NOT fire drift even when persisted phase differs from derived phase", async () => {
    // Regression for the false-positive bug: on a brand-new session whose
    // route-side projection wrote `idle`, the very first prompt enqueue used
    // to fire `idle -> running` as drift because the drift SELECT ran before
    // the projection UPDATE. After the fix, mutation callsites pass the
    // default `SKIP_DRIFT_CHECK`; no drift metric fires.
    const fakeState = createFakeState();
    const db = new StubD1("idle");
    const env = {
      DB: db,
      WORKER_ENV: "test",
      SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
      LOG_LEVEL: "error",
      DD_API_KEY: "dd-key",
    };
    const instance = new workerModule.SessionDO(fakeState, env);
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const internal = instance as unknown as DriftInternal;
    // Default drift config (omitted) === SKIP_DRIFT_CHECK.
    await internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");
    await fakeState.flushWaitUntil();

    const driftMetricCall = fetchSpy.mock.calls.find(([url, init]) => {
      if (!String(url).includes("/api/v2/series")) return false;
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body !== "string") return false;
      const parsed = JSON.parse(body) as { series?: Array<{ metric: string }> };
      return parsed.series?.[0]?.metric === "arcanist.session.phase.drift";
    });
    expect(driftMetricCall, "mutation path must not fire drift").toBeUndefined();

    // The projection UPDATE still happens (rich_status moves from idle to
    // running); only the drift telemetry is suppressed.
    const updateIdx = db.queryLog.findIndex((q) => q.startsWith("RUN:UPDATE session_index SET rich_status"));
    expect(updateIdx, "projection UPDATE must still run").toBeGreaterThanOrEqual(0);
  });
});
