import { beforeEach, describe, expect, it, vi } from "vitest";

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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const mockGetSessionState = vi.fn();
const mockCreateSessionState = vi.fn();
const mockCloseSessionState = vi.fn();
const mockEnqueueSessionPrompt = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockSyncRuntimeBackendProjection = vi.fn();
const mockPublishSessionUpsertedFromDb = vi.fn();
const mockBroadcastSessionSnapshot = vi.fn();
const mockResolveChildSessionParentPromptId = vi.fn();
const mockValidateChildSessionCreation = vi.fn();
const mockReserveChildSessionCapacity = vi.fn();
const mockReleaseUnprojectedChildSessionCapacity = vi.fn();
const mockMarkChildSessionCapacityProjected = vi.fn();
const mockGetChildSessionLimitTelemetryCounts = vi.fn();
const mockReadIdempotencyKeyHeader = vi.fn();
const mockBeginIdempotentRequest = vi.fn();
const mockCommitIdempotentRequest = vi.fn();
const mockReleaseIdempotentRequest = vi.fn();
const mockPostStructuredEventToDd = vi.fn();
const mockFindActiveVerificationSession = vi.fn();
const mockCheckVerificationRunLimit = vi.fn();
const mockSyncVerificationStateForPr = vi.fn();
const mockUpsertSessionWebhookRef = vi.fn();
const mockRequestCoordinatedVerification = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
    closeSessionState: (...args: unknown[]) => mockCloseSessionState(...args),
    enqueueSessionPrompt: (...args: unknown[]) => mockEnqueueSessionPrompt(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncRuntimeBackendProjection: (...args: unknown[]) => mockSyncRuntimeBackendProjection(...args),
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/feed-delta", () => ({
  publishSessionClosedFromDb: vi.fn(),
  publishSessionUpsertedFromDb: (...args: unknown[]) => mockPublishSessionUpsertedFromDb(...args),
}));

vi.mock("../../apps/control-plane-worker/src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/utils")>(
    "../../apps/control-plane-worker/src/utils",
  );
  return {
    ...actual,
    broadcastSessionSnapshot: (...args: unknown[]) => mockBroadcastSessionSnapshot(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/child-session", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/services/child-session")>(
    "../../apps/control-plane-worker/src/services/child-session",
  );
  return {
    ...actual,
    resolveChildSessionParentPromptId: (...args: unknown[]) => mockResolveChildSessionParentPromptId(...args),
    validateChildSessionCreation: (...args: unknown[]) => mockValidateChildSessionCreation(...args),
    reserveChildSessionCapacity: (...args: unknown[]) => mockReserveChildSessionCapacity(...args),
    releaseUnprojectedChildSessionCapacity: (...args: unknown[]) => mockReleaseUnprojectedChildSessionCapacity(...args),
    markChildSessionCapacityProjected: (...args: unknown[]) => mockMarkChildSessionCapacityProjected(...args),
    getChildSessionLimitTelemetryCounts: (...args: unknown[]) => mockGetChildSessionLimitTelemetryCounts(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-gate", () => ({
  findActiveVerificationSession: (...args: unknown[]) => mockFindActiveVerificationSession(...args),
  checkVerificationRunLimit: (...args: unknown[]) => mockCheckVerificationRunLimit(...args),
  verificationRunLimitMessage: (currentRuns: number, maxRuns: number) =>
    `Verification has already run ${currentRuns} of ${maxRuns} times for this pull request.`,
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-state", () => ({
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-coordinator-service", () => ({
  requestCoordinatedVerification: (...args: unknown[]) => mockRequestCoordinatedVerification(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/webhooks/db")>(
    "../../apps/control-plane-worker/src/webhooks/db",
  );
  return {
    ...actual,
    upsertSessionWebhookRef: (...args: unknown[]) => mockUpsertSessionWebhookRef(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/idempotency", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/services/idempotency")>(
    "../../apps/control-plane-worker/src/services/idempotency",
  );
  return {
    ...actual,
    readIdempotencyKeyHeader: (...args: unknown[]) => mockReadIdempotencyKeyHeader(...args),
    beginIdempotentRequest: (...args: unknown[]) => mockBeginIdempotentRequest(...args),
    commitIdempotentRequest: (...args: unknown[]) => mockCommitIdempotentRequest(...args),
    releaseIdempotentRequest: (...args: unknown[]) => mockReleaseIdempotentRequest(...args),
  };
});

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import { OpencodeAccessDeniedError } from "../../apps/control-plane-worker/src/services/opencode-access-gate";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const IDEM_TOKEN = { key: "idem-key-1", ownerUserId: "42", route: "child-session:parent-1" };

function makeAuth(): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    user: {
      id: 42,
      login: "user-42",
      name: null,
      email: null,
      businessId: "biz-1",
      businessRole: "member",
      sharedSessions: false,
      linearConnected: false,
      slackConnected: false,
      slackNeedsReconnect: false,
    },
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    FRONTEND_URL: "https://app.test",
  } as Env;
}

function getCreateChildRoute() {
  const path = "/api/sessions/parent-1/child-sessions";
  const route = sessionRoutes.find((candidate) => candidate.method === "POST" && candidate.pattern.test(path));
  if (!route) throw new Error("Create child-session route not found");
  return { route, path };
}

function defaultPlan() {
  return {
    parent: {
      session_id: "parent-1",
      owner_user_id: 42,
      business_id: "biz-1",
      repo_owner: "trycycloid",
      repo_name: "cycloid",
      installation_id: 99,
      runtime_backend: "e2b_cloud",
      agent_runtime_backend: "codex",
      spawn_depth: 0,
    },
    parentContext: {
      parentSessionId: "parent-1",
      parentPromptId: "prompt-1",
      spawnedByUserId: 42,
      spawnDepth: 1,
    },
    childRepoOwner: "trycycloid",
    childRepoName: "cycloid",
    installationId: 99,
    request: {
      prompt: "spawn one",
      repositoryId: "trycycloid/cycloid",
      parentPromptId: "prompt-1",
    },
  };
}

async function callCreateChild(body: object, ctx?: ExecutionContext): Promise<Response> {
  const { route, path } = getCreateChildRoute();
  return route.handler(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": "idem-key-1" },
    }),
    makeEnv(),
    route.pattern.exec(path)!,
    makeAuth(),
    ctx,
  );
}

describe("child-session create idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionState.mockResolvedValue({
      sessionId: "parent-1",
      ownerUserId: "42",
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      status: "active",
    });
    mockReadIdempotencyKeyHeader.mockReturnValue("idem-key-1");
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "proceed", token: IDEM_TOKEN });
    mockCommitIdempotentRequest.mockResolvedValue(undefined);
    mockReleaseIdempotentRequest.mockResolvedValue(undefined);
    mockResolveChildSessionParentPromptId.mockResolvedValue({ parentPromptId: "prompt-1", source: "active_prompt" });
    mockValidateChildSessionCreation.mockResolvedValue({ ok: true, plan: defaultPlan() });
    mockReserveChildSessionCapacity.mockResolvedValue({ ok: true });
    mockGetChildSessionLimitTelemetryCounts.mockResolvedValue({ perPrompt: 1, perSession: 1, concurrent: 1 });
    mockCreateSessionState.mockImplementation(
      async (_env, sessionId: string, _ownerUserId: string, options: { initiationMode?: string }) => ({
        session: {
          sessionId,
          ownerUserId: "42",
          title: "child",
          status: "active",
          initiationMode: options.initiationMode,
        },
        replay: [],
      }),
    );
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockSyncRuntimeBackendProjection.mockResolvedValue(undefined);
    mockMarkChildSessionCapacityProjected.mockResolvedValue(undefined);
    mockEnqueueSessionPrompt.mockImplementation(async (_env, sessionId: string) => ({
      ok: true,
      payload: { session: { sessionId, ownerUserId: "42", status: "active" }, replay: [] },
    }));
    mockPublishSessionUpsertedFromDb.mockResolvedValue(undefined);
    mockBroadcastSessionSnapshot.mockResolvedValue(undefined);
    mockReleaseUnprojectedChildSessionCapacity.mockResolvedValue(undefined);
    mockCloseSessionState.mockResolvedValue(null);
    mockPostStructuredEventToDd.mockResolvedValue(true);
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationRunLimit.mockResolvedValue({ allowed: true, currentRuns: 0, maxRuns: 3, reason: null });
    mockSyncVerificationStateForPr.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
    mockRequestCoordinatedVerification.mockResolvedValue({
      ok: true,
      sessionId: "coordinated-qa-session",
      coordinatorSessionId: "pr-coord",
      prUrl: "https://github.com/trycycloid/cycloid/pull/6395",
      headSha: "head-sha",
      duplicate: false,
    });
  });

  it("replays before capacity reservation", async () => {
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "replay", resolvedId: "child-existing" });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      childSessionId: "child-existing",
      childSessionUrl: "https://app.test/sessions/child-existing",
      idempotentReplay: true,
    });
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "spawn_child_session.create", surface: "control_plane", outcome: "replay" }),
    );
    expect(mockReserveChildSessionCapacity).not.toHaveBeenCalled();
  });

  it("rejects same key with a different payload before capacity reservation", async () => {
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "reject", reason: "payload_mismatch", status: 409 });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "payload_mismatch" } });
    expect(mockReserveChildSessionCapacity).not.toHaveBeenCalled();
  });

  it("returns retryable in-progress rejection before capacity reservation", async () => {
    mockBeginIdempotentRequest.mockResolvedValue({ kind: "reject", reason: "in_progress", status: 409 });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "in_progress" } });
    expect(mockReserveChildSessionCapacity).not.toHaveBeenCalled();
  });

  it("commits the child session id after initial enqueue succeeds", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise) } as ExecutionContext;
    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" }, ctx);
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(201);
    expect(mockBeginIdempotentRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mockReserveChildSessionCapacity.mock.invocationCallOrder[0],
    );
    expect(mockCommitIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN, expect.any(String));
    expect(mockCommitIdempotentRequest.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockEnqueueSessionPrompt.mock.invocationCallOrder[0],
    );
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({ initiationMode: "child" }),
    );
    expect(mockSyncSessionProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        parentContext: {
          parentSessionId: "parent-1",
          parentPromptId: "prompt-1",
          spawnedByUserId: 42,
          spawnDepth: 1,
        },
        session: expect.objectContaining({ initiationMode: "child" }),
      }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "spawn_child_session.create",
        surface: "control_plane",
        outcome: "success",
        perPromptCountAfterCreate: 1,
      }),
    );
    expect(mockReleaseIdempotentRequest).not.toHaveBeenCalled();
  });

  it("routes QA child sessions through the coordinator with parent projection context", async () => {
    const response = await callCreateChild({
      prompt: "qa=true\n\nVerify https://github.com/trycycloid/cycloid/pull/6395",
      repositoryId: "trycycloid/cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/6395",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      childSessionId: "coordinated-qa-session",
      parentSessionId: "parent-1",
      parentPromptId: "prompt-1",
      spawnDepth: 1,
      promptAlreadyEnqueued: true,
      duplicate: false,
    });
    expect(mockRequestCoordinatedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "child_session",
        ownerUserId: "42",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        installationId: 99,
        prUrl: "https://github.com/trycycloid/cycloid/pull/6395",
        childParentContext: {
          parentSessionId: "parent-1",
          parentPromptId: "prompt-1",
          spawnedByUserId: 42,
          spawnDepth: 1,
        },
      }),
    );
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockSyncSessionProjection).not.toHaveBeenCalled();
    expect(mockUpsertSessionWebhookRef).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalled();
    expect(mockCommitIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN, "coordinated-qa-session");
  });

  it("maps admitted_elsewhere from QA child coordination to a 409", async () => {
    mockRequestCoordinatedVerification.mockResolvedValue({
      ok: false,
      reason: "admitted_elsewhere",
    });

    const response = await callCreateChild({
      prompt: "qa=true\n\nVerify https://github.com/trycycloid/cycloid/pull/6395",
      repositoryId: "trycycloid/cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/6395",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "concurrent_limit_exceeded",
        details: { reason: "admitted_elsewhere" },
      },
    });
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
  });

  it("rejects QA child sessions when the prompt has multiple distinct pull request URLs", async () => {
    const response = await callCreateChild({
      prompt:
        "qa=true\n\nVerify https://github.com/trycycloid/cycloid/pull/6395 and https://github.com/trycycloid/cycloid/pull/6396",
      repositoryId: "trycycloid/cycloid",
      qa: true,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: expect.stringContaining("multiple GitHub pull request URLs"),
      },
    });
    expect(mockBeginIdempotentRequest).not.toHaveBeenCalled();
    expect(mockValidateChildSessionCreation).not.toHaveBeenCalled();
  });

  it("lets an explicit QA target override multiple prompt pull request URLs for child sessions", async () => {
    const response = await callCreateChild({
      prompt:
        "qa=true\n\nVerify https://github.com/trycycloid/cycloid/pull/6395 and https://github.com/trycycloid/cycloid/pull/6396",
      repositoryId: "trycycloid/cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/6397",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.childSessionId).toBe("coordinated-qa-session");
    expect(mockRequestCoordinatedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "child_session",
        prUrl: "https://github.com/trycycloid/cycloid/pull/6397",
      }),
    );
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("inherits the parent opencode backend and default model for child sessions", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: "opencode" },
      },
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        agentRuntimeBackend: "opencode",
        model: "kimi-k2.7-code",
      }),
    );
  });

  it("maps shared opencode entitlement denial to a clean child-session 403", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: "opencode" },
      },
    });
    mockCreateSessionState.mockRejectedValueOnce(
      new OpencodeAccessDeniedError({ businessId: "biz-1", sessionId: "child-session-1" }),
    );

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "opencode_access_denied",
      message: "opencode is only available to Cycloid team members",
    });
    expect(mockReleaseUnprojectedChildSessionCapacity).toHaveBeenCalled();
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
  });

  it("inherits the parent claude_code backend and default model for child sessions", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: "claude_code" },
      },
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        agentRuntimeBackend: "claude_code",
        model: "claude-opus-4-8",
      }),
    );
  });

  it("keeps explicit models scoped to the inherited parent backend", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: "opencode" },
      },
    });

    const response = await callCreateChild({
      prompt: "spawn one",
      repositoryId: "trycycloid/cycloid",
      model: "gpt-5.5",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "invalid_model" } });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
  });

  it("returns a structured error for invalid persisted parent agent backend values", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: "unknown_backend" },
      },
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", message: "Parent session agent runtime backend is invalid" },
    });
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
  });

  it("falls back to codex for legacy parent rows with null agent runtime backend", async () => {
    mockValidateChildSessionCreation.mockResolvedValue({
      ok: true,
      plan: {
        ...defaultPlan(),
        parent: { ...defaultPlan().parent, agent_runtime_backend: null },
      },
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        agentRuntimeBackend: "codex",
        model: "gpt-5.4",
      }),
    );
  });

  it("rolls back the projected child and releases the idempotency claim when enqueue throws", async () => {
    mockEnqueueSessionPrompt.mockRejectedValue(new Error("enqueue unavailable"));
    mockCloseSessionState.mockResolvedValue({
      session: { sessionId: "child-threw", ownerUserId: "42", status: "archived" },
      replay: [],
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", message: "Failed to enqueue initial prompt for child session" },
    });
    expect(mockCloseSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      null,
      expect.objectContaining({ reason: "child_session_enqueue_threw" }),
    );
    expect(mockSyncSessionProjection).toHaveBeenCalledWith(
      expect.objectContaining({ source: "routes.sessions.create_child.rollback" }),
    );
    expect(mockCommitIdempotentRequest).not.toHaveBeenCalled();
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
    expect(mockReleaseUnprojectedChildSessionCapacity).not.toHaveBeenCalled();
  });

  it("does not release the idempotency claim or projected capacity after a post-enqueue throw", async () => {
    mockSyncSessionProjection.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("projection down"));

    await expect(callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" })).rejects.toThrow(
      "projection down",
    );

    expect(mockEnqueueSessionPrompt).toHaveBeenCalled();
    expect(mockCommitIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN, expect.any(String));
    expect(mockReleaseIdempotentRequest).not.toHaveBeenCalled();
    expect(mockReleaseUnprojectedChildSessionCapacity).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim when capacity rejects", async () => {
    mockReserveChildSessionCapacity.mockResolvedValue({
      ok: false,
      error: { code: "max_children_per_prompt", message: "cap reached" },
    });

    const response = await callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" });

    expect(response.status).toBe(429);
    expect(mockCommitIdempotentRequest).not.toHaveBeenCalled();
    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
  });

  it("releases the idempotency claim and reservation after a thrown failure", async () => {
    mockValidateChildSessionCreation.mockRejectedValue(new Error("db unavailable"));

    await expect(callCreateChild({ prompt: "spawn one", repositoryId: "trycycloid/cycloid" })).rejects.toThrow(
      "db unavailable",
    );

    expect(mockReleaseIdempotentRequest).toHaveBeenCalledWith(expect.anything(), IDEM_TOKEN);
    expect(mockReleaseUnprojectedChildSessionCapacity).not.toHaveBeenCalled();
  });
});
