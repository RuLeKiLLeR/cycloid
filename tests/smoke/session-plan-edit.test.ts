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
  getLatestSessionPlan,
  updateSandboxState,
  updateSessionFields,
  updateSessionPlanStatus,
  upsertSessionPlan,
} from "../../apps/control-plane-worker/src/session/do-db";
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

// Seed a parked plan that is pending but flagged invalid with a stale S3 artifact
// reference, so a successful edit's clearing of `valid`/`artifact_id`/`missing_reason`
// and its flip of `user_edited` are observable.
function seedParkedPlan(env: Record<string, unknown>, sessionId: string, revision = 3): SqlStorage {
  const namespace = env.SESSION as SessionNamespace;
  const state = namespace._getState(namespace.idFromName(sessionId));
  if (!state) throw new Error(`Missing SessionDO state for ${sessionId}`);
  const sql = state.storage.sql;
  sql.exec("UPDATE session SET plan_mode = 1, plan_approval_required = 1 WHERE session_id = ?", sessionId);
  updateSessionFields(sql, sessionId, { promptCounter: 1 });
  updateSandboxState(sql, sessionId, { status: "spawning" });
  upsertSessionPlan(sql, {
    sessionId,
    planPromptId: "p-1",
    implementationPromptId: null,
    markdown: "# Plan\n\nGenerated draft",
    excerpt: "# Plan\n\nGenerated draft",
    artifactId: "s3-plan-artifact",
    valid: false,
    missingReason: "invalid_plan",
    missingHeadings: [],
    status: "pending",
    revision,
    userEdited: false,
    source: "generated",
  });
  return sql;
}

describe("smoke: session plan edit", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  it("routes a cookie-authenticated customer edit through the DO, rebuilds context, and bumps the revision", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "plan-editor", 1001, "planeditor");
    const headers = sessionTokenHeaders("plan-editor");
    const create = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-plan-edit", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(create.status).toBe(201);
    const sql = seedParkedPlan(env, "s-plan-edit");

    const editedMarkdown = "# Plan\n\nReviewer-edited plan with concrete steps.";
    const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-edit/plan", {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 3, markdown: editedMarkdown }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      planApprovalPending: true,
      revision: 4,
      status: "pending",
    });

    const latest = getLatestSessionPlan(sql, "s-plan-edit");
    expect(latest).toMatchObject({
      revision: 4,
      status: "pending",
      userEdited: true,
      valid: true,
      artifactId: null,
      missingReason: null,
    });
    expect(latest?.markdown).toContain("Reviewer-edited plan with concrete steps.");
    // planContext excerpt is rebuilt from the edited text.
    expect(latest?.excerpt).toContain("Reviewer-edited plan with concrete steps.");

    // The revision advanced, so re-editing against the now-stale revision fails the CAS.
    const stale = await workerFetch(workerModule, env, "/api/sessions/s-plan-edit/plan", {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nAnother edit" }),
    });
    expect(stale.status).toBe(409);
  });

  it("fails closed for bearer auth, unsupported content, empty or oversized markdown, and non-pending or stale revisions", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "customer-editor", 1001, "customereditor");
    const customerHeaders = sessionTokenHeaders("customer-editor");
    const create = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: customerHeaders,
      body: JSON.stringify({ sessionId: "s-edit-denials", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(create.status).toBe(201);
    const sql = seedParkedPlan(env, "s-edit-denials");

    // Bearer / CLI auth is browser-only-rejected.
    const bearer = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: apiTokenHeaders(),
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nEdit" }),
    });
    expect(bearer.status).toBe(403);

    // Missing session resolves before body parsing.
    const missing = await workerFetch(workerModule, env, "/api/sessions/missing-edit-session/plan", {
      method: "PUT",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nEdit" }),
    });
    expect(missing.status).toBe(404);

    // Non-JSON content type.
    const unsupported = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: { ...customerHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nEdit" }),
    });
    expect(unsupported.status).toBe(415);

    // Empty / whitespace-only markdown is rejected before persistence.
    const empty = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3, markdown: "   \n\t  " }),
    });
    expect(empty.status).toBe(400);

    // Oversized markdown exceeds the 60k cap.
    const oversized = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3, markdown: "x".repeat(60_001) }),
    });
    expect(oversized.status).toBe(413);

    // Stale revision loses the compare-and-set.
    const stale = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 2, markdown: "# Plan\n\nEdit" }),
    });
    expect(stale.status).toBe(409);

    // A non-pending (already approved) plan cannot be edited.
    updateSessionPlanStatus(sql, {
      sessionId: "s-edit-denials",
      planPromptId: "p-1",
      status: "approved",
      approvedBy: "1001",
      approvedAt: Date.now(),
      implementationPromptId: "p-2",
    });
    const nonPending = await workerFetch(workerModule, env, "/api/sessions/s-edit-denials/plan", {
      method: "PUT",
      headers: customerHeaders,
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nEdit" }),
    });
    expect(nonPending.status).toBe(409);
  });

  it("returns 429 when the per-user plan-edit limiter is saturated", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "rate-limited-editor", 1001, "ratelimitededitor");
    const headers = sessionTokenHeaders("rate-limited-editor");
    const create = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-edit-throttle", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(create.status).toBe(201);
    seedParkedPlan(env, "s-edit-throttle");

    // Force the durable rate limiter to report the user over cap.
    (env as Record<string, unknown>).SESSION_RESUME_RATE_LIMITER = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, allowed: false, remaining: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    };

    const response = await workerFetch(workerModule, env, "/api/sessions/s-edit-throttle/plan", {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: 3, markdown: "# Plan\n\nEdit blocked by the limiter" }),
    });
    expect(response.status).toBe(429);
  });
});
