/**
 * Cause classification guardrail.
 *
 * After the false-positive fix, drift detection is gated by an explicit
 * `DriftCheckConfig` parameter, NOT by `PhaseTransitionCause`. Every cause
 * used at a mutation callsite must therefore go through
 * `persistAndRecordSessionStatusFrame` without firing `phase.drift`, even
 * when the persisted column and the freshly derived phase disagree (which
 * is the normal state on a transitioning mutation).
 *
 * If a future change either (a) adds a new cause and routes it through a
 * passive-reconciliation callsite by accident, or (b) regresses the helper
 * so that mutation callsites pick up drift detection again, this test
 * fails.
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

// All causes the union currently supports. The `satisfies` cast pins the
// values to `PhaseTransitionCause`, and `AssertExhaustive` below fails the
// build if a new cause is added without being classified here.
const MUTATION_CAUSES = [
  "active_prompt_started",
  "active_prompt_cleared",
  "pending_question_set",
  "pending_question_cleared",
  "sandbox_transport_event",
  "publish_status_change",
  "stop_requested",
  "archive",
  "unarchive",
  "post_execution",
  "unknown",
] as const satisfies readonly PhaseTransitionCause[];

// Compile-time exhaustiveness guardrail: any cause added to the union that
// isn't in `MUTATION_CAUSES` makes this assignment fail typecheck.
type _AssertExhaustive = [Exclude<PhaseTransitionCause, (typeof MUTATION_CAUSES)[number]>] extends [never]
  ? true
  : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

interface DriftInternal {
  persistAndRecordSessionStatusFrame: (
    sessionId: string,
    cause?: PhaseTransitionCause,
    drift?: DriftCheckConfig,
  ) => Promise<unknown>;
}

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

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

function findDriftMetricCall(fetchSpy: ReturnType<typeof vi.spyOn>) {
  for (const call of fetchSpy.mock.calls) {
    const [url, init] = call;
    if (!String(url).includes("/api/v2/series")) continue;
    const body = (init as RequestInit | undefined)?.body;
    if (typeof body !== "string") continue;
    const parsed = JSON.parse(body) as { series?: Array<{ metric: string }> };
    if (parsed.series?.[0]?.metric === "arcanist.session.phase.drift") return call;
  }
  return undefined;
}

describe("drift gating is independent of PhaseTransitionCause", () => {
  const SESSION_ID = "cause-classification-session";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Every cause, when used at the default mutation callsite, must NOT emit
  // drift telemetry. The persisted column is deliberately seeded with a
  // different phase ("running") from what the DO will derive ("idle") so any
  // residual "first observation" trigger would still fire — proving the
  // gating is on `drift.mode`, not on cause or on cache state.
  it.each(MUTATION_CAUSES)("cause=%s default mutation path emits no drift", async (cause) => {
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
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const internal = instance as unknown as DriftInternal;
    await internal.persistAndRecordSessionStatusFrame(SESSION_ID, cause);
    await fakeState.flushWaitUntil();

    expect(findDriftMetricCall(fetchSpy), `cause=${cause} must not fire drift on the mutation path`).toBeUndefined();
  });

  // Sanity: the reconciliation opt-in still fires drift. This pairs with the
  // suite above: same cause, same persisted/derived mismatch, but the
  // reconciliation flag flips the outcome. Confirms that the gate is the
  // flag, not the cause.
  it("explicit passive_reconciliation mode still fires drift on mismatch", async () => {
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
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const internal = instance as unknown as DriftInternal;
    await internal.persistAndRecordSessionStatusFrame(SESSION_ID, "sandbox_transport_event", {
      mode: "passive_reconciliation",
      source: "test_reconciliation_path",
    });
    await fakeState.flushWaitUntil();

    const call = findDriftMetricCall(fetchSpy);
    expect(call, "reconciliation mode must fire drift on mismatch").toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string) as {
      series: Array<{ tags: string[] }>;
    };
    expect(body.series[0]!.tags).toEqual(
      expect.arrayContaining(["cause:sandbox_transport_event", "reconciliation_source:test_reconciliation_path"]),
    );
  });
});
