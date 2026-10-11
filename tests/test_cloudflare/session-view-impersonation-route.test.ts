import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";
import {
  createDurableNamespace,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  type WorkerModule,
} from "./helpers/worker-harness";
import { seedPrompt, seedSandboxState, seedSession } from "./session/helpers";

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  setLoggerErrorHandler: () => {},
}));

let workerModule: WorkerModule;
let sessionRoutesModule: typeof import("../../apps/control-plane-worker/src/routes/sessions");

beforeAll(async () => {
  workerModule = await import("../../apps/control-plane-worker/src/index");
  sessionRoutesModule = await import("../../apps/control-plane-worker/src/routes/sessions");
}, 30_000);

function getSessionViewRoute() {
  const route = sessionRoutesModule.sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      String(candidate.pattern) === String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/view$/),
  );
  if (!route) throw new Error("Session view route not found");
  return route;
}

function createImpersonatedAuth(): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session_token",
    authMode: "impersonated_user_session",
    canAccessAllSessions: false,
    impersonationId: "imp-1",
    readOnly: true,
    user: {
      id: 42,
      githubUserId: 42,
      login: "customer-owner",
      name: "Customer Owner",
      email: "customer@example.com",
      businessId: "biz-customer",
      businessRole: "member",
      sharedSessions: false,
    },
    actorUserId: "71931994",
    actorGithubUserId: 71931994,
    actorUser: {
      id: 71931994,
      githubUserId: 71931994,
      login: "operator",
      name: "Operator",
      email: "operator@trycycloid.com",
      businessId: "295d2abc-d10b-4662-b84d-7bfa66242882",
      businessRole: "admin",
      sharedSessions: false,
    },
  };
}

async function seedDurableSession(env: Env, sessionId: string): Promise<void> {
  const sessionNamespace = env.SESSION as ReturnType<typeof createDurableNamespace>;
  await sessionNamespace.get(sessionId).fetch("https://internal/session/unknown");
  const state = sessionNamespace._getState(sessionId);
  if (!state) throw new Error("Session durable object state not created");
  seedSession(state.storage, {
    sessionId,
    ownerUserId: "42",
    businessId: "biz-customer",
    status: "active",
    title: "Cross-business support session",
    repoOwner: "test-owner",
    repoName: "test-repo",
    baseBranch: "main",
  });
  seedSandboxState(state.storage, { sessionId, status: "ready" });
  seedPrompt(state.storage, {
    promptId: "p-1",
    sessionId,
    promptText: "Investigate the bug",
    status: "completed",
    resultJson: JSON.stringify({ summary: "done" }),
  });
}

describe("session view route under support-view impersonation", () => {
  it("returns the real session view for a cross-business impersonated owner when the durable session exists", async () => {
    const env = {
      SESSION: null,
    } as unknown as Env;
    env.SESSION = createDurableNamespace(workerModule.SessionDO, env as unknown as Record<string, unknown>, {
      sqlStorage: true,
    }) as never;

    await seedDurableSession(env, "sess-cross-business");

    const route = getSessionViewRoute();
    const response = await route.handler(
      new Request("https://worker.test/api/sessions/sess-cross-business/view"),
      env,
      route.pattern.exec("/api/sessions/sess-cross-business/view")!,
      createImpersonatedAuth(),
      { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: {
        sessionId: "sess-cross-business",
        title: "Cross-business support session",
      },
      prompts: {
        items: [{ promptId: "p-1", prompt: "Investigate the bug", status: "completed" }],
        total: 1,
      },
    });
  });
});
