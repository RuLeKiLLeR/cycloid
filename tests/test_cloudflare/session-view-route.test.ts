import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainSpans, endSpan, runInSpan, startSpan } from "../../apps/control-plane-worker/src/observability/context";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const mockGetSessionView = vi.fn();
const mockGetSessionState = vi.fn();
const mockAssembleSessionView = vi.fn();
const mockVerifyUserRepoAccess = vi.fn().mockResolvedValue(true);
const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(true);

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    getSessionView: (...args: unknown[]) => mockGetSessionView(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-view", () => ({
  assembleSessionView: (...args: unknown[]) => mockAssembleSessionView(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  verifyUserRepoAccess: (...args: unknown[]) => mockVerifyUserRepoAccess(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env, SessionViewPayload, UserInfo } from "../../apps/control-plane-worker/src/types";

function createAuth(userId: string, userOverrides: Partial<UserInfo> = {}): AuthInfo {
  return {
    userId,
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: "biz-1",
      sharedSessions: false,
      businessMemberIds: [],
      ...userOverrides,
    },
  };
}

type ChildRow = {
  session_id: string;
  business_id: string | null;
  parent_session_id: string;
  parent_prompt_id: string;
  spawned_by_user_id: number;
  spawn_depth: number;
  title: string | null;
  status: string;
  rich_status: string | null;
  created_at: string;
  closed_at: string | null;
};

function createEnv(
  options: {
    childRow?: ChildRow | null;
    parentRow?: { session_id: string; owner_user_id: number; business_id: string | null; spawn_depth: number } | null;
    childIds?: string[];
    qaChildSessionId?: string | null;
    orphanRow?: { owner_user_id: number; business_id: string | null } | null;
  } = {},
): Env & { batchCalls: () => number } {
  let batchCalls = 0;
  const env = {
    REPOS_CACHE: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    DB: {
      // db.batch() collapses the child-row + child-ids + QA-child reads into
      // one round-trip (see getChildContextForSession).
      batch: vi.fn(async () => {
        batchCalls += 1;
        return [
          { results: options.childRow ? [options.childRow] : [] },
          { results: (options.childIds ?? []).map((session_id) => ({ session_id })) },
          { results: options.qaChildSessionId ? [{ session_id: options.qaChildSessionId }] : [] },
        ];
      }),
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...params: unknown[]) => ({
          first: vi.fn(async () => {
            // Orphan-cleanup identity probe.
            if (query.includes("owner_user_id, business_id") && query.includes("LIMIT 1")) {
              return options.orphanRow ?? null;
            }
            if (query.includes("FROM session_index WHERE session_id = ?") && query.includes("spawn_depth")) {
              return params[0] === options.parentRow?.session_id ? options.parentRow : null;
            }
            return null;
          }),
          all: vi.fn(async () => ({ results: (options.childIds ?? []).map((session_id) => ({ session_id })) })),
        })),
      })),
    } as unknown as D1Database,
  } as unknown as Env & { batchCalls: () => number };
  env.batchCalls = () => batchCalls;
  return env;
}

function getSessionViewRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      String(candidate.pattern) === String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/view$/),
  );
  if (!route) throw new Error("Session view route not found");
  return route;
}

function makePayload(): SessionViewPayload {
  return {
    ok: true,
    session: {
      sessionId: "sess-1",
      ownerUserId: "42",
      businessId: "biz-1",
      status: "idle",
      sandboxStatus: null,
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: "2026-04-07T10:05:00.000Z",
      closedAt: null,
      lastEventId: "evt-1",
      title: "title",
      model: null,
      reasoningEffort: null,
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      baseBranch: null,
      installationId: null,
      lastBranch: null,
      prUrl: null,
      closeReason: null,
      spawnDurationMs: null,
    },
    prompts: [{ promptId: "p-1", prompt: "test", status: "completed", result: null }],
    queue: { queuedCount: 1, processingPromptId: null },
    metrics: {
      doBuildMs: 31,
      doPromptActorProfiles: {
        durationMs: 11,
        outcome: "success",
        requestedCount: 2,
        uncachedCount: 1,
      },
      doOwnerActorProfile: {
        durationMs: 5,
        outcome: "success",
        requestedCount: 1,
        uncachedCount: 0,
      },
      doSpineDoneMirror: {
        durationMs: 9,
        outcome: "fallback",
        errorClass: "Error",
      },
    },
  };
}

describe("session view route", () => {
  const route = getSessionViewRoute();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPostStructuredEventToDd.mockResolvedValue(true);
    mockVerifyUserRepoAccess.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue(makePayload().session);
    mockGetSessionView.mockResolvedValue({
      status: 200,
      ok: true,
      payload: makePayload(),
    });
    mockAssembleSessionView.mockResolvedValue({
      session: { sessionId: "sess-1" },
      prompts: { items: [], nextCursor: null, total: 0 },
      actions: { canSendPrompt: true, canStop: false, canResume: false },
    });
  });

  it("returns 200 for the session owner", async () => {
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(mockAssembleSessionView).toHaveBeenCalledTimes(1);
  });

  it("makes a single session-view DO fetch and never falls back to getSessionState", async () => {
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    // Exactly one DO hop: getSessionView. getSessionState is no longer used.
    expect(mockGetSessionView).toHaveBeenCalledTimes(1);
    expect(mockGetSessionState).not.toHaveBeenCalled();
    // And it is fetched WITHOUT an auth context: the DO's checkAccess gate for a
    // shared-business member needs repoAccessVerified* fields that are only set
    // after the worker proves repo access (which happens after this fetch), so
    // forwarding the raw context would 404 legitimate same-business viewers. The
    // worker is the authoritative boundary (identity + repo checks below).
    expect(mockGetSessionView).toHaveBeenCalledWith(expect.anything(), "sess-1", null, undefined, expect.anything());
  });

  it("returns 404 on identity mismatch for a non-owner with no shared access", async () => {
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      // owner is "42"; this caller is "99" with no shared-business access.
      createAuth("99"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Session not found" });
    expect(mockAssembleSessionView).not.toHaveBeenCalled();
    // Identity is rejected before any repo-access check runs.
    expect(mockVerifyUserRepoAccess).not.toHaveBeenCalled();
  });

  it("returns 403 when a shared-business member fails repo access", async () => {
    const session = {
      ...makePayload().session,
      repoOwner: "trycycloid",
      repoName: "cycloid",
    };
    mockGetSessionView.mockResolvedValue({
      status: 200,
      ok: true,
      payload: { ...makePayload(), session },
    });
    mockVerifyUserRepoAccess.mockResolvedValueOnce(false);

    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("43", { sharedSessions: true, businessMemberIds: ["42", "43"] }),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "You do not have access to this repository on GitHub",
    });
    expect(mockAssembleSessionView).not.toHaveBeenCalled();
  });

  it("reads child context via a single db.batch round-trip", async () => {
    const env = createEnv({ childIds: ["child-a", "child-b"], qaChildSessionId: "child-b" });
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      env,
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(env.batchCalls()).toBe(1);
    // parentMetadata is now handed to assembleSessionView as a promise so it
    // resolves concurrently with the assembly's own reads; await the resolved value.
    expect(await mockAssembleSessionView.mock.calls[0][3].parentMetadata).toMatchObject({
      childSessionIds: ["child-a", "child-b"],
      qaChildSessionId: "child-b",
    });
  });

  it("passes promptLimit=0 through to the session view DO fetch", async () => {
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view?promptLimit=0"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(mockGetSessionView).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      null,
      undefined,
      expect.objectContaining({ promptLimit: 0 }),
    );
    expect(mockAssembleSessionView.mock.calls[0][3]).not.toHaveProperty("promptLimit");
  });

  it("degrades to empty parent/child metadata when the child-context read throws", async () => {
    const env = createEnv({ childIds: ["child-a"] });
    (env.DB.batch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("d1 batch offline"));
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      env,
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    // A failed best-effort metadata read must not fail the view; it resolves to
    // no parent/child badges. Assembly still runs (the promise never rejects).
    expect(response.status).toBe(200);
    expect(await mockAssembleSessionView.mock.calls[0][3].parentMetadata).toEqual({
      childSessionIds: [],
      qaChildSessionId: null,
    });
  });

  it("omits child parent metadata when the referenced parent is in another business", async () => {
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv({
        childRow: {
          session_id: "sess-1",
          business_id: "biz-1",
          parent_session_id: "parent-1",
          parent_prompt_id: "prompt-A",
          spawned_by_user_id: 42,
          spawn_depth: 1,
          title: null,
          status: "active",
          rich_status: null,
          created_at: "2026-04-08T00:00:01.000Z",
          closed_at: null,
        },
        parentRow: { session_id: "parent-1", owner_user_id: 7, business_id: "biz-2", spawn_depth: 0 },
      }),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await mockAssembleSessionView.mock.calls[0][3].parentMetadata).toMatchObject({
      parentSessionId: null,
      parentPromptId: null,
      spawnDepth: null,
    });
  });

  it("returns 404 and triggers orphan cleanup when the DO reports 404", async () => {
    mockGetSessionView.mockResolvedValueOnce({ status: 404, ok: false, payload: null });
    const waitUntil = vi.fn();

    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      // orphan probe resolves the owner so cleanup is authorized for owner "42".
      createEnv({ orphanRow: { owner_user_id: 42, business_id: "biz-1" } }),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(mockAssembleSessionView).not.toHaveBeenCalled();
  });

  it("returns 500 when the combined DO fetch throws", async () => {
    mockGetSessionView.mockRejectedValueOnce(new Error("boom"));

    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("42"),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Failed to assemble session view" });
    expect(mockAssembleSessionView).not.toHaveBeenCalled();
  });

  it("passes the session-view cache scope to repo authorization", async () => {
    const session = {
      ...makePayload().session,
      repoOwner: "trycycloid",
      repoName: "cycloid",
    };
    mockGetSessionView.mockResolvedValue({
      status: 200,
      ok: true,
      payload: {
        ...makePayload(),
        session,
      },
    });

    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-1/view"),
      createEnv(),
      route.pattern.exec("/api/sessions/sess-1/view")!,
      createAuth("43", { sharedSessions: true, businessMemberIds: ["42", "43"] }),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(mockVerifyUserRepoAccess).toHaveBeenCalledWith(
      expect.anything(),
      "43",
      "trycycloid",
      "cycloid",
      expect.objectContaining({
        reposCacheEnv: expect.anything(),
        sessionViewCache: { sessionId: "sess-1" },
      }),
    );
    // Single hop: the view fetch carries no auth (the worker is the boundary;
    // forwarding raw auth would 404 same-business viewers at the DO checkAccess).
    expect(mockGetSessionView).toHaveBeenCalledWith(expect.anything(), "sess-1", null, undefined, expect.anything());
  });

  it("records DO and worker segment timings on the route span", async () => {
    mockAssembleSessionView.mockImplementationOnce(async (_session, _promptState, _auth, options) => {
      options.timingRecorder("worker_actor_profiles", {
        durationMs: 7,
        outcome: "success",
        requestedCount: 1,
      });
      options.timingRecorder("worker_ui_lifecycle_stage", {
        durationMs: 13,
        outcome: "fallback",
        errorClass: "Error",
      });
      options.timingRecorder("worker_parent_metadata_wait", {
        durationMs: 3,
        outcome: "success",
      });
      options.timingRecorder("assembly_cpu", {
        durationMs: 2,
        outcome: "success",
      });
      return {
        session: { sessionId: "sess-1" },
        prompts: { items: [], nextCursor: null, total: 0 },
        actions: { canSendPrompt: true, canStop: false, canResume: false },
      };
    });

    const root = startSpan("worker.fetch", { "request.id": "req-session-view-timings" });
    let spans = [] as ReturnType<typeof drainSpans>;
    const waitUntil = vi.fn();

    await runInSpan(root, async () => {
      const response = await route.handler(
        new Request("https://worker.test/api/sessions/sess-1/view"),
        createEnv(),
        route.pattern.exec("/api/sessions/sess-1/view")!,
        createAuth("42"),
        { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
      );

      expect(response.status).toBe(200);
      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "sessions.view");
    expect(routeSpan).toBeDefined();
    expect(routeSpan?.attributes).toMatchObject({
      "session.view.do_build_ms": 31,
      "session.view.do_prompt_actor_profiles_ms": 11,
      "session.view.do_prompt_actor_profiles_outcome": "success",
      "session.view.do_prompt_actor_profiles_requested_count": 2,
      "session.view.do_prompt_actor_profiles_uncached_count": 1,
      "session.view.do_owner_actor_profile_ms": 5,
      "session.view.do_spine_done_mirror_ms": 9,
      "session.view.do_spine_done_mirror_outcome": "fallback",
      "session.view.do_spine_done_mirror_error_class": "Error",
      "session.view.worker_actor_profiles_ms": 7,
      "session.view.worker_actor_profiles_outcome": "success",
      "session.view.worker_ui_lifecycle_stage_ms": 13,
      "session.view.worker_ui_lifecycle_stage_outcome": "fallback",
      "session.view.worker_ui_lifecycle_stage_error_class": "Error",
      "session.view.worker_parent_metadata_wait_ms": 3,
      "session.view.assembly_cpu_ms": 2,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "session.view.metrics",
        doPromptActorProfilesMs: 11,
        workerActorProfilesMs: 7,
        workerUiLifecycleStageOutcome: "fallback",
      }),
    );
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("records error.message on the route span when repo access verification is unavailable", async () => {
    const session = {
      ...makePayload().session,
      repoOwner: "trycycloid",
      repoName: "cycloid",
    };
    mockGetSessionView.mockResolvedValue({
      status: 200,
      ok: true,
      payload: {
        ...makePayload(),
        session,
      },
    });
    mockVerifyUserRepoAccess.mockRejectedValueOnce(new Error("repo gate offline"));

    const root = startSpan("worker.fetch", { "request.id": "req-session-view-503" });
    let spans = [] as ReturnType<typeof drainSpans>;

    await runInSpan(root, async () => {
      const response = await route.handler(
        new Request("https://worker.test/api/sessions/sess-1/view"),
        createEnv(),
        route.pattern.exec("/api/sessions/sess-1/view")!,
        createAuth("43", { sharedSessions: true, businessMemberIds: ["42", "43"] }),
        { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "Unable to verify repository access. Please try again.",
      });

      endSpan(root, "ok");
      spans = drainSpans();
    });

    const routeSpan = spans.find((span) => span.name === "sessions.view");
    expect(routeSpan).toBeDefined();
    expect(routeSpan?.status).toBe("error");
    expect(routeSpan?.attributes["error.message"]).toBe("Error: repo gate offline");
  });
});
