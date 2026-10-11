import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { upsertSessionPlan } from "../../apps/control-plane-worker/src/session/do-db";
import { generateSandboxPromptCallbackToken } from "../../apps/control-plane-worker/src/utils";
import type { DurableNamespace } from "../test_cloudflare/helpers/worker-harness";
import {
  apiTokenHeaders,
  createWorkerEnv,
  expectProjectionRows,
  flushAllWaitUntil,
  seedAuthUser,
  sessionTokenHeaders,
  workerFetch,
  type WorkerModule,
} from "./helpers";

// The narrowed enqueue response (ARC-1024) no longer carries the sandbox
// callback credential, so the test harness mints it the same way the DO does,
// using the default test SANDBOX_CALLBACK_SECRET from createWorkerTestEnv.
const TEST_SANDBOX_CALLBACK_SECRET = "sandbox-callback-secret";
async function mintCallbackAuth(sessionId: string, promptId: string): Promise<string> {
  return `Bearer ${await generateSandboxPromptCallbackToken(sessionId, promptId, TEST_SANDBOX_CALLBACK_SECRET)}`;
}

describe("smoke: session lifecycle", () => {
  let workerModule: WorkerModule;

  function seedCookieUserInBusiness(
    db: ReturnType<typeof createWorkerEnv>["db"],
    token: string,
    githubUserId: number,
    login: string,
    businessId: string,
    sharedSessions = 0,
  ): number {
    const userId = db.addBusinessUser(githubUserId, login, businessId, sharedSessions);
    db.setAuthToken(token, {
      user_id: userId,
      id: userId,
      expires_at: Date.now() + 60_000,
      login,
      name: null,
      email: null,
      business_id: businessId,
      shared_sessions: sharedSessions,
    });
    return userId;
  }

  function seedPlan(env: Record<string, unknown>, sessionId: string): void {
    const namespace = env.SESSION as DurableNamespace;
    const state = namespace._getState(sessionId);
    if (!state) throw new Error(`Missing SessionDO state for ${sessionId}`);
    upsertSessionPlan(state.storage.sql as unknown as SqlStorage, {
      sessionId,
      planPromptId: "p-plan-2",
      implementationPromptId: null,
      markdown: "# Plan\n\nImplement the approved scope",
      excerpt: "Implement the approved scope",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 2,
      userEdited: true,
      approvedBy: null,
      approvedAt: null,
      source: "edit",
      createdAt: "2026-07-09T15:00:00.000Z",
      updatedAt: "2026-07-09T16:00:00.000Z",
    });
  }

  function markLegacyArchivedIndexRow(
    db: { sessionIndex: Map<string, { status: string; rich_status: string | null; closed_at: string | null }> },
    sessionId: string,
  ): void {
    const row = db.sessionIndex.get(sessionId);
    expect(row).toBeDefined();
    row!.status = "archived";
    row!.rich_status = "archived";
    row!.closed_at ??= new Date().toISOString();
  }

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  describe("GET /api/sessions/:id/plan", () => {
    it("returns the latest plan to its internal owner", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedCookieUserInBusiness(db, "plan-owner", 2001, "planowner", SEEDED_BUSINESS_IDS.cycloid);
      const headers = sessionTokenHeaders("plan-owner");
      const create = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: "s-plan-read",
          repoUrl: "https://github.com/test-owner/test-repo",
          planMode: "off",
        }),
      });
      expect(create.status).toBe(201);
      seedPlan(env, "s-plan-read");

      const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-read/plan", { headers });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "pending",
        revision: 2,
        markdown: "# Plan\n\nImplement the approved scope",
        userEdited: true,
        updatedAt: "2026-07-09T16:00:00.000Z",
        planPromptId: "p-plan-2",
      });
    });

    it("returns 404 when the session has no plan", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedCookieUserInBusiness(db, "plan-empty-owner", 2002, "planempty", SEEDED_BUSINESS_IDS.cycloid);
      const headers = sessionTokenHeaders("plan-empty-owner");
      const create = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: "s-plan-empty",
          repoUrl: "https://github.com/test-owner/test-repo",
          planMode: "off",
        }),
      });
      expect(create.status).toBe(201);

      const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-empty/plan", { headers });

      expect(response.status).toBe(404);
    });

    it("requires browser authentication and rejects bearer access", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedCookieUserInBusiness(db, "plan-bearer-user", 2006, "planbearer", SEEDED_BUSINESS_IDS.cycloid);

      const unauthenticated = await workerFetch(workerModule, env, "/api/sessions/s-plan-auth/plan");
      expect(unauthenticated.status).toBe(401);

      const bearer = await workerFetch(workerModule, env, "/api/sessions/s-plan-auth/plan", {
        headers: apiTokenHeaders(),
      });
      expect(bearer.status).toBe(403);

      const sessionTokenAsBearer = await workerFetch(workerModule, env, "/api/sessions/s-plan-auth/plan", {
        headers: { authorization: "Bearer plan-bearer-user" },
      });
      expect(sessionTokenAsBearer.status).toBe(403);
    });

    it("hides a foreign internal session", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedCookieUserInBusiness(db, "plan-prod-owner", 2003, "planprod", SEEDED_BUSINESS_IDS.cycloid);
      seedCookieUserInBusiness(db, "plan-qa-viewer", 2004, "planqa", SEEDED_BUSINESS_IDS.cycloidQa);
      const ownerHeaders = sessionTokenHeaders("plan-prod-owner");
      const create = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          sessionId: "s-plan-foreign",
          repoUrl: "https://github.com/test-owner/test-repo",
          planMode: "off",
        }),
      });
      expect(create.status).toBe(201);
      seedPlan(env, "s-plan-foreign");

      const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-foreign/plan", {
        headers: sessionTokenHeaders("plan-qa-viewer"),
      });

      expect(response.status).toBe(404);
    });

    it("returns plan data to a customer owner", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedAuthUser(db, "plan-customer-owner", 2005, "plancustomer");
      const headers = sessionTokenHeaders("plan-customer-owner");
      const create = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: "s-plan-customer",
          repoUrl: "https://github.com/test-owner/test-repo",
          planMode: "off",
        }),
      });
      expect(create.status).toBe(201);
      seedPlan(env, "s-plan-customer");

      const response = await workerFetch(workerModule, env, "/api/sessions/s-plan-customer/plan", { headers });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "pending",
        revision: 2,
        planPromptId: "p-plan-2",
      });
    });
  });

  it("admin session create with Slack callbackContext writes both Slack thread refs", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "owner-user", 1001, "owneruser");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: apiTokenHeaders(),
      body: JSON.stringify({
        sessionId: "s-slack-admin",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        callbackContext: {
          source: "slack",
          slackTeamId: "T-SMOKE",
          channel: "C-SMOKE",
          threadTs: "1712345678.009900",
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.ok).toBe(true);
    expect(createBody.session.sessionId).toBe("s-slack-admin");
    expect(createBody.session.callbackContext).toEqual({
      source: "slack",
      slackTeamId: "T-SMOKE",
      channel: "C-SMOKE",
      threadTs: "1712345678.009900",
    });
    expectProjectionRows(db, "s-slack-admin", {
      ownerUserId: "1001",
      status: "active",
      richStatus: "idle",
      minReplaySequence: 0,
    });
    expect(db.slackThreadSessionRefs.get("C-SMOKE:1712345678.009900")).toBe("s-slack-admin");
    expect(db.slackThreadSessionRefs.get("biz-1:T-SMOKE:C-SMOKE:1712345678.009900")).toBe("s-slack-admin");
    expect(db.sessionWebhookRefs.get("slack_thread:C-SMOKE:1712345678.009900")).toEqual(new Set(["s-slack-admin"]));
  });

  it("create -> list -> get -> send prompt -> callback -> events -> close -> verify archived", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "lifecycle-user", 1001, "lifecycleuser");
    const headers = sessionTokenHeaders("lifecycle-user");

    // 1. Create session
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      // planMode:"off" — this exercises the base single-turn queue lifecycle, not
      // plan mode's plan->implement handoff (default-on since ungating).
      body: JSON.stringify({
        sessionId: "s-lifecycle",
        repoUrl: "https://github.com/test-owner/test-repo",
        planMode: "off",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.ok).toBe(true);
    expect(createBody.session.sessionId).toBe("s-lifecycle");
    // Create response returns raw SessionState (storage primitive), so `status`
    // is the SessionState column (active/archived/closed) — not the lifecycle alias.
    expect(createBody.session.status).toBe("active");
    expect(createBody.session.ownerUserId).toBe("1001");
    expectProjectionRows(db, "s-lifecycle", {
      status: "active",
      richStatus: "idle",
      minReplaySequence: 0,
    });
    const replaySequenceAfterCreate = db.replay.get("s-lifecycle")!.last_event_sequence;

    // 2. Verify session appears in list
    const listRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers,
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0].sessionId).toBe("s-lifecycle");
    expect(listBody.sessions[0].status).toBe("idle");

    // 3. Get individual session
    const getRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle", {
      headers,
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.session.sessionId).toBe("s-lifecycle");

    // 4. Send prompt
    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "implement the feature" }),
    });
    expect(promptRes.status).toBe(202);
    const promptBody = await promptRes.json();
    expect(promptBody.ok).toBe(true);
    expect(promptBody.prompt.promptId).toBe("p-1");
    expect(promptBody.prompt.status).toBe("processing");
    expect(promptBody.dispatch).not.toBeNull();
    expect(promptBody.dispatch.sessionId).toBe("s-lifecycle");
    expect(promptBody.dispatch.promptId).toBe("p-1");
    // Narrowed dispatch never carries the prompt text or the callback credential.
    expect(promptBody.dispatch.prompt).toBeUndefined();
    expect(promptBody.dispatch.callback).toBeUndefined();
    expectProjectionRows(db, "s-lifecycle", {
      status: "active",
      minReplaySequence: replaySequenceAfterCreate + 1,
    });

    // 5. Complete via internal callback
    const callbackRes = await workerFetch(
      workerModule,
      env,
      "/internal/sandbox/sessions/s-lifecycle/prompts/p-1/callback",
      {
        method: "POST",
        headers: {
          authorization: await mintCallbackAuth("s-lifecycle", "p-1"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ success: true, result: { summary: "done" } }),
      },
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json();
    expect(callbackBody.completedPrompt.status).toBe("completed");
    expect(callbackBody.nextDispatch).toBeNull();

    // 6. Verify events via SSE endpoint (contains lifecycle events)
    const eventsRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle/events", { headers });
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
    const sseBody = await eventsRes.text();
    // Should contain prompt completion event
    expect(sseBody).toContain("event: prompt_completed");

    // 7. Verify prompts list shows completed
    const promptsListRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle/prompts", { headers });
    expect(promptsListRes.status).toBe(200);
    const promptsListBody = await promptsListRes.json();
    expect(promptsListBody.prompts).toHaveLength(1);
    expect(promptsListBody.prompts[0].status).toBe("completed");

    // 8. Close session (via DELETE)
    const closeRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle", {
      method: "DELETE",
      headers,
    });
    expect(closeRes.status).toBe(200);

    // 9. Verify session is closed in list
    const finalListRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers,
    });
    expect(finalListRes.status).toBe(200);
    const finalListBody = await finalListRes.json();
    expect(finalListBody.sessions[0].status).toBe("archived");

    // 10. Verify D1 index reflects closed status
    expect(db.sessionIndex.get("s-lifecycle")?.status).toBe("archived");

    // 11. Flush DO waitUntil promises (finalizePromptRun, S3 mirroring, manifest)
    await flushAllWaitUntil(env);

    // 12. Verify prompt_runs D1 index was populated by finalizePromptRun
    const promptRunRow = db.promptRuns.get("s-lifecycle:p-1");
    expect(promptRunRow).toBeDefined();
    expect(promptRunRow!.session_id).toBe("s-lifecycle");
    expect(promptRunRow!.prompt_id).toBe("p-1");
    expect(promptRunRow!.outcome).toBe("completed");

    // 13. Verify observability telemetry endpoint returns prompt runs
    const telemetryRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle/telemetry", { headers });
    expect(telemetryRes.status).toBe(200);
    const telemetryBody = await telemetryRes.json();
    expect(telemetryBody.ok).toBe(true);
    expect(telemetryBody.sessionId).toBe("s-lifecycle");
    expect(telemetryBody.promptRuns).toHaveLength(1);
    expect(telemetryBody.promptRuns[0].session_id).toBe("s-lifecycle");

    // 14. Verify observability runs query endpoint
    const runsRes = await workerFetch(workerModule, env, "/api/observability/runs?sessionId=s-lifecycle", { headers });
    expect(runsRes.status).toBe(200);
    const runsBody = await runsRes.json();
    expect(runsBody.ok).toBe(true);
    expect(runsBody.runs).toHaveLength(1);
  });

  it("create session with repo context -> verify repo is stored -> send prompt with dispatch", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "repo-user", 1002, "repouser");
    const headers = sessionTokenHeaders("repo-user");

    // Create session with repo context
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-repo",
        repoUrl: "https://github.com/acme/repo",
        baseBranch: "main",
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.sessionId).toBe("s-repo");

    // Send prompt -> verify narrowed dispatch carries session info but not the prompt
    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-repo/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "add tests" }),
    });
    expect(promptRes.status).toBe(202);
    const promptBody = await promptRes.json();
    expect(promptBody.dispatch.sessionId).toBe("s-repo");
    expect(promptBody.dispatch.promptId).toBe("p-1");
    expect(promptBody.dispatch.prompt).toBeUndefined();
    // The owner's own prompt is fine to echo as display text on the authenticated route.
    expect(promptBody.prompt.displayPrompt).toBe("add tests");
  });

  it("prompt queue processes sequentially: second prompt waits until first completes", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "queue-user", 1003, "queueuser");
    const headers = sessionTokenHeaders("queue-user");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      // planMode:"off" — assert base sequential queue mechanics (p-1 -> p-2)
      // without plan mode's auto-enqueued implement turn shifting the numbering.
      body: JSON.stringify({
        sessionId: "s-queue",
        repoUrl: "https://github.com/test-owner/test-repo",
        planMode: "off",
      }),
    });

    // First prompt -> processing immediately
    const first = await workerFetch(workerModule, env, "/api/sessions/s-queue/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "first task" }),
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.prompt.status).toBe("processing");
    expect(firstBody.dispatch).not.toBeNull();

    // Second prompt -> queued (first still processing)
    const second = await workerFetch(workerModule, env, "/api/sessions/s-queue/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "second task" }),
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    expect(secondBody.prompt.status).toBe("queued");
    expect(secondBody.dispatch).toBeNull();
    expect(secondBody.queue.queuedCount).toBe(1);

    // Complete first -> second auto-advances to processing
    const callbackRes = await workerFetch(
      workerModule,
      env,
      "/internal/sandbox/sessions/s-queue/prompts/p-1/callback",
      {
        method: "POST",
        headers: {
          authorization: await mintCallbackAuth("s-queue", "p-1"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ success: true }),
      },
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json();
    expect(callbackBody.completedPrompt.promptId).toBe("p-1");
    expect(callbackBody.nextDispatch).not.toBeNull();
    expect(callbackBody.nextDispatch.promptId).toBe("p-2");
    expect(callbackBody.queue.processingPromptId).toBe("p-2");

    // Verify prompt list shows correct states
    const promptsRes = await workerFetch(workerModule, env, "/api/sessions/s-queue/prompts", {
      headers,
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].status).toBe("completed");
    expect(promptsBody.prompts[1].status).toBe("processing");
  });

  it("closed session rejects new prompts", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "closed-user", 1004, "closeduser");
    const headers = sessionTokenHeaders("closed-user");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-closed", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    await workerFetch(workerModule, env, "/api/sessions/s-closed", {
      method: "DELETE",
      headers,
    });

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-closed/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "should fail" }),
    });
    expect(promptRes.status).toBe(409);
    const promptBody = await promptRes.json();
    expect(promptBody).toEqual({ ok: false, error: "session_not_sendable", reason: "archived" });
  });

  it("DELETE /api/sessions/:id closes and removes session from index", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "delete-user", 1005, "deleteuser");
    const headers = sessionTokenHeaders("delete-user");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-delete", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    const deleteRes = await workerFetch(workerModule, env, "/api/sessions/s-delete", {
      method: "DELETE",
      headers,
    });
    expect(deleteRes.status).toBe(200);

    // Session still in D1 index but closed
    expect(db.sessionIndex.get("s-delete")?.status).toBe("archived");
  });

  it("rejects session creation with invalid model", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-invalid-user", 1010, "modelinvaliduser");
    const headers = sessionTokenHeaders("model-invalid-user");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-model-invalid",
        repoUrl: "https://github.com/test-owner/test-repo",
        model: "nonexistent-model",
      }),
    });
    expect(createRes.status).toBe(400);
    const body = await createRes.json();
    expect(body.error).toContain("Invalid model");
  });

  it("reuses a live coordinated verification session for the same PR", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "verify-dedupe-user", 1017, "verifydedupeuser");
    const headers = sessionTokenHeaders("verify-dedupe-user");
    const prUrl = "https://github.com/test-owner/test-repo/pull/5";

    const firstRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-verifier-1",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        targetPrUrl: prUrl,
      }),
    });
    expect(firstRes.status).toBeLessThan(300);
    const firstBody = (await firstRes.json()) as Record<string, unknown>;
    expect(typeof firstBody.sessionId).toBe("string");

    const duplicateRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-verifier-2",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        targetPrUrl: prUrl,
      }),
    });
    expect(duplicateRes.status).toBe(201);
    const duplicateBody = (await duplicateRes.json()) as Record<string, unknown>;
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.sessionId).toBe(firstBody.sessionId);

    // Once the live verifier reaches a terminal phase, a new one is allowed.
    // Post-D-51 the per-PR lock table is gone: the entry-point dedup is the
    // findActiveVerificationSession advisory (session status), so flipping the
    // projected status is the whole release (ARC-1173 / ARC-1330 D-51).
    db.sessionIndex.get(firstBody.sessionId as string)!.rich_status = "completed";
    const retryRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-verifier-3",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        targetPrUrl: prUrl,
      }),
    });
    expect(retryRes.status).toBeLessThan(300);
  });

  it("rejects session creation with a non-boolean autoVerify", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "autoverify-invalid-user", 1015, "autoverifyinvaliduser");
    const headers = sessionTokenHeaders("autoverify-invalid-user");

    for (const autoVerify of ["false", 0, null]) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: `s-autoverify-invalid-${String(autoVerify)}`,
          repoUrl: "https://github.com/test-owner/test-repo",
          autoVerify,
        }),
      });
      expect(createRes.status, String(autoVerify)).toBe(400);
      const body = await createRes.json();
      expect(body.error).toContain("autoVerify must be a boolean");
    }
  });

  it("accepts session creation with boolean autoVerify and without it", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "autoverify-valid-user", 1016, "autoverifyvaliduser");
    const headers = sessionTokenHeaders("autoverify-valid-user");

    const cases: Array<{ sessionId: string; autoVerify?: boolean }> = [
      { sessionId: "s-autoverify-false", autoVerify: false },
      { sessionId: "s-autoverify-true", autoVerify: true },
      { sessionId: "s-autoverify-absent" },
    ];
    for (const { sessionId, autoVerify } of cases) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId,
          repoUrl: "https://github.com/test-owner/test-repo",
          ...(autoVerify === undefined ? {} : { autoVerify }),
        }),
      });
      expect(createRes.status, sessionId).toBeLessThan(300);
    }
  });

  it("rejects session creation with an invalid planMode", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "planmode-invalid-user", 1017, "planmodeinvaliduser");
    const headers = sessionTokenHeaders("planmode-invalid-user");

    for (const planMode of [true, false, "AUTO", 3, null]) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: `s-planmode-invalid-${String(planMode)}`,
          repoUrl: "https://github.com/test-owner/test-repo",
          planMode,
        }),
      });
      expect(createRes.status, String(planMode)).toBe(400);
      const body = await createRes.json();
      expect(body.error).toContain('planMode must be one of "off", "on", "auto"');
    }
  });

  it("accepts session creation with enum planMode values and without it", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "planmode-valid-user", 1018, "planmodevaliduser");
    const headers = sessionTokenHeaders("planmode-valid-user");

    const cases: Array<{ sessionId: string; planMode?: "off" | "on" | "auto" }> = [
      { sessionId: "s-planmode-off", planMode: "off" },
      { sessionId: "s-planmode-on", planMode: "on" },
      { sessionId: "s-planmode-auto", planMode: "auto" },
      { sessionId: "s-planmode-absent" },
    ];
    for (const { sessionId, planMode } of cases) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId,
          repoUrl: "https://github.com/test-owner/test-repo",
          ...(planMode === undefined ? {} : { planMode }),
        }),
      });
      expect(createRes.status, sessionId).toBeLessThan(300);
    }
  });

  it("rejects session creation with known non-launch models", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-disallowed-user", 1014, "modeldisalloweduser");
    const headers = sessionTokenHeaders("model-disallowed-user");

    const disallowedModels = [
      "gpt-5.4-pro",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.2-chat-latest",
      "gpt-5.2-codex",
    ];

    for (const model of disallowedModels) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: `s-model-disallowed-${model.replace(/[^a-z0-9]/gi, "-")}`,
          repoUrl: "https://github.com/test-owner/test-repo",
          model,
        }),
      });
      expect(createRes.status, model).toBe(400);
      const body = await createRes.json();
      expect(body.error).toContain(`Invalid model for codex: ${model}`);
    }
  });

  it("accepts session creation with launch allowlist models", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-allowed-user", 1015, "modelalloweduser");
    const headers = sessionTokenHeaders("model-allowed-user");

    const allowedModels = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
    for (const model of allowedModels) {
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: `s-model-allowed-${model.replace(/[^a-z0-9]/gi, "-")}`,
          repoUrl: "https://github.com/test-owner/test-repo",
          model,
        }),
      });
      expect(createRes.status, model).toBe(201);
      const body = await createRes.json();
      expect(body.session.model).toBe(model);
    }
  });

  it("accepts session with valid model and includes it in dispatch", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-valid-user", 1011, "modelvaliduser");
    const headers = sessionTokenHeaders("model-valid-user");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-model-valid",
        repoUrl: "https://github.com/test-owner/test-repo",
        model: "gpt-5.4",
      }),
    });

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-model-valid/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "do something" }),
    });
    expect(promptRes.status).toBe(202);
    const body = await promptRes.json();
    expect(body.prompt.status).toBe("processing");
    // Dispatch contract should include session-level model
    expect(body.dispatch).not.toBeNull();
    expect(body.dispatch.model).toBe("gpt-5.4");
  });

  it("session without model uses the launch default model in dispatch", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-omit-user", 1012, "modelomituser");
    const headers = sessionTokenHeaders("model-omit-user");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-model-omit", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.model).toBe("gpt-5.4");

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-model-omit/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "do something" }),
    });
    expect(promptRes.status).toBe(202);
    const body = await promptRes.json();
    expect(body.dispatch).not.toBeNull();
    expect(body.dispatch.model).toBe("gpt-5.4");
  });

  it("session model is forwarded through queue drain on callback", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "model-drain-user", 1013, "modeldrainuser");
    const headers = sessionTokenHeaders("model-drain-user");

    // Create session with model
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-model-drain",
        repoUrl: "https://github.com/test-owner/test-repo",
        model: "gpt-5.4",
      }),
    });

    // First prompt
    const firstRes = await workerFetch(workerModule, env, "/api/sessions/s-model-drain/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "first task" }),
    });
    const firstBody = await firstRes.json();
    expect(firstBody.prompt.status).toBe("processing");

    // Second prompt (queued)
    const secondRes = await workerFetch(workerModule, env, "/api/sessions/s-model-drain/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "second task" }),
    });
    expect(secondRes.status).toBe(202);
    const secondBody = await secondRes.json();
    expect(secondBody.prompt.status).toBe("queued");

    // Complete first -> second drains with session model in dispatch
    const callbackRes = await workerFetch(
      workerModule,
      env,
      "/internal/sandbox/sessions/s-model-drain/prompts/p-1/callback",
      {
        method: "POST",
        headers: {
          authorization: await mintCallbackAuth("s-model-drain", "p-1"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ success: true }),
      },
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json();
    expect(callbackBody.nextDispatch).not.toBeNull();
    expect(callbackBody.nextDispatch.model).toBe("gpt-5.4");
  });

  it("DELETE /api/sessions removes only legacy archived rows from index", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "clear-all-user", 1020, "clearalluser");
    const headers = sessionTokenHeaders("clear-all-user");

    // Create two sessions
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-clear-1", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-clear-2", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(db.sessionIndex.size).toBe(2);

    // Both are active, so clearing legacy archived rows should not remove them.
    const clearRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "DELETE",
      headers,
    });
    expect(clearRes.status).toBe(204);
    expect(db.sessionIndex.size).toBe(2);
  });

  it("DELETE /api/sessions removes legacy archived rows but preserves active ones", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "clear-mixed-user", 1021, "clearmixeduser");
    const headers = sessionTokenHeaders("clear-mixed-user");

    // Create session then close it via single-session DELETE.
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-already-closed", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, `/api/sessions/s-already-closed`, {
      method: "DELETE",
      headers,
    });
    expect(db.sessionIndex.get("s-already-closed")?.status).toBe("archived");
    markLegacyArchivedIndexRow(db, "s-already-closed");
    expect(db.sessionIndex.get("s-already-closed")?.status).toBe("archived");

    // Create another session that stays active
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-still-active", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    expect(db.sessionIndex.size).toBe(2);

    // Clear legacy archived rows -- should only remove s-already-closed.
    const clearRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "DELETE",
      headers,
    });
    expect(clearRes.status).toBe(204);
    expect(db.sessionIndex.size).toBe(1);
    expect(db.sessionIndex.has("s-still-active")).toBe(true);
    expect(db.sessionIndex.has("s-already-closed")).toBe(false);
  });

  it("DELETE /api/sessions preserves active session that still accepts prompts", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "clear-prompt-user", 1024, "clearpromptuser");
    const headers = sessionTokenHeaders("clear-prompt-user");

    // Create an active session
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-survives", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    // Create and close another session so there's a legacy archived index row to clear.
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-archived", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, `/api/sessions/s-archived`, { method: "DELETE", headers });
    expect(db.sessionIndex.get("s-archived")?.status).toBe("archived");
    markLegacyArchivedIndexRow(db, "s-archived");
    expect(db.sessionIndex.get("s-archived")?.status).toBe("archived");

    // Bulk clear removes only the legacy archived index row.
    const clearRes = await workerFetch(workerModule, env, "/api/sessions", { method: "DELETE", headers });
    expect(clearRes.status).toBe(204);
    expect(db.sessionIndex.has("s-survives")).toBe(true);
    expect(db.sessionIndex.has("s-archived")).toBe(false);

    // Prove the surviving active session still accepts a prompt
    const sendRes = await workerFetch(workerModule, env, "/api/sessions/s-survives/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "do something after clear" }),
    });
    expect(sendRes.status).toBe(202);

    // Session is still visible via GET
    const getRes = await workerFetch(workerModule, env, "/api/sessions/s-survives", { method: "GET", headers });
    expect(getRes.status).toBe(200);
  });

  it("DELETE /api/sessions scopes to authenticated user's legacy archived sessions", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "clear-user-a", 1022, "clearusera");
    seedAuthUser(db, "clear-user-b", 1023, "clearuserb");
    const headersA = sessionTokenHeaders("clear-user-a");
    const headersB = sessionTokenHeaders("clear-user-b");

    // User A creates a session and ends up with a legacy archived index row.
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: headersA,
      body: JSON.stringify({ sessionId: "s-user-a", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, `/api/sessions/s-user-a`, {
      method: "DELETE",
      headers: headersA,
    });
    expect(db.sessionIndex.get("s-user-a")?.status).toBe("archived");
    markLegacyArchivedIndexRow(db, "s-user-a");
    expect(db.sessionIndex.get("s-user-a")?.status).toBe("archived");

    // User B creates a session and ends up with a legacy archived index row.
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: headersB,
      body: JSON.stringify({ sessionId: "s-user-b", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, `/api/sessions/s-user-b`, {
      method: "DELETE",
      headers: headersB,
    });
    expect(db.sessionIndex.get("s-user-b")?.status).toBe("archived");
    markLegacyArchivedIndexRow(db, "s-user-b");
    expect(db.sessionIndex.get("s-user-b")?.status).toBe("archived");
    expect(db.sessionIndex.size).toBe(2);

    // User A clears legacy archived rows -- should only remove their own stale row.
    const clearRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "DELETE",
      headers: headersA,
    });
    expect(clearRes.status).toBe(204);

    // User B's legacy archived row is still there.
    expect(db.sessionIndex.size).toBe(1);
    expect(db.sessionIndex.has("s-user-b")).toBe(true);
  });

  it("keeps archived sessions terminal and removes unarchive", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "resume-user", 1004, "resumeuser");
    const headers = sessionTokenHeaders("resume-user");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-resume",
        repoUrl: "https://github.com/test-owner/test-repo",
        baseBranch: "main",
      }),
    });
    expect(createRes.status).toBe(201);

    const archiveRes = await workerFetch(workerModule, env, "/api/sessions/s-resume", {
      method: "DELETE",
      headers,
    });
    expect(archiveRes.status).toBe(200);

    const unarchiveRes = await workerFetch(workerModule, env, "/api/sessions/s-resume/unarchive", {
      method: "POST",
      headers,
    });
    expect(unarchiveRes.status).toBe(404);
    expectProjectionRows(db, "s-resume", {
      status: "archived",
      richStatus: "archived",
    });

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-resume/prompts", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "try to continue archived work" }),
    });
    expect(promptRes.status).toBe(409);
  });

  it("returns 404 when unarchive is called on an active session", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "unarchive-user", 1005, "unarchiveuser");
    const headers = sessionTokenHeaders("unarchive-user");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-unarchive-idempotent",
        repoUrl: "https://github.com/test-owner/test-repo",
        baseBranch: "main",
      }),
    });
    expect(createRes.status).toBe(201);

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-unarchive-idempotent", {
      headers,
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.phase).toBe("idle");
    expect(db.sessionIndex.get("s-unarchive-idempotent")?.rich_status).toBe("idle");

    const unarchiveRes = await workerFetch(workerModule, env, "/api/sessions/s-unarchive-idempotent/unarchive", {
      method: "POST",
      headers,
    });
    expect(unarchiveRes.status).toBe(404);
    expect(db.sessionIndex.get("s-unarchive-idempotent")?.rich_status).toBe("idle");
  });

  it("auto-stop keeps projection tables in sync when an idle disconnected session is stopped by alarm", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "auto-stop-user", 1006, "idle-stop-user");
    const headers = sessionTokenHeaders("auto-stop-user");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "s-auto-stop",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createRes.status).toBe(201);
    expectProjectionRows(db, "s-auto-stop", {
      status: "active",
      richStatus: "idle",
      minReplaySequence: 0,
    });
    const replaySequenceBeforeAlarm = db.replay.get("s-auto-stop")!.last_event_sequence;

    const sessionNamespace = env.SESSION as {
      idFromName(name: string): string;
      _getState(id: string): { storage: { sql: { exec(query: string, ...params: unknown[]): void } } } | undefined;
    };
    const sessionDoId = sessionNamespace.idFromName("s-auto-stop");
    const state = sessionNamespace._getState(sessionDoId);
    expect(state).toBeDefined();
    state!.storage.sql.exec(
      "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
      Date.now(),
      "s-auto-stop",
    );

    const sessionDo = new workerModule.SessionDO(state as unknown, env) as WorkerModule["SessionDO"] & {
      alarm(): Promise<void>;
    };
    await sessionDo.alarm();

    expectProjectionRows(db, "s-auto-stop", {
      status: "active",
      richStatus: "stopped",
      minReplaySequence: replaySequenceBeforeAlarm + 1,
    });
  });

  it("GET /api/sessions/:id does not reinsert a bulk-cleared legacy archived session into the index", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "clear-resurrect-user", 1025, "clearresurrect");
    const headers = sessionTokenHeaders("clear-resurrect-user");

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "s-cleared-archived", repoUrl: "https://github.com/test-owner/test-repo" }),
    });
    await workerFetch(workerModule, env, "/api/sessions/s-cleared-archived", {
      method: "DELETE",
      headers,
    });
    expect(db.sessionIndex.get("s-cleared-archived")?.status).toBe("archived");
    markLegacyArchivedIndexRow(db, "s-cleared-archived");
    expect(db.sessionIndex.get("s-cleared-archived")?.status).toBe("archived");

    const clearRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "DELETE",
      headers,
    });
    expect(clearRes.status).toBe(204);
    expect(db.sessionIndex.has("s-cleared-archived")).toBe(false);

    const getRes = await workerFetch(workerModule, env, "/api/sessions/s-cleared-archived", {
      method: "GET",
      headers,
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.session.sessionId).toBe("s-cleared-archived");
    expect(getBody.session.phase).toBe("archived");
    expect(db.sessionIndex.has("s-cleared-archived")).toBe(false);
  });
});
