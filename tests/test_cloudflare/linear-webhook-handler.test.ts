// Tests for the Linear webhook handler's issue-claim lifecycle: bootstrap
// failure cleanup (release the issue ref + close the empty session), the
// stale-ref liveness/displacement check, and the post-enqueue guard that keeps
// projection failures from tearing down a live session.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

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

// Signature verification is covered by its own suite; accept all signatures here.
vi.mock("../../apps/control-plane-worker/src/webhooks/verify", async (importActual) => ({
  ...(await importActual<object>()),
  verifyLinearWebhookSignature: async () => true,
}));

const writeLifecycle = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "evt-id");
vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/service", async (importActual) => ({
  ...(await importActual<object>()),
  writeIntegrationLifecycleEvent: (...args: unknown[]) => writeLifecycle(...args),
}));

const mockSyncProjection = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("../../apps/control-plane-worker/src/services/session-projection", async (importActual) => ({
  ...(await importActual<object>()),
  syncSessionProjection: (...args: unknown[]) => mockSyncProjection(...args),
}));

const mockPostDdEvent = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", async (importActual) => ({
  ...(await importActual<object>()),
  postStructuredEventToDd: (...args: unknown[]) => mockPostDdEvent(...args),
}));

const mockCloseSession = vi.fn<(...args: unknown[]) => Promise<{ closed: boolean; session: unknown }>>(async () => ({
  closed: true,
  session: null,
}));
const mockCreateSessionState = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEnqueuePrompt = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockListSessionPrompts = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("../../apps/control-plane-worker/src/session/state", async (importActual) => ({
  ...(await importActual<object>()),
  closeSessionForWebhook: (...args: unknown[]) => mockCloseSession(...args),
  createSessionState: (...args: unknown[]) => mockCreateSessionState(...args),
  enqueueSessionPrompt: (...args: unknown[]) => mockEnqueuePrompt(...args),
  // The durable phase runner detects an already-enqueued prompt via this; no
  // SessionDO binding exists in this suite, so stub it to "no prior prompt".
  listSessionPrompts: (...args: unknown[]) => mockListSessionPrompts(...args),
}));

const mockGetLinearToken = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
vi.mock("../../apps/control-plane-worker/src/auth/db", async (importActual) => ({
  ...(await importActual<object>()),
  getValidLinearToken: (...args: unknown[]) => mockGetLinearToken(...args),
}));

const mockFetchLinearIssueImages = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const mockFindLinearAttachment = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
const mockLinkLinearIssue = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  success: true,
  externalId: "att-1",
}));
vi.mock("../../apps/control-plane-worker/src/webhooks/linear", async (importActual) => ({
  ...(await importActual<object>()),
  fetchLinearIssueImages: (...args: unknown[]) => mockFetchLinearIssueImages(...args),
  findLinearAttachmentExternalIdByUrl: (...args: unknown[]) => mockFindLinearAttachment(...args),
  linkSessionToLinearIssue: (...args: unknown[]) => mockLinkLinearIssue(...args),
}));

const mockResolveTenant = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockResolveActor = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockResolveRepo = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockAuthorizeRepo = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCreateAndPersist = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockNotifySkip = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("../../apps/control-plane-worker/src/webhooks/shared", async (importActual) => ({
  ...(await importActual<object>()),
  resolveLinearWebhookTenantContext: (...args: unknown[]) => mockResolveTenant(...args),
  resolveLinearIssueActorContext: (...args: unknown[]) => mockResolveActor(...args),
  resolveLinearWebhookRepo: (...args: unknown[]) => mockResolveRepo(...args),
  authorizeLinearWebhookRepo: (...args: unknown[]) => mockAuthorizeRepo(...args),
  createAndPersistLinearWebhookSession: (...args: unknown[]) => mockCreateAndPersist(...args),
  // The handler builds the prompt before claiming; stub it so tests do not hit
  // the Linear API.
  buildLinearBootstrapPrompt: async () => "BOOTSTRAP_PROMPT",
  notifyLinearWebhookSkip: (...args: unknown[]) => mockNotifySkip(...args),
}));

import type { Env } from "../../apps/control-plane-worker/src/types";
import { handleLinearWebhook } from "../../apps/control-plane-worker/src/webhooks/linear-handler";

// --- Minimal D1 adapter over better-sqlite3 with all migrations applied ---
class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly d1: SqliteD1,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  private guard() {
    if (this.d1.failQueryPattern && this.query.includes(this.d1.failQueryPattern)) {
      throw new Error(`injected D1 failure for: ${this.d1.failQueryPattern}`);
    }
  }
  async run() {
    this.guard();
    const result = this.d1.sqlite.prepare(this.query).run(...(this.boundValues as never[]));
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    this.guard();
    return (this.d1.sqlite.prepare(this.query).get(...(this.boundValues as never[])) as T | undefined) ?? null;
  }
  async all<T>() {
    this.guard();
    return { results: this.d1.sqlite.prepare(this.query).all(...(this.boundValues as never[])) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  // When set, any statement whose SQL contains this substring throws.
  failQueryPattern: string | null = null;
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string) {
    return new SqliteD1Statement(this, query);
  }
  async batch(statements: SqliteD1Statement[]) {
    const results: Awaited<ReturnType<SqliteD1Statement["run"]>>[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const ISSUE_ID = "lin-issue-1";
const TENANT = {
  linearOrganizationId: "lin-org",
  linearWebhookId: "lin-hook",
  linearInstallation: { businessId: "biz-1" },
};

function makeEnv(db: SqliteD1): Env {
  return { DB: db, LINEAR_WEBHOOK_SECRET: "secret" } as unknown as Env;
}

function linearBody(issueId = ISSUE_ID, webhookTimestamp = Date.now()): string {
  return JSON.stringify({
    organizationId: "lin-org",
    webhookId: "lin-hook",
    webhookTimestamp,
    type: "Issue",
    action: "update",
    actor: { id: "lin-user-1", type: "User" },
    data: {
      id: issueId,
      identifier: "ARC-1",
      url: "https://linear.app/acme/issue/ARC-1",
      title: "Fix the thing",
      description: "Details",
      labels: [{ name: "cycloid" }],
    },
  });
}

function linearRequestWithBody(deliveryId: string, body: string): Request {
  return new Request("https://cp.test/api/webhooks/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": "sig",
      "linear-delivery": deliveryId,
    },
    body,
  });
}

function linearRequest(deliveryId: string, issueId = ISSUE_ID): Request {
  return linearRequestWithBody(deliveryId, linearBody(issueId));
}

function refRow(db: SqliteD1, issueId = ISSUE_ID): { session_id: string; updated_at: string } | undefined {
  return db.sqlite
    .prepare("SELECT session_id, updated_at FROM linear_issue_session_refs WHERE linear_issue_id = ?")
    .get(issueId) as { session_id: string; updated_at: string } | undefined;
}

function seedSessionIndex(db: SqliteD1, sessionId: string, status: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO session_index (session_id, owner_user_id, status, created_at, updated_at, business_id)
       VALUES (?, 42, ?, ?, ?, 'biz-1')`,
    )
    .run(sessionId, status, Date.now(), Date.now());
}

function seedUserWithSettings(db: SqliteD1, defaultModel: string | null): void {
  const now = Date.now();
  db.sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("biz-1", "Acme", now, now);
  db.sqlite
    .prepare(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(42, 4242, "linear-user", "Linear User", "linear@example.com", null, "biz-1", now, now);
  db.sqlite
    .prepare(
      `INSERT INTO user_settings (
        user_id,
        pr_review_auto_response_enabled,
        self_hosted_sandboxes_opt_in,
        default_model,
        default_repo,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(42, 1, 0, defaultModel, "https://github.com/acme/repo", now, now);
}

function seedRef(db: SqliteD1, sessionId: string, updatedAt: string, issueId = ISSUE_ID): void {
  db.sqlite
    .prepare("INSERT INTO linear_issue_session_refs (linear_issue_id, session_id, updated_at) VALUES (?, ?, ?)")
    .run(issueId, sessionId, updatedAt);
}

const REPO = {
  repoUrl: "https://github.com/acme/repo",
  repoOwner: "acme",
  repoName: "repo",
  repoFromDescription: false,
  repoResolutionSource: "default",
  parsedDescriptionRepo: { repoUrl: null, prompt: null, directivePresent: false },
  linearDefaultModel: null,
  promptContextPromise: null,
  promptContext: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveTenant.mockResolvedValue({ status: "resolved", context: TENANT });
  mockResolveActor.mockResolvedValue({ status: "resolved", context: { ...TENANT, actorUserId: "42" } });
  mockResolveRepo.mockResolvedValue({ status: "resolved", repo: REPO });
  mockAuthorizeRepo.mockResolvedValue({ status: "authorized", authorization: { installationId: 123 } });
  mockCreateAndPersist.mockImplementation(async (params) => {
    const { db, sessionId, linearIssueId } = params as { db: SqliteD1; sessionId: string; linearIssueId: string };
    seedSessionIndex(db, sessionId, "active");
    db.sqlite
      .prepare("INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at) VALUES (?, ?, ?, ?)")
      .run("linear_issue", linearIssueId, sessionId, new Date().toISOString());
    return { sessionId, session: { sessionId, businessId: "biz-1" } };
  });
  mockCreateSessionState.mockImplementation(async (..._args: unknown[]) => {
    const sessionId = _args[1] as string;
    return { session: { sessionId, businessId: "biz-1" }, replay: {} };
  });
  mockListSessionPrompts.mockResolvedValue({ ok: true, payload: { prompts: [] } });
  mockGetLinearToken.mockResolvedValue(null);
  mockFetchLinearIssueImages.mockResolvedValue([]);
  mockFindLinearAttachment.mockResolvedValue(null);
  mockLinkLinearIssue.mockResolvedValue({ success: true, externalId: "att-1" });
  mockEnqueuePrompt.mockResolvedValue({
    ok: true,
    status: 200,
    payload: {
      session: { sessionId: "s", businessId: "biz-1" },
      replay: {},
      prompt: { promptId: "p-1", session_id: "s", status: "queued", prompt: "BOOTSTRAP_PROMPT" },
      dispatch: null,
    },
  });
  mockCloseSession.mockResolvedValue({ closed: true, session: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleLinearWebhook claim lifecycle", () => {
  it("creates a session and claims the issue ref on the happy path", async () => {
    const db = new SqliteD1();
    const res = await handleLinearWebhook(linearRequest("d-1"), makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created?: boolean; sessionId?: string };
    expect(body.created).toBe(true);
    expect(refRow(db)?.session_id).toBe(body.sessionId);
  });

  it("persists fetched Linear issue images on the durable bootstrap job", async () => {
    const db = new SqliteD1();
    mockGetLinearToken.mockResolvedValue("linear-token");
    mockFetchLinearIssueImages.mockResolvedValue([{ name: "linear-shot.png", mediaType: "image/png", data: "aW1n" }]);

    const res = await handleLinearWebhook(linearRequest("d-images"), makeEnv(db));
    expect(res.status).toBe(200);

    const row = db.sqlite
      .prepare("SELECT uploaded_images_json FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ?")
      .get(ISSUE_ID) as { uploaded_images_json: string | null } | undefined;
    expect(row?.uploaded_images_json ? JSON.parse(row.uploaded_images_json) : null).toEqual([
      { name: "linear-shot.png", mediaType: "image/png", data: "aW1n" },
    ]);
    expect(mockFetchLinearIssueImages).toHaveBeenCalledWith("linear-token", ISSUE_ID);
  });

  it("trims Linear issue images before storing them on the durable bootstrap job", async () => {
    const db = new SqliteD1();
    mockGetLinearToken.mockResolvedValue("linear-token");
    mockFetchLinearIssueImages.mockResolvedValue([
      { name: "linear-huge.png", mediaType: "image/png", data: "a".repeat(2_000_000) },
    ]);

    const res = await handleLinearWebhook(linearRequest("d-huge-images"), makeEnv(db));
    expect(res.status).toBe(200);

    const row = db.sqlite
      .prepare("SELECT uploaded_images_json FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ?")
      .get(ISSUE_ID) as { uploaded_images_json: string | null } | undefined;
    expect(row?.uploaded_images_json).toBeNull();
  });

  it("keeps the bootstrap job recoverable when Linear image fetch fails after claim", async () => {
    const db = new SqliteD1();
    mockGetLinearToken.mockResolvedValue("linear-token");
    mockFetchLinearIssueImages.mockRejectedValue(new Error("image timeout"));

    const res = await handleLinearWebhook(linearRequest("d-image-fetch-fails"), makeEnv(db));
    expect(res.status).toBe(200);

    const row = db.sqlite
      .prepare("SELECT session_id, uploaded_images_json FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ?")
      .get(ISSUE_ID) as { session_id: string; uploaded_images_json: string | null } | undefined;
    expect(row?.session_id).toBeTruthy();
    expect(row?.uploaded_images_json).toBeNull();
  });

  it("skips a duplicate delivery via webhook idempotency", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    await handleLinearWebhook(linearRequestWithBody("d-dup", body), env);
    const res = await handleLinearWebhook(linearRequestWithBody("d-dup", body), env);
    const resBody = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(resBody).toMatchObject({ skipped: true, reason: "duplicate" });
  });

  it("dedupes a replayed signed body even when the unsigned linear-delivery header changes", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    await handleLinearWebhook(linearRequestWithBody("d-original", body), env);
    const res = await handleLinearWebhook(linearRequestWithBody("d-tampered", body), env);
    const resBody = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(resBody).toMatchObject({ skipped: true, reason: "duplicate" });
    expect(mockCreateAndPersist).toHaveBeenCalledTimes(1);
  });

  it("dedupes a second webhook against a live session ref", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const first = (await (
      await handleLinearWebhook(linearRequestWithBody("d-a", linearBody(ISSUE_ID, Date.now())), env)
    ).json()) as { sessionId: string };
    // A later label-update webhook carries a different timestamp, so it is not
    // caught by payload-hash idempotency and must dedupe on the issue ref.
    const res = await handleLinearWebhook(linearRequestWithBody("d-b", linearBody(ISSUE_ID, Date.now() + 1)), env);
    const body = (await res.json()) as { skipped?: boolean; reason?: string; sessionId?: string };
    expect(body).toMatchObject({ skipped: true, reason: "session_already_exists", sessionId: first.sessionId });
    expect(mockCreateAndPersist).toHaveBeenCalledTimes(1);
  });

  it("skips Linear comment payloads so agent-created comments cannot start sessions", async () => {
    const db = new SqliteD1();
    const body = JSON.stringify({
      organizationId: "lin-org",
      webhookId: "lin-hook",
      webhookTimestamp: Date.now(),
      type: "Comment",
      action: "create",
      actor: { id: "lin-user-1", type: "User" },
      data: {
        id: "comment-1",
        body: "Agent progress update",
        issue: { id: ISSUE_ID },
      },
    });

    const res = await handleLinearWebhook(linearRequestWithBody("d-comment", body), makeEnv(db));
    const resBody = (await res.json()) as { skipped?: boolean; reason?: string };

    expect(resBody).toMatchObject({ skipped: true });
    expect(mockCreateAndPersist).not.toHaveBeenCalled();
  });

  it("leaves a durable job pending (keeps the ref) when the synchronous enqueue fails, so the sweep recovers", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    // Transient enqueue failure on the in-request attempt: the phase runner
    // reschedules (does not tear down) so the cron sweep can finish the job.
    mockEnqueuePrompt.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await handleLinearWebhook(linearRequest("d-fail"), env);
    const body = (await res.json()) as { created?: boolean; enqueued?: boolean; pending?: boolean; sessionId?: string };
    expect(body.created).toBe(true);
    expect(body.enqueued).toBe(false);
    expect(body.pending).toBe(true);

    // The issue ref and a non-terminal bootstrap job survive for the sweep.
    expect(refRow(db)?.session_id).toBe(body.sessionId);
    const job = db.sqlite
      .prepare("SELECT terminal_outcome, phase FROM linear_webhook_bootstrap_jobs WHERE linear_issue_id = ?")
      .get(ISSUE_ID) as { terminal_outcome: string | null; phase: string } | undefined;
    expect(job?.terminal_outcome).toBeNull();
    expect(mockCloseSession).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim without claiming a ref when repo resolution throws before the claim", async () => {
    const db = new SqliteD1();
    mockResolveRepo.mockRejectedValueOnce(new Error("repo resolution exploded"));

    await expect(handleLinearWebhook(linearRequest("d-pre"), makeEnv(db))).rejects.toThrow("repo resolution exploded");
    expect(refRow(db)).toBeUndefined();
    expect(mockCloseSession).not.toHaveBeenCalled();
  });
});

describe("handleLinearWebhook session-start model resolution", () => {
  async function useRealLinearSessionStartHelpers(): Promise<void> {
    const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/webhooks/shared")>(
      "../../apps/control-plane-worker/src/webhooks/shared",
    );
    mockResolveRepo.mockImplementation((params) =>
      actual.resolveLinearWebhookRepo(params as Parameters<typeof actual.resolveLinearWebhookRepo>[0]),
    );
    mockCreateAndPersist.mockImplementation((params) =>
      actual.createAndPersistLinearWebhookSession(
        params as Parameters<typeof actual.createAndPersistLinearWebhookSession>[0],
      ),
    );
  }

  function expectSingleCreateSessionStateCall(
    env: Env,
    model: string,
    agentRuntimeBackend: "codex" | "claude_code",
  ): void {
    expect(mockCreateSessionState).toHaveBeenCalledTimes(1);
    const call = mockCreateSessionState.mock.calls[0];
    expect(call).toEqual([
      env,
      expect.any(String),
      "42",
      expect.objectContaining({
        agentRuntimeBackend,
        model,
        repoContext: { repoOwner: "acme", repoName: "repo" },
      }),
    ]);
  }

  it("passes a Claude user default model to session creation without OpenAI routing", async () => {
    await useRealLinearSessionStartHelpers();
    const db = new SqliteD1();
    const env = makeEnv(db);
    seedUserWithSettings(db, "anthropic:claude-opus-4-8");

    const res = await handleLinearWebhook(linearRequest("d-model-claude"), env);
    const body = (await res.json()) as { created?: boolean };

    expect(body.created).toBe(true);
    expectSingleCreateSessionStateCall(env, "claude-opus-4-8", "claude_code");
  });

  it("passes a Codex user default model through OpenAI frontier routing", async () => {
    await useRealLinearSessionStartHelpers();
    const db = new SqliteD1();
    const env = makeEnv(db);
    seedUserWithSettings(db, "gpt-5.5");

    const res = await handleLinearWebhook(linearRequest("d-model-codex"), env);
    const body = (await res.json()) as { created?: boolean };

    expect(body.created).toBe(true);
    expectSingleCreateSessionStateCall(env, "gpt-5.5", "codex");
  });
});

describe("handleLinearWebhook stale-ref displacement", () => {
  const OLD = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const FRESH = new Date(Date.now() - 10 * 1000).toISOString();

  it("displaces an old ref pointing at an archived session and closes the zombie", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    seedRef(db, "zombie-1", OLD);
    seedSessionIndex(db, "zombie-1", "archived");

    const res = await handleLinearWebhook(linearRequest("d-displace"), env);
    const body = (await res.json()) as { created?: boolean; sessionId?: string };
    expect(body.created).toBe(true);
    expect(refRow(db)?.session_id).toBe(body.sessionId);
    expect(mockCloseSession).toHaveBeenCalledWith(
      env,
      db,
      "zombie-1",
      expect.objectContaining({ reason: "linear_stale_ref_displaced" }),
    );
  });

  it("displaces an old ref whose session row no longer exists", async () => {
    const db = new SqliteD1();
    seedRef(db, "ghost-1", OLD);

    const res = await handleLinearWebhook(linearRequest("d-ghost"), makeEnv(db));
    const body = (await res.json()) as { created?: boolean };
    expect(body.created).toBe(true);
  });

  it("keeps a fresh ref even when its session is archived (in-flight guard)", async () => {
    const db = new SqliteD1();
    seedRef(db, "young-1", FRESH);
    seedSessionIndex(db, "young-1", "archived");

    const res = await handleLinearWebhook(linearRequest("d-young"), makeEnv(db));
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body).toMatchObject({ skipped: true, reason: "session_already_exists" });
    expect(mockCreateAndPersist).not.toHaveBeenCalled();
  });

  it("keeps an old ref pointing at a live session", async () => {
    const db = new SqliteD1();
    seedRef(db, "live-1", OLD);
    seedSessionIndex(db, "live-1", "active");

    const res = await handleLinearWebhook(linearRequest("d-live"), makeEnv(db));
    const body = (await res.json()) as { skipped?: boolean; reason?: string; sessionId?: string };
    expect(body).toMatchObject({ skipped: true, reason: "session_already_exists", sessionId: "live-1" });
  });

  it("fails closed when the liveness lookup errors", async () => {
    const db = new SqliteD1();
    seedRef(db, "zombie-2", OLD);
    seedSessionIndex(db, "zombie-2", "archived");
    db.failQueryPattern = "FROM session_index WHERE session_id IN";

    const res = await handleLinearWebhook(linearRequest("d-liveness-err"), makeEnv(db));
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body).toMatchObject({ skipped: true, reason: "session_already_exists" });
    expect(mockCreateAndPersist).not.toHaveBeenCalled();
  });
});

describe("handleLinearWebhook timestamp window", () => {
  it("accepts a stale-but-retryable timestamp (2h old)", async () => {
    const db = new SqliteD1();
    const body = linearBody(ISSUE_ID, Date.now() - 2 * 60 * 60 * 1000);
    const res = await handleLinearWebhook(linearRequestWithBody("d-stale-ok", body), makeEnv(db));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
  });

  it("rejects a timestamp older than the 8h retry window", async () => {
    const db = new SqliteD1();
    const body = linearBody(ISSUE_ID, Date.now() - 9 * 60 * 60 * 1000);
    const res = await handleLinearWebhook(linearRequestWithBody("d-too-old", body), makeEnv(db));
    expect(res.status).toBe(401);
  });

  it("accepts small future skew but rejects a far-future timestamp", async () => {
    const db = new SqliteD1();
    const okRes = await handleLinearWebhook(
      linearRequestWithBody("d-future-ok", linearBody(ISSUE_ID, Date.now() + 30 * 1000)),
      makeEnv(db),
    );
    expect(okRes.status).toBe(200);

    const badRes = await handleLinearWebhook(
      linearRequestWithBody("d-future-bad", linearBody("lin-issue-2", Date.now() + 2 * 60 * 1000)),
      makeEnv(db),
    );
    expect(badRes.status).toBe(401);
  });

  it("rejects a missing timestamp", async () => {
    const db = new SqliteD1();
    const body = JSON.stringify({ organizationId: "lin-org", webhookId: "lin-hook", type: "Issue", data: {} });
    const res = await handleLinearWebhook(linearRequestWithBody("d-no-ts", body), makeEnv(db));
    expect(res.status).toBe(401);
  });

  it("evaluates both timestamp gates against a single captured clock value", async () => {
    const db = new SqliteD1();
    const MAX_AGE_MS = 60 * 1000; // mirrors LINEAR_WEBHOOK_MAX_AGE_MS in webhooks/shared.ts
    const base = 1_750_000_000_000;
    // 25ms past the 60s future-skew boundary as measured from `base`.
    const body = linearBody(ISSUE_ID, base + MAX_AGE_MS + 25);
    const req = linearRequestWithBody("d-single-clock", body);

    // First Date.now() returns `base`; any later read jumps 100ms forward. The
    // handler must capture one value and feed it to BOTH timestamp gates, so the
    // future-skew gate still rejects. The pre-fix double-Date.now() let the
    // second (later) read slide the timestamp back inside the window and wrongly
    // accept it — this test fails on that implementation.
    let calls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? base : base + 100));
    try {
      const res = await handleLinearWebhook(req, makeEnv(db));
      expect(res.status).toBe(401);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("handleLinearWebhook retry survivability", () => {
  it("releases the idempotency claim when a failure happens before the repo-resolution stage", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    mockResolveTenant.mockRejectedValueOnce(new Error("tenant lookup D1 reset"));

    await expect(handleLinearWebhook(linearRequestWithBody("d-early", body), env)).rejects.toThrow(
      "tenant lookup D1 reset",
    );

    const res = await handleLinearWebhook(linearRequestWithBody("d-early", body), env);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
  });

  it("keeps the durable job pending and dedupes a same-body redelivery after a transient enqueue failure", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    // Transient enqueue failure: the job is left pending and the idempotency
    // claim is kept (the cron sweep owns recovery, not Linear redelivery).
    mockEnqueuePrompt.mockResolvedValueOnce({ ok: false, status: 500 });

    const first = await handleLinearWebhook(linearRequestWithBody("d-r1", body), env);
    expect(((await first.json()) as { pending?: boolean }).pending).toBe(true);

    const res = await handleLinearWebhook(linearRequestWithBody("d-r1", body), env);
    const resBody = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(resBody).toMatchObject({ skipped: true, reason: "duplicate" });
  });

  it("returns 503 and releases claims for a transient authorization failure without notifying", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    mockAuthorizeRepo.mockResolvedValueOnce({
      status: "skipped",
      reason: "repo_access_verification_failed",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    const res = await handleLinearWebhook(linearRequestWithBody("d-t1", body), env);
    expect(res.status).toBe(503);
    expect((await res.json()) as object).toMatchObject({ ok: false, error: "repo_access_verification_failed" });
    expect(mockNotifySkip).not.toHaveBeenCalled();
    expect(refRow(db)).toBeUndefined();

    // The redelivery reprocesses and succeeds once GitHub recovers.
    const retryRes = await handleLinearWebhook(linearRequestWithBody("d-t1", body), env);
    const retryBody = (await retryRes.json()) as { created?: boolean };
    expect(retryBody.created).toBe(true);
  });

  it("keeps permanent skips at 200, notifies once, and dedupes the redelivery", async () => {
    const db = new SqliteD1();
    const env = makeEnv(db);
    const body = linearBody();
    mockAuthorizeRepo.mockResolvedValue({
      status: "skipped",
      reason: "repo_not_authorized",
      response: new Response(JSON.stringify({ ok: true, skipped: true, reason: "repo_not_authorized" }), {
        status: 200,
      }),
    });

    const res = await handleLinearWebhook(linearRequestWithBody("d-p1", body), env);
    expect(res.status).toBe(200);
    expect(mockNotifySkip).toHaveBeenCalledTimes(1);

    const retryRes = await handleLinearWebhook(linearRequestWithBody("d-p1", body), env);
    const retryBody = (await retryRes.json()) as { skipped?: boolean; reason?: string };
    expect(retryBody).toMatchObject({ skipped: true, reason: "duplicate" });
    expect(mockNotifySkip).toHaveBeenCalledTimes(1);
  });
});

describe("handleLinearWebhook drop observability", () => {
  function makeCtx() {
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
    return { ctx, drain: () => Promise.all(tasks) };
  }

  function ddEvents(): Array<Record<string, unknown>> {
    return mockPostDdEvent.mock.calls.map((call) => call[1] as Record<string, unknown>);
  }

  function lifecycleSkipRows(): Array<Record<string, unknown>> {
    return writeLifecycle.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((row) => row.stage === "session_bootstrap_skipped");
  }

  it("records a delivery-level drop when the timestamp is rejected", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    const body = linearBody(ISSUE_ID, Date.now() - 9 * 60 * 60 * 1000);
    const res = await handleLinearWebhook(linearRequestWithBody("d-obs-ts", body), makeEnv(db), ctx);
    await drain();

    expect(res.status).toBe(401);
    expect(ddEvents()).toContainEqual(
      expect.objectContaining({
        event: "linear.webhook_dropped",
        reason: "webhook_timestamp_rejected",
        deliveryId: "d-obs-ts",
      }),
    );
    expect(lifecycleSkipRows()).toContainEqual(expect.objectContaining({ reasonCode: "webhook_timestamp_rejected" }));
  });

  it("records a tenant-level drop with the resolver's reason", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockResolveTenant.mockResolvedValueOnce({
      status: "skipped",
      reason: "unknown_linear_organization",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    await handleLinearWebhook(linearRequest("d-obs-tenant"), makeEnv(db), ctx);
    await drain();

    expect(ddEvents()).toContainEqual(
      expect.objectContaining({ reason: "unknown_linear_organization", workspaceId: "lin-org" }),
    );
  });

  it("records a Datadog-only drop for actor skips, which already have lifecycle events", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockResolveActor.mockResolvedValueOnce({
      status: "skipped",
      reason: "linear_user_not_connected",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    await handleLinearWebhook(linearRequest("d-obs-actor"), makeEnv(db), ctx);
    await drain();

    expect(ddEvents()).toContainEqual(
      expect.objectContaining({ reason: "linear_user_not_connected", linearIssueId: ISSUE_ID }),
    );
    expect(lifecycleSkipRows()).toHaveLength(0);
  });

  it("records a full drop (lifecycle + Datadog) for integration_disabled, which the resolver does not record", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockResolveActor.mockResolvedValueOnce({
      status: "skipped",
      reason: "integration_disabled",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    await handleLinearWebhook(linearRequest("d-obs-disabled"), makeEnv(db), ctx);
    await drain();

    expect(ddEvents()).toContainEqual(expect.objectContaining({ reason: "integration_disabled" }));
    expect(lifecycleSkipRows()).toContainEqual(expect.objectContaining({ reasonCode: "integration_disabled" }));
  });

  it("maps linear_webhook_unbound_for_revoke to a structured reason code", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockResolveTenant.mockResolvedValueOnce({
      status: "skipped",
      reason: "linear_webhook_unbound_for_revoke",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    await handleLinearWebhook(linearRequest("d-obs-unbound"), makeEnv(db), ctx);
    await drain();

    expect(lifecycleSkipRows()).toContainEqual(expect.objectContaining({ reasonCode: "workspace_mismatch" }));
  });

  it("threads delivery-level fields into the permanent-skip notification", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockAuthorizeRepo.mockResolvedValueOnce({
      status: "skipped",
      reason: "repo_not_authorized",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    await handleLinearWebhook(linearRequest("d-obs-notify"), makeEnv(db), ctx);
    await drain();

    expect(mockNotifySkip).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "repo_not_authorized",
        deliveryId: "d-obs-notify",
        workspaceId: "lin-org",
        payloadHash: expect.any(String),
      }),
    );
  });

  it("records a drop when a stale ref is displaced", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    seedRef(db, "zombie-obs", new Date(Date.now() - 3 * 60 * 1000).toISOString());
    seedSessionIndex(db, "zombie-obs", "archived");

    const res = await handleLinearWebhook(linearRequest("d-obs-displace"), makeEnv(db), ctx);
    await drain();

    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
    expect(ddEvents()).toContainEqual(
      expect.objectContaining({ reason: "stale_session_ref_displaced", sessionId: "zombie-obs" }),
    );
  });

  it("records a transient authorization drop alongside the 503", async () => {
    const db = new SqliteD1();
    const { ctx, drain } = makeCtx();
    mockAuthorizeRepo.mockResolvedValueOnce({
      status: "skipped",
      reason: "repo_access_verification_failed",
      response: new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }),
    });

    const res = await handleLinearWebhook(linearRequest("d-obs-transient"), makeEnv(db), ctx);
    await drain();

    expect(res.status).toBe(503);
    expect(ddEvents()).toContainEqual(
      expect.objectContaining({ reason: "repo_access_verification_failed", linearIssueId: ISSUE_ID }),
    );
  });
});
