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

const mockGetSessionState = vi.fn();
const mockRetrySessionPrompt = vi.fn();
const mockSetSessionRepo = vi.fn();
const mockVerifyRepoAccessAndInstallation = vi.fn();
const mockCheckSessionResumeRateLimit = vi.fn();
const mockNotifyUserBlocked = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    retrySessionPrompt: (...args: unknown[]) => mockRetrySessionPrompt(...args),
    setSessionRepo: (...args: unknown[]) => mockSetSessionRepo(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockVerifyRepoAccessAndInstallation(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/session-resume-rate-limiter", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/services/session-resume-rate-limiter")
  >("../../apps/control-plane-worker/src/services/session-resume-rate-limiter");
  return {
    ...actual,
    checkSessionResumeRateLimit: (...args: unknown[]) => mockCheckSessionResumeRateLimit(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: (...args: unknown[]) => mockNotifyUserBlocked(...args),
}));

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const OWNER_ID = "42";

function createAuth(userId: string = OWNER_ID): AuthInfo {
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
    },
  } as unknown as AuthInfo;
}

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    ownerUserId: OWNER_ID,
    businessId: "biz-1",
    status: "active",
    phase: "failed",
    repoOwner: "acme",
    repoName: "widgets",
    baseBranch: "main",
    ...overrides,
  };
}

function getRetryRoute() {
  const route = sessionRoutes.find(
    (candidate) => candidate.method === "POST" && String(candidate.pattern).includes("retry"),
  );
  if (!route) throw new Error("Session retry route not found");
  return route;
}

function invoke(auth: AuthInfo | null = createAuth()) {
  const route = getRetryRoute();
  const request = new Request("https://test/api/sessions/sess-1/retry", { method: "POST" });
  const match = "/api/sessions/sess-1/retry".match(route.pattern)!;
  const env = { DB: {} as D1Database } as unknown as Env;
  return route.handler(request, env, match, auth);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionState.mockResolvedValue(makeSession());
  mockCheckSessionResumeRateLimit.mockResolvedValue({ limited: false });
  mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 77 });
  mockSetSessionRepo.mockResolvedValue({ ok: true });
  mockRetrySessionPrompt.mockResolvedValue({ ok: true, status: "running" });
});

describe("POST /api/sessions/:sessionId/retry", () => {
  it("retries an eligible session (202) through the session service", async () => {
    const res = await invoke();
    expect(res.status).toBe(202);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ok: true, status: "running" });
    expect(mockRetrySessionPrompt).toHaveBeenCalledWith(expect.anything(), "sess-1", null);
  });

  it("rejects an ineligible phase with the structured 409 envelope", async () => {
    for (const phase of ["finalizing", "archived"]) {
      mockGetSessionState.mockResolvedValue(makeSession({ phase }));
      const res = await invoke();
      expect(res.status).toBe(409);
    }
    // Fail closed on an absent phase.
    mockGetSessionState.mockResolvedValue(makeSession({ phase: undefined }));
    const res = await invoke();
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      error: "session_not_retryable",
      reason: "unknown",
    });
    expect(mockRetrySessionPrompt).not.toHaveBeenCalled();
  });

  it("rejects an archived session before touching the DO", async () => {
    mockGetSessionState.mockResolvedValue(makeSession({ status: "archived" }));
    const res = await invoke();
    expect(res.status).toBe(409);
    expect(mockRetrySessionPrompt).not.toHaveBeenCalled();
  });

  it("rate-limits rapid retries with a 429 before repo work", async () => {
    mockCheckSessionResumeRateLimit.mockResolvedValue({ limited: true });
    const res = await invoke();
    expect(res.status).toBe(429);
    expect(mockVerifyRepoAccessAndInstallation).not.toHaveBeenCalled();
    expect(mockRetrySessionPrompt).not.toHaveBeenCalled();
  });

  it("surfaces the DO's double-call idempotency rejection as a 409", async () => {
    // First call wins.
    expect((await invoke()).status).toBe(202);
    // The second call reaches the DO, which refuses to double-clone.
    mockRetrySessionPrompt.mockResolvedValue({
      ok: false,
      error: "session_not_retryable",
      reason: "retry_in_progress",
    });
    const res = await invoke();
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ reason: "retry_in_progress" });
  });

  it("fails closed when repo access re-validation is denied", async () => {
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "repo_access_denied",
      response: new Response(JSON.stringify({ ok: false }), { status: 403 }),
    });
    const res = await invoke();
    expect(res.status).toBe(403);
    expect(mockRetrySessionPrompt).not.toHaveBeenCalled();
  });

  it("throws on a missing auth context (router bug guard), never retrying", async () => {
    await expect(invoke(null)).rejects.toThrow(/requireRouteAuth/);
    expect(mockRetrySessionPrompt).not.toHaveBeenCalled();
  });

  it("404s unknown sessions without leaking existence", async () => {
    mockGetSessionState.mockResolvedValue(null);
    const res = await invoke();
    expect(res.status).toBe(404);
  });
});
