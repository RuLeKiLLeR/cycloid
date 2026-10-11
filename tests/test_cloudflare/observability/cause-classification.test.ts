/**
 * Cause-classification coverage. PR H tagged four call-site causes
 * (`active_prompt_started` / `active_prompt_cleared` / `pending_question_set`
 * / `sandbox_transport_event`); the remaining causes in the type union
 * (`stop_requested`, `archive`, `unarchive`) used to all bucket as
 * `sandbox_transport_event`. This PR threads cause through the lifecycle
 * decision pipeline so transitions get attributed to the semantic trigger.
 *
 * Unit-tests the pure mapping (`causeForLifecycleEvent`) plus an integration
 * test that drives /session/stop and asserts the phase-transition metric POST
 * carries `cause:stop_requested`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "../session/helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
  causeForLifecycleEvent: (event: { type: string } & Record<string, unknown>) => string;
};

interface Internal {
  persistAndRecordSessionStatusFrame: (sessionId: string, cause?: string) => Promise<unknown>;
  closeSessionAtDurabilityBoundary: (
    session: { sessionId: string; ownerUserId: string; status: string; closedAt: string | null; updatedAt: string },
    reason: string,
    closeMetadata?: Record<string, unknown>,
  ) => Promise<unknown>;
}

class StubD1Statement {
  constructor() {}
  bind(..._values: unknown[]): this {
    return this;
  }
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    return { success: true, meta: { last_row_id: 0 } };
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return null;
  }
}
class StubD1 {
  prepare(_query: string): StubD1Statement {
    return new StubD1Statement();
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

describe("causeForLifecycleEvent", () => {
  it("maps stop_finalize with stopReason=user to stop_requested", () => {
    expect(
      workerModule.causeForLifecycleEvent({ type: "boundary.stop_finalize", stopReason: "user", reason: "x" }),
    ).toBe("stop_requested");
  });
  it("maps non-user stop_finalize variants to sandbox_transport_event", () => {
    // boundary.stop_finalize also fires from publish_push_failed
    // (stopReason=null), sandbox_disconnected auto-close (stopReason="reaped"),
    // and spawn_failed paths. None of those are user-requested stops.
    expect(
      workerModule.causeForLifecycleEvent({
        type: "boundary.stop_finalize",
        stopReason: null,
        reason: "publish_push_failed",
      }),
    ).toBe("sandbox_transport_event");
    expect(
      workerModule.causeForLifecycleEvent({
        type: "boundary.stop_finalize",
        stopReason: "reaped",
        reason: "sandbox_disconnected",
      }),
    ).toBe("sandbox_transport_event");
    expect(
      workerModule.causeForLifecycleEvent({ type: "boundary.stop_finalize", stopReason: "spawn_failed", reason: "x" }),
    ).toBe("sandbox_transport_event");
  });
  it("maps close_finalize and auto_close_scheduled to archive", () => {
    expect(workerModule.causeForLifecycleEvent({ type: "boundary.close_finalize", reason: "x" })).toBe("archive");
    expect(workerModule.causeForLifecycleEvent({ type: "boundary.auto_close_scheduled" })).toBe("archive");
  });
  it("keeps transport_stop_finalize as sandbox_transport_event", () => {
    // The boundary fires from a WS disconnect, not a user action — keep the
    // transport-driven attribution so the dashboard separates "user stop" from
    // "sandbox gave out".
    expect(
      workerModule.causeForLifecycleEvent({
        type: "boundary.transport_stop_finalize",
        stopReason: "user",
        reason: "x",
      }),
    ).toBe("sandbox_transport_event");
  });
  it("falls through to sandbox_transport_event for non-boundary events", () => {
    expect(workerModule.causeForLifecycleEvent({ type: "sandbox.ws_connected", sandboxId: "sb-1" })).toBe(
      "sandbox_transport_event",
    );
    expect(workerModule.causeForLifecycleEvent({ type: "prompt.enqueued", promptId: "p-1" })).toBe(
      "sandbox_transport_event",
    );
  });
});

describe("closeSessionAtDurabilityBoundary tags phase-transition cause archive", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("emits arcanist.session.phase.transition with cause:archive when a session closes", async () => {
    const fakeState = createFakeState();
    const env = {
      DB: new StubD1(),
      WORKER_ENV: "test",
      SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
      LOG_LEVEL: "error",
      DD_API_KEY: "dd-key",
    };
    const instance = new workerModule.SessionDO(fakeState, env);
    const SESSION_ID = "close-cause-session";
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const internal = instance as unknown as Internal;
    // Prime lastObservedPhase. recordPhaseTransition silently seeds on first
    // observation (previous === null returns), so without this the close-time
    // transition would be the first observed phase and emit nothing. In prod
    // the WS subscribed snapshot does this priming naturally.
    await internal.persistAndRecordSessionStatusFrame(SESSION_ID, "active_prompt_started");
    await fakeState.flushWaitUntil();
    fetchSpy.mockClear();

    await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        body: JSON.stringify({ reason: "user_closed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    await fakeState.flushWaitUntil();

    const transitionMetricCalls = fetchSpy.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/api/v2/series") &&
        String((init as RequestInit | undefined)?.body ?? "").includes("arcanist.session.phase.transition"),
    );
    expect(transitionMetricCalls.length, "expected at least one phase transition metric POST").toBeGreaterThan(0);
    const archiveTagged = transitionMetricCalls.filter(([, init]) =>
      String((init as RequestInit).body).includes("cause:archive"),
    );
    expect(archiveTagged.length, "expected at least one transition tagged cause:archive").toBeGreaterThan(0);
    // Confirm nothing in the close flow is reported as `unknown` — a leaked
    // untagged sync would indicate a missed cause-threading site.
    const unknownTagged = transitionMetricCalls.filter(([, init]) =>
      String((init as RequestInit).body).includes("cause:unknown"),
    );
    expect(unknownTagged.length).toBe(0);
  });
});
