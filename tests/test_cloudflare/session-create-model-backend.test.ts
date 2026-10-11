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
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const mockGateGithubSessionStart = vi.fn();
const mockVerifyRepoAccessAndInstallation = vi.fn();
const mockCreateSessionState = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockAdmitSessionCreate = vi.fn();
const mockGetUserSettingsIfExists = vi.fn();
const mockFindActiveVerificationSession = vi.fn();
const mockCheckVerificationRunLimit = vi.fn();
const mockSyncVerificationStateForPr = vi.fn();
const mockUpsertSessionWebhookRef = vi.fn();
const mockRequestCoordinatedVerification = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGateGithubSessionStart(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockVerifyRepoAccessAndInstallation(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/session-admission", () => ({
  admitSessionCreate: (...args: unknown[]) => mockAdmitSessionCreate(...args),
}));

vi.mock("../../apps/control-plane-worker/src/settings/db", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/settings/db")>(
    "../../apps/control-plane-worker/src/settings/db",
  );
  return {
    ...actual,
    getUserSettingsIfExists: (...args: unknown[]) => mockGetUserSettingsIfExists(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/verification-gate", () => ({
  findActiveVerificationSession: (...args: unknown[]) => mockFindActiveVerificationSession(...args),
  checkVerificationRunLimit: (...args: unknown[]) => mockCheckVerificationRunLimit(...args),
  verificationRunLimitMessage: () => "Verification run limit reached",
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-state", () => ({
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-coordinator-service", () => ({
  requestCoordinatedVerification: (...args: unknown[]) => mockRequestCoordinatedVerification(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr",
  upsertSessionWebhookRef: (...args: unknown[]) => mockUpsertSessionWebhookRef(...args),
}));

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

function makeAdminAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "admin-token",
    tokenSource: "bearer",
    authMode: "admin_token",
    canAccessAllSessions: true,
    ...overrides,
  };
}

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    REPOS_CACHE: {} as KVNamespace,
  } as Env;
}

function getCreateSessionRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/sessions"),
  );
  if (!route) throw new Error("Create session route not found");
  return route;
}

async function postCreate(body: Record<string, unknown>, auth: AuthInfo = makeAdminAuth()) {
  const route = getCreateSessionRoute();
  return route.handler(
    new Request("https://worker.test/api/sessions", { method: "POST", body: JSON.stringify(body) }),
    makeEnv(),
    route.pattern.exec("/api/sessions")!,
    auth,
  );
}

describe("session create model/backend scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 99 });
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({
      session: { sessionId: "sess-1", ownerUserId: "1001" },
      replay: [],
    });
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockAdmitSessionCreate.mockResolvedValue({ ok: true });
    mockGetUserSettingsIfExists.mockResolvedValue(null);
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationRunLimit.mockResolvedValue({ allowed: true, currentRuns: 0, maxRuns: 3 });
    mockSyncVerificationStateForPr.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
  });

  it("derives claude_code from a Claude model when agentRuntimeBackend is omitted", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      model: "claude-opus-4-8",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        model: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
      }),
    );
  });

  it("keeps the codex default when agentRuntimeBackend and model are omitted", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        agentRuntimeBackend: "codex",
      }),
    );
  });

  it("rejects a Claude model on an explicitly requested codex backend", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "codex",
      model: "claude-opus-4-8",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model for codex");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("accepts GPT-5.4 Mini on the codex backend", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      model: "gpt-5.4-mini",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        model: "gpt-5.4-mini",
        agentRuntimeBackend: "codex",
      }),
    );
  });

  it("rejects GPT-5.4 Nano on the codex backend because Codex tool_search is incompatible", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "codex",
      model: "gpt-5.4-nano",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model for codex");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("creates a non-explicit codex session at the backend default model with no routing metadata", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      prompt: "Fix a typo in the README docs",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        model: "gpt-5.4",
        agentRuntimeBackend: "codex",
      }),
    );
    // The removed routing subsystem must not reappear as a createSessionState option.
    const createArgs = mockCreateSessionState.mock.calls[0][3] as Record<string, unknown>;
    const removedRoutingKey = `model${"Routing"}`;
    expect(Object.keys(createArgs)).not.toContain(removedRoutingKey);
  });

  it("ignores client-supplied OpenAI flex service tier flags", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      useOpenAIFlexServiceTier: true,
      agents: {
        default: {
          useOpenAIFlexServiceTier: true,
        },
      },
    });

    expect(response.status).toBe(201);
    const createArgs = mockCreateSessionState.mock.calls[0][3] as Record<string, unknown>;
    expect(createArgs.useOpenAIFlexServiceTier).toBeUndefined();
    expect(createArgs.agentOverrides).toMatchObject({
      default: {},
    });
  });

  it("accepts GPT-5.6 Sol on the codex backend with max reasoning", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        model: "gpt-5.6-sol",
        agentRuntimeBackend: "codex",
        reasoningEffort: "max",
      }),
    );
  });

  it("rejects unsupported reasoning for GPT-5.6 Sol", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid reasoningEffort for model gpt-5.6-sol: ultra");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects an OpenAI model on the claude_code backend", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "claude_code",
      model: "gpt-5.6-sol",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid model for claude_code");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects an unknown agentRuntimeBackend", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "bogus",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid agentRuntimeBackend");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("accepts a Claude model on the claude_code backend and threads both into createSessionState", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "claude_code",
      model: "claude-opus-4-8",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        model: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
      }),
    );
  });
});

describe("session create onboarding flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 99 });
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({
      session: { sessionId: "sess-1", ownerUserId: "1001" },
      replay: [],
    });
    mockSyncSessionProjection.mockResolvedValue(undefined);
  });

  it("threads onboard agent runtime metadata into createSessionState", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: true,
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({
        agentRole: "implementation",
        agentProfile: "onboard",
        harnessKind: "codex-session",
        runtimeStartupProfile: "implementation_default",
      }),
    );
  });

  it("keeps the default build profile when onboarding is absent", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ agentProfile: "build", agentRole: "implementation" }),
    );
  });

  it("ignores non-boolean onboarding values", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: "yes",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ agentProfile: "build" }),
    );
  });

  it("rejects onboarding combined with qa", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: true,
      qa: true,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("onboarding and qa are mutually exclusive");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects onboarding combined with qa", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: true,
      qa: true,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("onboarding and qa are mutually exclusive");
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });
});

describe("session create qa flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 99 });
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({
      session: { sessionId: "sess-1", ownerUserId: "1001" },
      replay: [],
    });
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockGetUserSettingsIfExists.mockResolvedValue(null);
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationRunLimit.mockResolvedValue({ allowed: true, currentRuns: 0, maxRuns: 3 });
    mockSyncVerificationStateForPr.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
    mockRequestCoordinatedVerification.mockResolvedValue({
      ok: true,
      sessionId: "verifier-1",
      coordinatorSessionId: "pr-coord",
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      headSha: "head-1",
      duplicate: false,
    });
  });

  it("routes qa through the PR coordinator and returns the verifier session", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionId: "verifier-1",
        targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
        promptAlreadyEnqueued: true,
      }),
    );
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockRequestCoordinatedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        ownerUserId: "1001",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        installationId: 99,
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      }),
    );
  });

  it("rejects the removed verify public QA alias", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      verify: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("verify is no longer supported; use qa instead");
    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects removed verify aliases before session creation", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      qa: true,
      verify: false,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("verify is no longer supported; use qa instead");
    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("rejects explicit non-boolean public qa aliases", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      qa: "true",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("qa must be a boolean, got: true");
    expect(mockGateGithubSessionStart).not.toHaveBeenCalled();
    expect(mockCreateSessionState).not.toHaveBeenCalled();
  });

  it("routes opencode qa through the PR coordinator", async () => {
    const response = await postCreate(
      {
        ownerUserId: 1001,
        repoOwner: "trycycloid",
        repoName: "cycloid",
        agentRuntimeBackend: "opencode",
        qa: true,
        targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      },
      makeAdminAuth({ user: { businessId: SEEDED_BUSINESS_IDS.cycloidQa } as AuthInfo["user"] }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockRequestCoordinatedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      }),
    );
  });

  it("threads QA runtime overrides into the PR coordinator", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      agentRuntimeBackend: "claude_code",
      model: "claude-opus-4-8",
      reasoningEffort: "high",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockRequestCoordinatedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
        reasoningEffort: "high",
      }),
    );
  });

  it("disables auto-verify for onboarding sessions so RLA and VA never run on the setup PR", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: true,
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ agentProfile: "onboard", autoVerify: false }),
    );
  });

  it("forces auto-verify off for onboarding even when autoVerify is explicitly requested", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      onboarding: true,
      autoVerify: true,
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ agentProfile: "onboard", autoVerify: false }),
    );
  });

  it("threads an explicit autoVerify through unchanged for non-onboarding sessions", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      autoVerify: true,
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "1001",
      expect.objectContaining({ agentProfile: "build", autoVerify: true }),
    );
  });
});

describe("session create qa flag auto-verify behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateGithubSessionStart.mockResolvedValue({ ok: true, installationId: 99 });
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 99 });
    mockCreateSessionState.mockResolvedValue({
      session: { sessionId: "sess-1", ownerUserId: "1001" },
      replay: [],
    });
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationRunLimit.mockResolvedValue({ allowed: true, currentRuns: 0, maxRuns: 3 });
    mockSyncVerificationStateForPr.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
    mockRequestCoordinatedVerification.mockResolvedValue({
      ok: true,
      sessionId: "verifier-1",
      coordinatorSessionId: "pr-coord",
      prUrl: "https://github.com/trycycloid/cycloid/pull/123",
      headSha: "head-1",
      duplicate: false,
    });
  });

  it("does not create a normal QA tester session when autoVerify is omitted", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockRequestCoordinatedVerification).toHaveBeenCalled();
  });

  it("does not create a normal QA tester session when autoVerify is explicitly requested", async () => {
    const response = await postCreate({
      ownerUserId: 1001,
      repoOwner: "trycycloid",
      repoName: "cycloid",
      qa: true,
      targetPrUrl: "https://github.com/trycycloid/cycloid/pull/123",
      autoVerify: true,
    });

    expect(response.status).toBe(201);
    expect(mockCreateSessionState).not.toHaveBeenCalled();
    expect(mockRequestCoordinatedVerification).toHaveBeenCalled();
  });
});
