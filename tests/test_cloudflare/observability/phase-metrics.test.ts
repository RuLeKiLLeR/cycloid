import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  postPhaseDriftMetric,
  postPhaseTransitionEvent,
  postPhaseTransitionMetric,
} from "../../../apps/control-plane-worker/src/observability/phase-metrics";

const ENV = {
  DD_API_KEY: "test-key",
  WORKER_ENV: "test",
};

const EVENT = {
  sessionId: "sess-1",
  previousPhase: "idle" as const,
  next: {
    phase: "running" as const,
    sandboxSubstate: "creating" as const,
    finalizingStep: "none" as const,
    stopMode: "none" as const,
  },
  cause: "active_prompt_started" as const,
  sessionKind: "repo" as const,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 202 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("postPhaseTransitionMetric", () => {
  it("posts a single COUNT series point to the Datadog v2 metrics API with phase tags", async () => {
    await postPhaseTransitionMetric(ENV, EVENT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.us5.datadoghq.com/api/v2/series");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["DD-API-KEY"]).toBe("test-key");
    const body = JSON.parse((init as RequestInit).body as string) as {
      series: Array<{ metric: string; type: number; tags: string[]; points: Array<{ value: number }> }>;
    };
    expect(body.series).toHaveLength(1);
    const series = body.series[0]!;
    expect(series.metric).toBe("arcanist.session.phase.transition");
    expect(series.type).toBe(1);
    expect(series.points[0]!.value).toBe(1);
    expect(series.tags).toEqual(
      expect.arrayContaining([
        "env:test",
        "service:cycloid-control-plane",
        "worker:control-plane",
        "previous_phase:idle",
        "next_phase:running",
        "sandbox_substate:creating",
        "finalizing_step:none",
        "stop_mode:none",
        "cause:active_prompt_started",
        // No backend on the event -> preserve an explicit unknown tag.
        "agent_runtime_backend:unknown",
      ]),
    );
  });

  it("tags the agent runtime backend when the event carries one", async () => {
    await postPhaseTransitionMetric(ENV, { ...EVENT, agentRuntimeBackend: "claude_code" });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      series: Array<{ tags: string[] }>;
    };
    expect(body.series[0]!.tags).toContain("agent_runtime_backend:claude_code");
  });

  it("treats a null previousPhase as the literal 'none' tag (first observation)", async () => {
    await postPhaseTransitionMetric(ENV, { ...EVENT, previousPhase: null });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      series: Array<{ tags: string[] }>;
    };
    expect(body.series[0]!.tags).toContain("previous_phase:none");
  });

  it("no-ops on missing DD_API_KEY (local dev)", async () => {
    await postPhaseTransitionMetric({ DD_API_KEY: undefined, WORKER_ENV: "test" }, EVENT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows fetch failures so a telemetry hiccup never blocks the caller", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(postPhaseTransitionMetric(ENV, EVENT)).resolves.toBeUndefined();
  });

  it("swallows fetch throws so a network error never blocks the caller", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    await expect(postPhaseTransitionMetric(ENV, EVENT)).resolves.toBeUndefined();
  });

  it("always posts to the canonical us5 site (DD_SITE is no longer honored by this exporter)", async () => {
    await postPhaseTransitionMetric(ENV, EVENT);
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.us5.datadoghq.com/api/v2/series");
  });
});

describe("postPhaseTransitionEvent", () => {
  it("forwards a queryable phase_transition event through the structured-event poster", async () => {
    await postPhaseTransitionEvent(ENV, EVENT);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    const body = JSON.parse((init as RequestInit).body as string) as Array<Record<string, unknown>>;
    expect(body[0]!.event).toBe("session.phase_transition");
    expect(body[0]!.sessionId).toBe("sess-1");
    expect(body[0]!.previousPhase).toBe("idle");
    expect(body[0]!.nextPhase).toBe("running");
    expect(body[0]!.cause).toBe("active_prompt_started");
  });
});

describe("postPhaseDriftMetric", () => {
  it("posts a drift count series plus a queryable drift event", async () => {
    await postPhaseDriftMetric(ENV, {
      sessionId: "sess-2",
      persistedPhase: "running",
      derivedPhase: "stopped",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const metricBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      series: Array<{ metric: string; tags: string[] }>;
    };
    expect(metricBody.series[0]!.metric).toBe("arcanist.session.phase.drift");
    expect(metricBody.series[0]!.tags).toEqual(
      expect.arrayContaining(["service:cycloid-control-plane", "persisted_phase:running", "derived_phase:stopped"]),
    );
    const eventBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string) as Array<
      Record<string, unknown>
    >;
    expect(eventBody[0]!.event).toBe("session.phase_drift");
  });
});
