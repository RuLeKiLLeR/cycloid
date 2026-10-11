import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logoutUser } from "../../apps/ui/src/api/auth.js";
import { fetchBootstrap } from "../../apps/ui/src/api/bootstrap.js";
import { clearApiCache } from "../../apps/ui/src/api/cache.js";
import { createCliToken } from "../../apps/ui/src/api/cli-tokens.js";
import { disconnectBusinessLinearWorkspace, updateBusinessSharedSessions } from "../../apps/ui/src/api/integrations.js";
import { fetchModels } from "../../apps/ui/src/api/models.js";
import { fetchOnboardingStatus } from "../../apps/ui/src/api/onboarding.js";
import {
  archiveSession,
  buildPromptEventsResult,
  createChildSession,
  createSession,
  createSessionAndSend,
  fetchPromptEvents,
  fetchPromptEventsPage,
  fetchSessionHistoryProbe,
  fetchSessions,
  sendPrompt,
  stopSession,
  warmSandbox,
} from "../../apps/ui/src/api/sessions.js";
import { fetchRepoSkills } from "../../apps/ui/src/api/skills.js";
import {
  getRawSessionEventData,
  getRawSessionEventKind,
  partitionEventsByPrompt,
  type RawSessionEvent,
} from "../../shared/transcript/projector.js";

const uiMocks = vi.hoisted(() => ({
  captureUiError: vi.fn(),
  trackAction: vi.fn(),
}));

vi.mock("../../apps/ui/src/datadog.ts", () => ({
  addSessionTiming: vi.fn(),
  trackAction: uiMocks.trackAction,
}));
vi.mock("../../apps/ui/src/datadog", () => ({
  addSessionTiming: vi.fn(),
  trackAction: uiMocks.trackAction,
}));

vi.mock("../../apps/ui/src/sentry.ts", () => ({
  captureUiError: uiMocks.captureUiError,
}));
vi.mock("../../apps/ui/src/sentry", () => ({
  captureUiError: uiMocks.captureUiError,
}));

beforeEach(() => {
  clearApiCache();
});

// flattenSessionEvents is canonically tested in event-flattening.test.ts.

// ---------------------------------------------------------------------------
// partitionEventsByPrompt
// ---------------------------------------------------------------------------

function makeProcessingEvent(promptId: string, sequence: number): RawSessionEvent {
  return { type: "prompt_processing", sequence, data: { promptId } };
}

function makeTextEvent(id: string, text: string, sequence: number): RawSessionEvent {
  return { type: "text", sequence, data: { id, text } };
}

describe("partitionEventsByPrompt", () => {
  it("returns empty buckets when no matching prompt_processing event exists", () => {
    const events: RawSessionEvent[] = [makeTextEvent("t1", "hello", 1), makeTextEvent("t2", "world", 2)];
    const result = partitionEventsByPrompt(events, ["p1"]);
    expect(result.get("p1")).toEqual([]);
  });

  it("captures events for a single prompt from its marker to end of stream", () => {
    const events: RawSessionEvent[] = [
      makeProcessingEvent("p1", 1),
      makeTextEvent("t1", "hello", 2),
      makeTextEvent("t2", "world", 3),
    ];
    const result = partitionEventsByPrompt(events, ["p1"]);
    expect(result.get("p1")).toHaveLength(3); // includes the prompt_processing event itself
    expect(getRawSessionEventKind(result.get("p1")![0])).toBe("prompt_processing");
    expect(getRawSessionEventData(result.get("p1")![1])?.id).toBe("t1");
    expect(getRawSessionEventData(result.get("p1")![2])?.id).toBe("t2");
  });

  it("bounds a middle prompt between its marker and the next prompt's marker", () => {
    const events: RawSessionEvent[] = [
      makeProcessingEvent("p1", 1),
      makeTextEvent("a", "first", 2),
      makeProcessingEvent("p2", 3),
      makeTextEvent("b", "second", 4),
    ];
    const result = partitionEventsByPrompt(events, ["p1", "p2"]);
    // p1 bucket: prompt_processing + one text event (stops before p2's marker)
    expect(result.get("p1")).toHaveLength(2);
    expect(getRawSessionEventData(result.get("p1")![1])?.id).toBe("a");
    // p2 bucket: prompt_processing + one text event
    expect(result.get("p2")).toHaveLength(2);
    expect(getRawSessionEventData(result.get("p2")![1])?.id).toBe("b");
  });

  it("captures the last prompt's events from its marker to end of stream", () => {
    const events: RawSessionEvent[] = [
      makeProcessingEvent("p1", 1),
      makeTextEvent("a", "first", 2),
      makeProcessingEvent("p2", 3),
      makeTextEvent("b", "second", 4),
      makeTextEvent("c", "third", 5),
    ];
    const result = partitionEventsByPrompt(events, ["p1", "p2"]);
    expect(result.get("p2")).toHaveLength(3); // prompt_processing + 2 text events
    expect(getRawSessionEventData(result.get("p2")![2])?.id).toBe("c");
  });

  it("ignores events before the first known prompt_processing marker", () => {
    const events: RawSessionEvent[] = [
      makeTextEvent("noise", "before", 1),
      makeProcessingEvent("p1", 2),
      makeTextEvent("t1", "after", 3),
    ];
    const result = partitionEventsByPrompt(events, ["p1"]);
    // The noise event comes before the marker so it is not included
    expect(result.get("p1")).toHaveLength(2);
    expect(getRawSessionEventData(result.get("p1")![1])?.id).toBe("t1");
  });

  it("returns an empty bucket for a promptId not present in the event stream", () => {
    const events: RawSessionEvent[] = [makeProcessingEvent("p1", 1), makeTextEvent("t1", "text", 2)];
    const result = partitionEventsByPrompt(events, ["p1", "p-missing"]);
    expect(result.get("p-missing")).toEqual([]);
  });

  it("uses explicit promptId on events when the prompt_processing marker is outside the replay window", () => {
    const events: RawSessionEvent[] = [
      { type: "text", sequence: 10, data: { promptId: "p1", id: "t1", text: "live" } },
      { type: "tool_call", sequence: 11, data: { promptId: "p1", id: "tool-1", tool: "bash", summary: "pwd" } },
    ];
    const result = partitionEventsByPrompt(events, ["p1"]);
    expect(result.get("p1")).toEqual(events);
  });

  it("treats empty-string legacy prompt IDs as missing when partitioning", () => {
    const events: RawSessionEvent[] = [{ type: "text", sequence: 10, data: { promptId: "", id: "t1", text: "live" } }];

    const result = partitionEventsByPrompt(events, [""]);

    expect(result.get("")).toEqual([]);
  });

  it("partitions canonical prompt.dispatch and text.delta events using the normalized promptId", () => {
    const events: RawSessionEvent[] = [
      {
        phase: "prompt.dispatch",
        sessionId: "s-1",
        promptId: "p1",
        sequence: 1,
        timestampMs: 100,
        payload: {},
      },
      {
        phase: "text.delta",
        sessionId: "s-1",
        promptId: "p1",
        sequence: 2,
        timestampMs: 200,
        payload: {
          partId: "t1",
          text: "hello",
          channel: "output",
        },
      },
      {
        phase: "prompt.dispatch",
        sessionId: "s-1",
        promptId: "p2",
        sequence: 3,
        timestampMs: 300,
        payload: {},
      },
    ];

    const result = partitionEventsByPrompt(events, ["p1", "p2"]);

    expect(result.get("p1")).toHaveLength(2);
    expect(getRawSessionEventKind(result.get("p1")![0])).toBe("prompt_processing");
    expect(getRawSessionEventData(result.get("p1")![1])?.id).toBe("t1");
    expect(result.get("p2")).toEqual([events[2]]);
  });
});

// ---------------------------------------------------------------------------
// buildPromptEventsResult
// ---------------------------------------------------------------------------

describe("buildPromptEventsResult", () => {
  it("returns an empty events result for empty input", () => {
    expect(buildPromptEventsResult([])).toEqual({ events: [], maxSequence: 0 });
  });

  it("flattens text events into the events array", () => {
    const raw: RawSessionEvent[] = [{ type: "text", data: { id: "t1", text: "hello" } }];
    const result = buildPromptEventsResult(raw);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "text", id: "t1", text: "hello" });
  });

  it("hides merged durable prompt activity from rendered transcript events", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw: RawSessionEvent[] = [
      { type: "prompt_activity", data: { promptId: "p1", phase: "prompt_preparing", detail: "workspace_setup" } },
      {
        type: "prompt_completed",
        data: {
          promptId: "p1",
          history: [{ type: "text", data: { promptId: "p1", id: "t1", text: "done" } }],
        },
      },
    ];

    try {
      const result = buildPromptEventsResult(raw);

      expect(result.events).toEqual([expect.objectContaining({ type: "text", promptId: "p1", text: "done" })]);
      expect(errorSpy).toHaveBeenCalledWith(
        "[transcript] merged durable prompt_activity events missing from embedded terminal history",
        expect.objectContaining({
          mergedDurablePromptActivityCount: 1,
          durablePromptActivityCount: 1,
          embeddedPromptActivityCount: 0,
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves merged durable agent progress in rendered transcript events", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw: RawSessionEvent[] = [
      { type: "agent_progress", data: { promptId: "p1", step: "preparing_context", label: "Preparing context" } },
      {
        type: "prompt_completed",
        data: {
          promptId: "p1",
          history: [{ type: "text", data: { promptId: "p1", id: "t1", text: "done" } }],
        },
      },
    ];

    try {
      const result = buildPromptEventsResult(raw);

      expect(result.events).toEqual([
        expect.objectContaining({
          type: "agent_progress",
          promptId: "p1",
          step: "preparing_context",
          label: "Preparing context",
        }),
        expect.objectContaining({ type: "text", promptId: "p1", text: "done" }),
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        "[transcript] merged durable agent_progress events missing from embedded terminal history",
        expect.objectContaining({
          mergedDurableAgentProgressCount: 1,
          durableAgentProgressCount: 1,
          embeddedAgentProgressCount: 0,
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("fetchSessions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes scope, cursor, and status filters into the list query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [], nextCursor: null }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await fetchSessions({ scope: "business", cursor: "cursor|1", status: "running" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions?scope=business&cursor=cursor%7C1&status=running",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("serializes a trimmed search query into the list query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [], nextCursor: null }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await fetchSessions({ query: " 6c56a550-a7b0-4ffc-8b9e-9a608163b55d " });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions?q=6c56a550-a7b0-4ffc-8b9e-9a608163b55d",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses distinct cache entries for searched and unsearched session lists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "unfiltered", status: "running", createdAt: "2026-05-21T20:02:16.000Z" }],
            nextCursor: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "filtered", status: "running", createdAt: "2026-05-21T20:02:17.000Z" }],
            nextCursor: null,
          }),
      }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await expect(fetchSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "unfiltered" })],
    });
    await expect(fetchSessions({ query: "  filtered  " })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "filtered" })],
    });
    await expect(fetchSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "unfiltered" })],
    });
    await expect(fetchSessions({ query: "filtered" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "filtered" })],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes legacy list rows that only include status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [
            {
              sessionId: "s-1",
              status: "running",
              createdAt: "2026-05-21T20:02:16.000Z",
              prUrl: null,
              model: null,
              title: "Fix sidebar crash",
            },
          ],
          nextCursor: null,
        }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await fetchSessions();

    expect(result.sessions[0]).toMatchObject({
      sessionId: "s-1",
      phase: "running",
      title: "Fix sidebar crash",
    });
  });

  it("normalizes UI lifecycle stage values on list rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [
            {
              sessionId: "s-1",
              phase: "completed",
              uiLifecycleStage: "merge_ready",
              createdAt: "2026-05-21T20:02:16.000Z",
              prUrl: null,
              model: null,
              title: "Ready",
            },
            {
              sessionId: "s-2",
              phase: "completed",
              uiLifecycleStage: "legacy_stage",
              createdAt: "2026-05-21T20:02:17.000Z",
              prUrl: null,
              model: null,
              title: "Legacy",
            },
          ],
          nextCursor: null,
        }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await fetchSessions();

    expect(result.sessions.map((session) => session.uiLifecycleStage)).toEqual(["merge_ready", null]);
  });

  it("invalidates the session list after stopping a session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "s-1", status: "running", createdAt: "2026-05-21T20:02:16.000Z" }],
            nextCursor: null,
          }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "s-1", status: "stopped", createdAt: "2026-05-21T20:02:16.000Z" }],
            nextCursor: null,
          }),
      }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await expect(fetchSessions()).resolves.toMatchObject({ sessions: [expect.objectContaining({ phase: "running" })] });
    await stopSession("s-1");
    await expect(fetchSessions()).resolves.toMatchObject({ sessions: [expect.objectContaining({ phase: "stopped" })] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("invalidates searched and unsearched session list caches after stopping a session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "unfiltered-before", status: "running", createdAt: "2026-05-21T20:02:16.000Z" }],
            nextCursor: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "filtered-before", status: "running", createdAt: "2026-05-21T20:02:17.000Z" }],
            nextCursor: null,
          }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "unfiltered-after", status: "stopped", createdAt: "2026-05-21T20:02:18.000Z" }],
            nextCursor: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [{ sessionId: "filtered-after", status: "stopped", createdAt: "2026-05-21T20:02:19.000Z" }],
            nextCursor: null,
          }),
      }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await expect(fetchSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "unfiltered-before" })],
    });
    await expect(fetchSessions({ query: "filtered" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "filtered-before" })],
    });
    await stopSession("s-1");
    await expect(fetchSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "unfiltered-after" })],
    });
    await expect(fetchSessions({ query: "filtered" })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "filtered-after" })],
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("fetchModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("bypasses the browser cache for model refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await fetchModels();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/models",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });
});

describe("disconnectBusinessLinearWorkspace", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends a DELETE request to the Linear workspace route", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as typeof globalThis.fetch;

    await disconnectBusinessLinearWorkspace("biz-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/businesses/biz-1/integrations/linear/workspace",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("invalidates bootstrap after shared-session updates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { sharedSessions: false } }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { sharedSessions: true } }),
      }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await expect(fetchBootstrap()).resolves.toMatchObject({ user: { sharedSessions: false } });
    await updateBusinessSharedSessions("biz-1", true);
    await expect(fetchBootstrap()).resolves.toMatchObject({ user: { sharedSessions: true } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("fetchBootstrap", () => {
  const originalFetch = globalThis.fetch;

  it("fetches bootstrap again after clearing the API cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { login: "impersonated-user" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ user: { login: "real-user" } }),
      }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await expect(fetchBootstrap()).resolves.toMatchObject({ user: { login: "impersonated-user" } });
    clearApiCache();
    await expect(fetchBootstrap()).resolves.toMatchObject({ user: { login: "real-user" } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
});

describe("createCliToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends read scope by default", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, token: "arc_read", id: 1, scope: "read" }),
    }) as typeof globalThis.fetch;

    await createCliToken();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/cli-tokens",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "read" }),
      }),
    );
  });

  it("sends selected write scope and expiration", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, token: "arc_write", id: 2, scope: "write" }),
    }) as typeof globalThis.fetch;

    await createCliToken({ scope: "write", expiresInDays: 90 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/cli-tokens",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "write", expiresInDays: 90 }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// requestJson (tested via fetchBootstrap -- a simple no-body GET)
// ---------------------------------------------------------------------------

describe("requestJson", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on a 2xx response", async () => {
    const payload = { authenticated: true, user: {}, models: null, repos: null, settings: null, warnings: [] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    }) as typeof globalThis.fetch;

    const result = await fetchBootstrap();
    expect(result).toEqual(payload);
  });

  it("requests cache-bypassing repo hydration when requested", async () => {
    const payload = { authenticated: true, user: {}, models: null, repos: [], settings: null, warnings: [] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    }) as typeof globalThis.fetch;

    const result = await fetchBootstrap({ refreshRepos: true });

    expect(result).toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/bootstrap?refresh=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws with data.error from the response body on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "API key invalid" }),
    }) as typeof globalThis.fetch;

    await expect(fetchBootstrap()).rejects.toThrow("API key invalid");
  });

  it("preserves the parsed error payload on ApiError instances", async () => {
    const payload = {
      error: "API key invalid",
      state: {
        isSet: true,
        lastValidatedAt: 123,
        lastValidationStatus: "invalid",
        lastValidationReasonCode: "credentials_invalid",
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve(payload),
    }) as typeof globalThis.fetch;

    await expect(fetchBootstrap()).rejects.toMatchObject({
      message: "API key invalid",
      status: 400,
      data: payload,
    });
  });

  it("prefers a message field from the response body before falling back", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: "something else" }),
    }) as typeof globalThis.fetch;

    await expect(fetchBootstrap()).rejects.toThrow("something else");
  });

  it("throws with the caller-supplied fallback message when the body is not parseable JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("bad json")),
    }) as typeof globalThis.fetch;

    await expect(fetchBootstrap()).rejects.toThrow("Failed to fetch bootstrap data");
  });
});

// ---------------------------------------------------------------------------
// fetchRepoSkills
// ---------------------------------------------------------------------------

describe("fetchRepoSkills", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("dedupes in-flight skills requests for one repo", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ skills: [{ name: "review-spec", description: "Review", path: "SKILL.md" }] }),
    }) as typeof globalThis.fetch;

    const [first, second] = await Promise.all([
      fetchRepoSkills("DedupeOwner", "DedupeRepo"),
      fetchRepoSkills("dedupeowner", "deduperepo"),
    ]);

    expect(first).toEqual([{ name: "review-spec", description: "Review", path: "SKILL.md" }]);
    expect(second).toEqual(first);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes successful skills responses after the cache TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T00:00:00Z"));
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ skills: [{ name: "review-spec", description: "Review" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ skills: [{ name: "ship-prod", description: "Deploy" }] }),
      }) as typeof globalThis.fetch;

    await expect(fetchRepoSkills("ttlowner", "ttlrepo")).resolves.toEqual([
      { name: "review-spec", description: "Review" },
    ]);

    vi.setSystemTime(new Date("2026-04-24T00:01:01Z"));

    await expect(fetchRepoSkills("ttlowner", "ttlrepo")).resolves.toEqual([
      { name: "ship-prod", description: "Deploy" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes QA Tester session options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessionId: "s-verify" }),
    }) as typeof globalThis.fetch;

    await expect(
      createSession(undefined, { repoUrl: "https://github.com/org/repo" }, undefined, {
        qa: true,
        targetPrUrl: "https://github.com/org/repo/pull/123",
      }),
    ).resolves.toBe("s-verify");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          qa: true,
          targetPrUrl: "https://github.com/org/repo/pull/123",
          context: { repoUrl: "https://github.com/org/repo" },
        }),
      }),
    );
  });

  it("passes QA Tester options through createSessionAndSend", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessionId: "s-verify" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ prompt: { promptId: "p-verify" } }),
      }) as typeof globalThis.fetch;

    await expect(
      createSessionAndSend(
        "verify this PR",
        { url: "https://github.com/org/repo" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { qa: true, targetPrUrl: "https://github.com/org/repo/pull/123" },
      ),
    ).resolves.toEqual({ sessionId: "s-verify", promptId: "p-verify" });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/sessions",
      expect.objectContaining({
        body: JSON.stringify({
          prompt: "verify this PR",
          qa: true,
          targetPrUrl: "https://github.com/org/repo/pull/123",
          context: { repoUrl: "https://github.com/org/repo" },
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/s-verify/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "verify this PR" }),
      }),
    );
  });

  it("does not send a duplicate QA Tester prompt when the coordinator already enqueued it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionId: "s-verify", promptAlreadyEnqueued: true }),
    }) as typeof globalThis.fetch;

    await expect(
      createSessionAndSend(
        "verify this PR",
        { url: "https://github.com/org/repo" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { qa: true, targetPrUrl: "https://github.com/org/repo/pull/123" },
      ),
    ).resolves.toEqual({ sessionId: "s-verify", promptId: null, promptAlreadyEnqueued: true });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "verify this PR",
          qa: true,
          targetPrUrl: "https://github.com/org/repo/pull/123",
          context: { repoUrl: "https://github.com/org/repo" },
        }),
      }),
    );
  });

  it("serializes prompt and model selection for session create", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessionId: "s-model" }),
    }) as typeof globalThis.fetch;

    await expect(
      createSession(
        { providerID: "openai", modelID: "gpt-5.5" },
        { repoUrl: "https://github.com/org/repo" },
        undefined,
        { prompt: "Fix docs" },
      ),
    ).resolves.toBe("s-model");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.5",
          prompt: "Fix docs",
          context: { repoUrl: "https://github.com/org/repo" },
        }),
      }),
    );
  });
});

describe("createChildSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes linked QA child-session options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          childSessionId: "s-verify",
          childSessionUrl: "/sessions/s-verify",
          parentSessionId: "s-parent",
          parentPromptId: "fallback:s-parent",
          spawnDepth: 1,
        }),
    }) as typeof globalThis.fetch;

    await expect(
      createChildSession("s-parent", {
        prompt: "qa=true\n\nVerify https://github.com/org/repo/pull/123",
        repositoryId: "org/repo",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        qa: true,
        targetPrUrl: "https://github.com/org/repo/pull/123",
      }),
    ).resolves.toMatchObject({ childSessionId: "s-verify" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/s-parent/child-sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "qa=true\n\nVerify https://github.com/org/repo/pull/123",
          repositoryId: "org/repo",
          model: "gpt-5.5",
          qa: true,
          targetPrUrl: "https://github.com/org/repo/pull/123",
        }),
      }),
    );
  });

  it("serializes forceNewSession for the manual Verify button", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          childSessionId: "s-verify",
          childSessionUrl: "/sessions/s-verify",
          parentSessionId: "s-parent",
          parentPromptId: "fallback:s-parent",
          spawnDepth: 1,
        }),
    }) as typeof globalThis.fetch;

    await expect(
      createChildSession("s-parent", {
        prompt: "qa=true\n\nVerify https://github.com/org/repo/pull/123",
        repositoryId: "org/repo",
        qa: true,
        targetPrUrl: "https://github.com/org/repo/pull/123",
        forceNewSession: true,
      }),
    ).resolves.toMatchObject({ childSessionId: "s-verify" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/s-parent/child-sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "qa=true\n\nVerify https://github.com/org/repo/pull/123",
          repositoryId: "org/repo",
          qa: true,
          targetPrUrl: "https://github.com/org/repo/pull/123",
          forceNewSession: true,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends skills through the options object", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ prompt: { promptId: "p-1" } }),
    }) as typeof globalThis.fetch;

    await expect(
      sendPrompt("s-1", "review this", undefined, undefined, undefined, "review", { skills: ["review-spec"] }),
    ).resolves.toBe("p-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/s-1/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "review this",
          agent: "review",
          skills: ["review-spec"],
        }),
      }),
    );
  });
});

describe("fetchOnboardingStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls the onboarding status endpoint without query params by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, steps: [] }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await fetchOnboardingStatus();

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboarding/status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes owner, repo, and setup query params when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, steps: [{ id: "github_repo_access", status: "connected" }] }),
    }) as typeof globalThis.fetch;
    globalThis.fetch = fetchMock;

    await fetchOnboardingStatus({
      owner: "acme",
      repo: "widgets",
      setup: "complete",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboarding/status?owner=acme&repo=widgets&setup=complete",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// ---------------------------------------------------------------------------
// archiveSession
// ---------------------------------------------------------------------------

describe("archiveSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the archive envelope on a 2xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, archived: true }),
    }) as typeof globalThis.fetch;

    await expect(archiveSession("session-1", { closePr: true })).resolves.toEqual({ ok: true, archived: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ closePr: true }),
      }),
    );
  });

  it("throws with data.error from the response body on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Session not found" }),
    }) as typeof globalThis.fetch;

    await expect(archiveSession("session-1")).rejects.toThrow("Session not found");
  });

  it("throws with the caller-supplied fallback message when the body has no error field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }) as typeof globalThis.fetch;

    await expect(archiveSession("session-1")).rejects.toThrow("Failed to archive session");
  });

  it("throws with the caller-supplied fallback message when the body is not parseable JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new SyntaxError("bad json")),
    }) as typeof globalThis.fetch;

    await expect(archiveSession("session-1")).rejects.toThrow("Failed to archive session");
  });
});

// ---------------------------------------------------------------------------
// fetchPromptEvents
// ---------------------------------------------------------------------------

describe("fetchPromptEvents", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns built events on success", async () => {
    const events: RawSessionEvent[] = [{ type: "text", data: { id: "t1", text: "hello" } }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events }),
    }) as typeof globalThis.fetch;

    const result = await fetchPromptEvents("s1", "p1");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.result.events : []).toHaveLength(1);
    expect(result.ok ? result.rawEvents : []).toEqual(events);
    expect(result.ok ? result.result.events[0] : null).toMatchObject({ type: "text", text: "hello" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/events/history?"),
      expect.any(Object),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("prompt_id=p1"), expect.any(Object));
  });

  it("fetches additional prompt-scoped pages without falling back to a full-session replay", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [{ sequence: 1001, type: "text", data: { promptId: "p1", id: "t1", text: "first page" } }],
            hasMore: true,
            lastSequence: 1001,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [{ sequence: 1002, type: "text", data: { promptId: "p1", id: "t2", text: "second page" } }],
            hasMore: false,
            lastSequence: 1002,
          }),
      }) as typeof globalThis.fetch;

    const result = await fetchPromptEvents("s1", "p1");

    expect(result.ok).toBe(true);
    expect(result.ok ? result.result.events : []).toHaveLength(2);
    expect(result.ok ? result.rawEvents.map((event) => event.sequence) : []).toEqual([1001, 1002]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("prompt_id=p1"), expect.any(Object));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      expect.not.stringContaining("after_sequence="),
      expect.any(Object),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, expect.stringContaining("prompt_id=p1"), expect.any(Object));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("after_sequence=1001"),
      expect.any(Object),
    );
  });

  it("fetches one prompt-scoped history page with cursor metadata", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          events: [{ sequence: 1002, type: "text", data: { promptId: "p1", id: "t2", text: "second page" } }],
          hasMore: true,
          lastSequence: 1002,
        }),
    }) as typeof globalThis.fetch;

    const result = await fetchPromptEventsPage("s1", "p1", { afterSequence: 1001, limit: 250 });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.result.events : []).toHaveLength(1);
    expect(result.ok ? result.result.complete : null).toBe(false);
    expect(result.ok ? result.result.nextAfterSequence : null).toBe(1002);
    expect(result.ok ? result.rawEvents : []).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("prompt_id=p1"), expect.any(Object));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("after_sequence=1001"), expect.any(Object));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("limit=250"), expect.any(Object));
  });

  it("returns empty result on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    }) as typeof globalThis.fetch;

    const result = await fetchPromptEvents("s1", "p1");
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it("returns empty result on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    const result = await fetchPromptEvents("s1", "p1");
    expect(result).toMatchObject({ ok: false });
  });

  it("reports an undefined status when the failure is not an ApiError (instanceof narrowing)", async () => {
    // This PR tightened status extraction from a duck-typed `.status` read to
    // `err instanceof ApiError`. A non-ApiError error that happens to carry a
    // status-like field must NOT leak through as the result status.
    const errorWithStatus = Object.assign(new Error("boom"), { status: 503 });
    globalThis.fetch = vi.fn().mockRejectedValue(errorWithStatus);

    const result = await fetchPromptEvents("s1", "p1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBeUndefined();
  });

  it("maps a TimeoutError DOMException to status 408 via fetchWithTimeout's error mapping", async () => {
    // Unit-level check of fetchWithTimeout's error mapping, not an end-to-end
    // timeout: it pattern-matches on error.name === "TimeoutError" regardless of
    // origin, so a synthetic rejection exercises the same 408 branch the real
    // AbortSignal.timeout(45s) path takes. It does not prove the 45s ceiling
    // itself fires.
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    const result = await fetchPromptEvents("s1", "p1");
    expect(result).toMatchObject({ ok: false, status: 408 });
  });

  it("rethrows on caller abort instead of returning a failed result", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(fetchPromptEvents("s1", "p1", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// fetchSessionHistoryProbe
// ---------------------------------------------------------------------------

describe("fetchSessionHistoryProbe", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("buckets a complete first replay page by prompt", async () => {
    const events: RawSessionEvent[] = [
      { sequence: 1, type: "session_created", data: {} },
      { sequence: 2, type: "text", data: { promptId: "p1", id: "t1", text: "hello" } },
      { sequence: 3, type: "text", data: { promptId: "p2", id: "t2", text: "world" } },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          results: {
            p1: { events: [events[1]], hasMore: false },
            p2: { events: [events[2]], hasMore: false },
          },
        }),
    }) as typeof globalThis.fetch;

    const result = await fetchSessionHistoryProbe("s1", ["p1", "p2"]);

    expect(result).toMatchObject({ ok: true, complete: true, rawEventCount: 2, lastSequence: 3 });
    expect(result.ok && result.complete ? result.results.get("p1")?.events : []).toEqual([
      expect.objectContaining({ type: "text", text: "hello" }),
    ]);
    expect(result.ok && result.complete ? result.results.get("p1")?.rawEvents : []).toEqual([
      expect.objectContaining({ sequence: 2 }),
    ]);
    expect(result.ok && result.complete ? result.results.get("p2")?.events : []).toEqual([
      expect.objectContaining({ type: "text", text: "world" }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/events/bootstrap?"),
      expect.any(Object),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("prompt_id=p1"), expect.any(Object));
  });

  it("stops after one page when the replay has more events", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          results: {
            p1: {
              events: [{ sequence: 1000, type: "text", data: { promptId: "p1", id: "t1", text: "large" } }],
              hasMore: true,
            },
            p2: { events: [], hasMore: false },
          },
        }),
    }) as typeof globalThis.fetch;

    const result = await fetchSessionHistoryProbe("s1", ["p1", "p2"]);

    expect(result).toEqual({ ok: true, complete: false, rawEventCount: 1, lastSequence: 1000 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// warmSandbox (fire-and-forget, swallows errors)
// ---------------------------------------------------------------------------

describe("warmSandbox", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("logs but does not throw when the warm request fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: "unavailable" }),
    }) as typeof globalThis.fetch;

    expect(() => warmSandbox("s1")).not.toThrow();
    // Let the fire-and-forget chain (fetch -> ok check -> json -> throw -> catch) settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalledWith("[warmSandbox] Failed to warm sandbox for session", "s1", expect.anything());
  });

  it("sends the warm trigger as a query parameter", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as typeof globalThis.fetch;

    warmSandbox("s1", "page_open");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/s1/warm?trigger=page_open",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("silently swallows rate-limited warm requests", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: "too fast" }),
    }) as typeof globalThis.fetch;

    warmSandbox("s1", "page_open");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logoutUser (fire-and-forget, swallows errors)
// ---------------------------------------------------------------------------

describe("logoutUser", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as typeof globalThis.fetch;
    await expect(logoutUser()).resolves.toBeUndefined();
  });

  it("does not throw on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    }) as typeof globalThis.fetch;
    await expect(logoutUser()).resolves.toBeUndefined();
  });

  it("does not throw on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));
    await expect(logoutUser()).resolves.toBeUndefined();
  });
});
