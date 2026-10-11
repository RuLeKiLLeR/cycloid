import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionStateMock,
  enqueueSessionPromptMock,
  listSessionPromptsMock,
  closeSessionForWebhookMock,
  syncSessionProjectionMock,
  postStructuredEventToDdMock,
  writeLifecycleMock,
  verifyUserRepoAccessMock,
} = vi.hoisted(() => ({
  createSessionStateMock: vi.fn(),
  enqueueSessionPromptMock: vi.fn(),
  listSessionPromptsMock: vi.fn(),
  closeSessionForWebhookMock: vi.fn(),
  syncSessionProjectionMock: vi.fn(),
  postStructuredEventToDdMock: vi.fn(),
  writeLifecycleMock: vi.fn(),
  verifyUserRepoAccessMock: vi.fn(),
}));

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

vi.mock("../../apps/control-plane-worker/src/webhooks/verify", async (importActual) => ({
  ...(await importActual<object>()),
  verifyLinearWebhookSignature: async () => true,
}));

vi.mock("../../apps/control-plane-worker/src/session/state", async (importActual) => ({
  ...(await importActual<object>()),
  createSessionState: (...args: unknown[]) => createSessionStateMock(...args),
  enqueueSessionPrompt: (...args: unknown[]) => enqueueSessionPromptMock(...args),
  listSessionPrompts: (...args: unknown[]) => listSessionPromptsMock(...args),
  closeSessionForWebhook: (...args: unknown[]) => closeSessionForWebhookMock(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: (...args: unknown[]) => syncSessionProjectionMock(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => postStructuredEventToDdMock(...args),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/service", async (importActual) => ({
  ...(await importActual<object>()),
  writeIntegrationLifecycleEvent: (...args: unknown[]) => writeLifecycleMock(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", async (importActual) => ({
  ...(await importActual<object>()),
  verifyUserRepoAccess: (...args: unknown[]) => verifyUserRepoAccessMock(...args),
}));

import type { Env } from "../../apps/control-plane-worker/src/types";
import { upsertLinearWebhookInstallation } from "../../apps/control-plane-worker/src/webhooks/db";
import { handleLinearWebhook } from "../../apps/control-plane-worker/src/webhooks/linear-handler";
import { createControlPlaneD1, seedBusiness, seedUser } from "./helpers/seed-db";

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    LINEAR_WEBHOOK_SECRET: "linear-secret",
  } as unknown as Env;
}

async function seedLinearWebhookActor(db: D1Database, defaultModel: string): Promise<void> {
  const now = Date.now();
  const sqlite = (db as unknown as { db: { prepare: Database.Database["prepare"] } }).db;
  seedBusiness(sqlite, { id: "biz-linear", name: "Linear Test", createdAt: now, updatedAt: now });
  seedUser(sqlite, { id: 42, githubId: 4242, login: "linear-actor", businessId: "biz-linear" });
  await db
    .prepare(
      `INSERT INTO user_integrations (
         user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
         api_key, external_user_id, service_url, encrypted, connected_at, updated_at
       ) VALUES (?, 'linear', NULL, NULL, NULL, NULL, ?, NULL, 0, ?, ?)`,
    )
    .bind(42, "linear-user-42", now, now)
    .run();
  await db
    .prepare("INSERT INTO user_settings (user_id, default_repo, default_model) VALUES (?, ?, ?)")
    .bind(42, "https://github.com/acme/linear-default", defaultModel)
    .run();
  await db
    .prepare(
      `INSERT INTO github_installations (
         installation_id, owner_login, owner_id, owner_type, repository_selection, permissions_json, events_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(123, "acme", 1, "Organization", "all", "{}", "[]")
    .run();
  await upsertLinearWebhookInstallation(db, {
    businessId: "biz-linear",
    linearOrganizationId: "linear-org-1",
    linearWebhookId: "linear-hook-1",
    connectedByUserId: 42,
  });
}

function linearWebhookBody(issueId: string): string {
  return JSON.stringify({
    organizationId: "linear-org-1",
    webhookId: "linear-hook-1",
    webhookTimestamp: Date.now(),
    type: "Issue",
    action: "create",
    actor: { id: "linear-user-42", type: "User", name: "Linear Actor" },
    data: {
      id: issueId,
      identifier: "ARC-1171",
      url: "https://linear.app/cycloid2/issue/ARC-1171/test",
      title: "Start a session from Linear",
      description: "Use the actor default model.",
      labels: [{ name: "cycloid" }],
    },
  });
}

async function postLinearWebhook(env: Env, issueId: string): Promise<Response> {
  const body = linearWebhookBody(issueId);
  return handleLinearWebhook(
    new Request("https://control.test/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": "test-signature",
        "linear-delivery": `delivery-${issueId}`,
      },
      body,
    }),
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createSessionStateMock.mockImplementation(async (_env: unknown, sessionId: string) => ({
    session: { sessionId, businessId: "biz-linear" },
    replay: {},
  }));
  enqueueSessionPromptMock.mockImplementation(async (_env: unknown, sessionId: string) => ({
    ok: true,
    status: 200,
    payload: {
      session: { sessionId, businessId: "biz-linear" },
      replay: {},
      prompt: { promptId: "prompt-1", session_id: sessionId, status: "queued", prompt: "queued prompt" },
      dispatch: null,
    },
  }));
  listSessionPromptsMock.mockResolvedValue({ ok: true, payload: { prompts: [] } });
  closeSessionForWebhookMock.mockResolvedValue({ closed: true, session: null });
  syncSessionProjectionMock.mockResolvedValue(undefined);
  postStructuredEventToDdMock.mockResolvedValue(undefined);
  writeLifecycleMock.mockResolvedValue("lifecycle-event-1");
  verifyUserRepoAccessMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Linear webhook session start model defaults", () => {
  it.each([
    ["anthropic:claude-opus-4-8", "claude-opus-4-8", "claude_code"],
    ["openai:gpt-5.4", "gpt-5.4", "codex"],
  ])("routes %s to createSessionState as model %s", async (storedDefault, model, agentRuntimeBackend) => {
    const { d1 } = createControlPlaneD1();
    await seedLinearWebhookActor(d1, storedDefault);

    const env = makeEnv(d1);
    const res = await postLinearWebhook(env, `issue-${model}`);
    const body = (await res.json()) as { created?: boolean };

    expect(res.status).toBe(200);
    expect(body.created).toBe(true);
    expect(createSessionStateMock).toHaveBeenCalledOnce();
    expect(createSessionStateMock).toHaveBeenCalledWith(
      env,
      expect.any(String),
      "42",
      expect.objectContaining({
        repoContext: { repoOwner: "acme", repoName: "linear-default" },
        installationId: 123,
        agentRuntimeBackend,
        model,
      }),
    );
    expect(closeSessionForWebhookMock).not.toHaveBeenCalled();
  });
});
