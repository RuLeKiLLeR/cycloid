import { beforeAll, describe, expect, it, vi } from "vitest";

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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

import {
  bulkUpdatePrompts,
  getLatestSessionPlan,
  getPrompts,
  updateSandboxState,
  updateSessionFields,
  upsertSessionPlan,
} from "../../apps/control-plane-worker/src/session/do-db";
import type { PromptState } from "../../apps/control-plane-worker/src/types";
import {
  apiTokenHeaders,
  createWorkerEnv,
  seedAuthUser,
  sessionTokenHeaders,
  workerFetch,
  type WorkerModule,
} from "./helpers";

type SessionNamespace = {
  idFromName(name: string): string;
  _getState(id: string): { storage: { sql: SqlStorage } } | undefined;
};

function makePrompt(overrides: Partial<PromptState>): PromptState {
  const now = new Date().toISOString();
  return {
    promptId: "p-1",
    prompt: "Implement the plan",
    actorUserId: "1001",
    status: "completed",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    result: null,
    error: null,
    ...overrides,
  };
}

function seedParkedPlan(env: Record<string, unknown>, sessionId: string): SqlStorage {
  const namespace = env.SESSION as SessionNamespace;
  const state = namespace._getState(namespace.idFromName(sessionId));
  if (!state) throw new Error(`Missing SessionDO state for ${sessionId}`);
  const sql = state.storage.sql;
  sql.exec("UPDATE session SET plan_mode = 1, plan_approval_required = 1 WHERE session_id = ?", sessionId);
  bulkUpdatePrompts(sql, sessionId, [
    makePrompt({ promptId: "p-1" }),
    makePrompt({
      promptId: "p-2",
      prompt: "Held follow-up",
      status: "queued",
      startedAt: null,
      completedAt: null,
    }),
  ]);
  updateSessionFields(sql, sessionId, { promptCounter: 2 });
  updateSandboxState(sql, sessionId, { status: "spawning" });
  upsertSessionPlan(sql, {
    sessionId,
    planPromptId: "p-1",
    implementationPromptId: null,
    markdown: "# Plan\n\nApproved smoke plan",
    excerpt: "# Plan\n\nApproved smoke plan",
    artifactId: null,
    valid: true,
    missingReason: null,
    missingHeadings: [],
    status: "pending",
    revision: 3,
    userEdited: true,
    source: "generated",
  });
  return sql;
}

describe("smoke: plan approval", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  it("routes a cookie-authenticated customer approval through the DO and preserves splice order", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "plan-owner", 1001, "planowner");
    const headers = sessionTokenHeaders("plan-owner");
    const create = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-plan-approve", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(create.status).toBe(201);
    const sql = seedParkedPlan(env, "s-plan-approve");

    const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-approve/plan/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 3 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      revision: 3,
      implementationPromptId: "p-3",
      idempotent: false,
    });
    expect(getLatestSessionPlan(sql, "s-plan-approve")).toMatchObject({
      status: "approved",
      approvedBy: "1001",
      source: "web",
    });
    expect(getPrompts(sql, "s-plan-approve").map((prompt) => prompt.promptId)).toEqual(["p-1", "p-3", "p-2"]);

    const replay = await workerFetch(workerModule, env, "/api/sessions/s-plan-approve/plan/approve", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 3 }),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ implementationPromptId: "p-3", idempotent: true });
    expect(
      getPrompts(sql, "s-plan-approve").filter((prompt) => prompt.planContext?.planPromptId === "p-1"),
    ).toHaveLength(1);
  });

  it("fails closed for bearer auth, malformed bodies, and stale revisions", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "customer-plan-owner", 1001, "customerowner");
    const customerHeaders = sessionTokenHeaders("customer-plan-owner");
    const create = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ sessionId: "s-plan-denials", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(create.status).toBe(201);
    seedParkedPlan(env, "s-plan-denials");

    const bearer = await workerFetch(workerModule, env, "/api/sessions/s-plan-denials/plan/approve", {
      method: "POST",
      headers: apiTokenHeaders(),
      body: JSON.stringify({ revision: 3 }),
    });
    expect(bearer.status).toBe(403);

    const malformed = await workerFetch(workerModule, env, "/api/sessions/s-plan-denials/plan/approve", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 0 }),
    });
    expect(malformed.status).toBe(400);

    const unsupported = await workerFetch(workerModule, env, "/api/sessions/s-plan-denials/plan/approve", {
      method: "POST",
      headers: { ...customerHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ revision: 3 }),
    });
    expect(unsupported.status).toBe(415);

    const oversized = await workerFetch(workerModule, env, "/api/sessions/s-plan-denials/plan/approve", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3, padding: "x".repeat(300) }),
    });
    expect(oversized.status).toBe(413);

    const missing = await workerFetch(workerModule, env, "/api/sessions/missing-plan-session/plan/approve", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3 }),
    });
    expect(missing.status).toBe(404);

    const stale = await workerFetch(workerModule, env, "/api/sessions/s-plan-denials/plan/approve", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 2 }),
    });
    expect(stale.status).toBe(409);
  });
});
