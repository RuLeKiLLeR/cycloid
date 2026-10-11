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

const mockCreateSessionState = vi.fn();
const mockSyncSessionProjection = vi.fn();
const mockUpsertSessionWebhookRef = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/session/state")>(
    "../../apps/control-plane-worker/src/session/state",
  );
  return {
    ...actual,
    createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
    assertDatabase: () => ({}) as D1Database,
  };
});

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => mockSyncSessionProjection(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  upsertSessionWebhookRef: (...args: unknown[]) => mockUpsertSessionWebhookRef(...args),
}));

import {
  initializeAndProjectSession,
  persistInitialSessionProjection,
  SessionCreateError,
} from "../../apps/control-plane-worker/src/services/session-create";
import type { Env, InternalAuthContext, ReplayState, SessionState } from "../../apps/control-plane-worker/src/types";

const makeEnv = (): Env => ({}) as Env;

const makeSession = (overrides: Partial<SessionState> = {}): SessionState =>
  ({
    sessionId: "sess-1",
    ownerUserId: "42",
    repoOwner: "acme",
    repoName: "webapp",
    ...overrides,
  }) as SessionState;

const makeReplay = (): ReplayState => ({}) as ReplayState;

const makeAuth = (): InternalAuthContext => ({
  userId: "42",
  canAccessAllSessions: false,
  businessId: "biz-1",
  sharedSessions: false,
  email: null,
});

describe("session-create service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSessionState.mockResolvedValue({ session: makeSession(), replay: makeReplay() });
    mockSyncSessionProjection.mockResolvedValue(undefined);
    mockUpsertSessionWebhookRef.mockResolvedValue(undefined);
  });

  describe("persistInitialSessionProjection", () => {
    it("writes the session projection with the supplied source and user id", async () => {
      const session = makeSession();
      const replay = makeReplay();

      await persistInitialSessionProjection(makeEnv(), {
        session,
        replay,
        sessionKind: "repo",
        projectionSource: "routes.sessions.create",
        projectionUserId: "42",
        requestId: "req-1",
      });

      expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
      const opts = mockSyncSessionProjection.mock.calls[0][0];
      expect(opts.sessionId).toBe("sess-1");
      expect(opts.session.sessionKind).toBe("repo");
      expect(opts.replay).toBe(replay);
      expect(opts.richStatus).toBe("idle");
      expect(opts.source).toBe("routes.sessions.create");
      expect(opts.userId).toBe("42");
      expect(opts.requestId).toBe("req-1");
      expect(mockUpsertSessionWebhookRef).not.toHaveBeenCalled();
    });

    it("forwards parent context to the initial projection writer", async () => {
      const parentContext = {
        parentSessionId: "parent-1",
        parentPromptId: "prompt-1",
        spawnedByUserId: 42,
        spawnDepth: 1,
      };

      await persistInitialSessionProjection(makeEnv(), {
        session: makeSession({ sessionId: "child-1", initiationMode: "child" }),
        replay: makeReplay(),
        sessionKind: "repo",
        projectionSource: "routes.sessions.create_child",
        projectionUserId: "42",
        parentContext,
      });

      expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
      expect(mockSyncSessionProjection.mock.calls[0][0]).toMatchObject({
        sessionId: "child-1",
        parentContext,
      });
      expect(mockSyncSessionProjection.mock.calls[0][0].session.initiationMode).toBe("child");
    });

    it("upserts the webhook ref when provided alongside the projection", async () => {
      await persistInitialSessionProjection(makeEnv(), {
        session: makeSession(),
        replay: makeReplay(),
        sessionKind: "repo",
        projectionSource: "routes.sessions.create",
        webhookRef: { source: "github_pr_url", externalRef: "https://github.com/acme/webapp/pull/1" },
      });

      expect(mockUpsertSessionWebhookRef).toHaveBeenCalledWith(
        expect.anything(),
        "github_pr_url",
        "https://github.com/acme/webapp/pull/1",
        "sess-1",
      );
    });

    it("propagates the underlying error when the projection write fails", async () => {
      mockSyncSessionProjection.mockRejectedValueOnce(new Error("d1 down"));

      await expect(
        persistInitialSessionProjection(makeEnv(), {
          session: makeSession(),
          replay: makeReplay(),
          sessionKind: "repo",
          projectionSource: "routes.sessions.create",
        }),
      ).rejects.toThrow("d1 down");
    });
  });

  describe("initializeAndProjectSession", () => {
    it("calls createSessionState then persists the projection and returns the result", async () => {
      const result = await initializeAndProjectSession(makeEnv(), {
        sessionId: "sess-1",
        ownerUserId: "42",
        sessionKind: "repo",
        repoContext: { repoOwner: "acme", repoName: "webapp" },
        auth: makeAuth(),
        installationId: 99,
        model: "gpt-5",
        reasoningEffort: null,
        cold: false,
        projectionSource: "automation.scheduler.tick",
        projectionUserId: "42",
        requestId: "req-2",
      });

      expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
      const createCall = mockCreateSessionState.mock.calls[0];
      expect(createCall[1]).toBe("sess-1");
      expect(createCall[2]).toBe("42");
      expect(createCall[3]).toMatchObject({
        sessionKind: "repo",
        repoContext: { repoOwner: "acme", repoName: "webapp" },
        model: "gpt-5",
        installationId: 99,
      });

      expect(mockSyncSessionProjection).toHaveBeenCalledTimes(1);
      expect(mockSyncSessionProjection.mock.calls[0][0].source).toBe("automation.scheduler.tick");

      expect(result.session.sessionId).toBe("sess-1");
      expect(result.replay).toBeDefined();
    });

    it("wraps initialize failures in SessionCreateError with stage=initialize", async () => {
      mockCreateSessionState.mockRejectedValueOnce(new Error("DO timeout"));

      await expect(
        initializeAndProjectSession(makeEnv(), {
          sessionId: "sess-2",
          ownerUserId: "42",
          sessionKind: "repo",
          auth: makeAuth(),
          model: "gpt-5",
          reasoningEffort: null,
          projectionSource: "automation.scheduler.tick",
        }),
      ).rejects.toMatchObject({
        name: "SessionCreateError",
        stage: "initialize",
      });

      expect(mockSyncSessionProjection).not.toHaveBeenCalled();
    });

    it("wraps projection failures in SessionCreateError with stage=persist", async () => {
      mockSyncSessionProjection.mockRejectedValueOnce(new Error("index unique conflict"));

      const error = await initializeAndProjectSession(makeEnv(), {
        sessionId: "sess-3",
        ownerUserId: "42",
        sessionKind: "repo",
        auth: makeAuth(),
        model: "gpt-5",
        reasoningEffort: null,
        projectionSource: "automation.scheduler.tick",
      }).catch((err) => err);

      expect(error).toBeInstanceOf(SessionCreateError);
      expect((error as SessionCreateError).stage).toBe("persist");
      expect((error as SessionCreateError).cause).toBeInstanceOf(Error);
    });

    it("forwards the webhook ref input to the persistence step using the session id returned by createSessionState", async () => {
      mockCreateSessionState.mockResolvedValueOnce({
        session: makeSession({ sessionId: "sess-4" }),
        replay: makeReplay(),
      });

      await initializeAndProjectSession(makeEnv(), {
        sessionId: "sess-4",
        ownerUserId: "42",
        sessionKind: "repo",
        auth: makeAuth(),
        model: "gpt-5",
        reasoningEffort: null,
        projectionSource: "automation.scheduler.tick",
        webhookRef: { source: "github_pr_url", externalRef: "https://github.com/acme/webapp/pull/9" },
      });

      expect(mockUpsertSessionWebhookRef).toHaveBeenCalledWith(
        expect.anything(),
        "github_pr_url",
        "https://github.com/acme/webapp/pull/9",
        "sess-4",
      );
    });
  });
});
