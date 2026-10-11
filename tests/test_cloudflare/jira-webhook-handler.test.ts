import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionStateMock,
  enqueueSessionPromptMock,
  closeSessionForWebhookMock,
  syncSessionProjectionMock,
  postStructuredEventToDdMock,
  authorizeWebhookRepoPolicyMock,
  resolveUserSettingsMock,
  emitLifecycleEventMock,
  getValidJiraTokenMock,
} = vi.hoisted(() => ({
  createSessionStateMock: vi.fn(),
  enqueueSessionPromptMock: vi.fn(),
  closeSessionForWebhookMock: vi.fn(),
  syncSessionProjectionMock: vi.fn(),
  postStructuredEventToDdMock: vi.fn(),
  authorizeWebhookRepoPolicyMock: vi.fn(),
  resolveUserSettingsMock: vi.fn(),
  emitLifecycleEventMock: vi.fn(),
  getValidJiraTokenMock: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  createSessionState: createSessionStateMock,
  enqueueSessionPrompt: enqueueSessionPromptMock,
  closeSessionForWebhook: closeSessionForWebhookMock,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: syncSessionProjectionMock,
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: postStructuredEventToDdMock,
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/webhooks/shared")>();
  return {
    ...actual,
    authorizeWebhookRepoPolicy: authorizeWebhookRepoPolicyMock,
    resolveUserSettings: resolveUserSettingsMock,
    emitLifecycleEvent: emitLifecycleEventMock,
  };
});

vi.mock("../../apps/control-plane-worker/src/auth/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/auth/db")>();
  return {
    ...actual,
    getValidJiraToken: getValidJiraTokenMock,
  };
});

import { upsertJiraUserSite } from "../../apps/control-plane-worker/src/integrations/db";
import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  getJiraWebhookInstallationByBusiness,
  getSessionIdByJiraIssueRef,
  upsertJiraWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";
import {
  buildJiraStableDeliveryId,
  fetchJiraIssueComments,
  fetchJiraIssueImages,
  handleJiraWebhook,
  markJiraIssuePickedUp,
  refetchJiraIssue,
} from "../../apps/control-plane-worker/src/webhooks/jira-handler";

const CLIENT_SECRET = "jira-client-secret";
const INSTALL_TOKEN = "tok-installation-1";
const jiraCommentRequests: Array<{ url: string; body: unknown }> = [];
const jiraPickupMutationRequests: Array<{ url: string; method: string; body: unknown }> = [];
let jiraCommentStatus = 201;

class SqliteD1 {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.exec(`
      CREATE TABLE businesses (id TEXT PRIMARY KEY);
      CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT, business_id TEXT);
      CREATE TABLE user_integrations (
        user_id INTEGER NOT NULL,
        integration_id TEXT NOT NULL,
        oauth_access_token TEXT,
        oauth_refresh_token TEXT,
        oauth_expires_at INTEGER,
        api_key TEXT,
        external_user_id TEXT,
        service_url TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        connected_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, integration_id)
      );
      CREATE TABLE webhook_idempotency (
        idempotency_key TEXT PRIMARY KEY, source TEXT NOT NULL, payload_hash TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE session_webhook_refs (
        source TEXT NOT NULL, external_ref TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(source, external_ref, session_id)
      );
      CREATE TABLE session_index (session_id TEXT PRIMARY KEY, status TEXT, rich_status TEXT);
      CREATE TABLE jira_issue_skip_notices (
        jira_issue_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (jira_issue_id, reason)
      );
      INSERT INTO businesses (id) VALUES ('biz-1'), ('biz-2');
      INSERT INTO users (id, login, business_id) VALUES (42, 'actor', 'biz-1'), (77, 'other', 'biz-2');
    `);
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0151_jira_integration.sql"), "utf8"));
  }

  prepare(query: string) {
    const db = this.db;
    let values: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        values = bound;
        return this;
      },
      async run() {
        const info = db.prepare(query).run(...values);
        return { success: true as const, meta: { changes: info.changes } };
      },
      async first<T>() {
        return (db.prepare(query).get(...values) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: db.prepare(query).all(...values) as T[] };
      },
    };
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJiraJwt(secret: string, payload: Record<string, unknown> = {}): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64Url(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...payload })));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`))),
  );
  return `${header}.${body}.${signature}`;
}

interface HarnessOptions {
  refetchedLabels?: string[];
  refetchStatus?: number;
  commentsStatus?: number;
  comments?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  transitionNames?: string[];
}

function stubIssueRefetch(options: HarnessOptions = {}): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/rest/api/3/issue/") && url.includes("/comment") && init?.method !== "POST") {
      if (options.commentsStatus && options.commentsStatus >= 400) {
        return new Response("{}", { status: options.commentsStatus });
      }
      return new Response(
        JSON.stringify({
          comments: options.comments ?? [
            {
              author: { displayName: "Sam Reviewer" },
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Recent Jira comment." }] }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/rest/api/3/issue/") && url.endsWith("/comment")) {
      const rawBody = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "{}";
      jiraCommentRequests.push({ url, body: JSON.parse(rawBody) as unknown });
      return new Response(JSON.stringify({ id: `comment-${jiraCommentRequests.length}` }), {
        status: jiraCommentStatus,
      });
    }
    if (url.includes("/rest/api/3/issue/") && url.endsWith("/transitions")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      jiraPickupMutationRequests.push({ url, method: init?.method ?? "GET", body });
      if (init?.method === "POST") return new Response("", { status: 200 });
      return new Response(
        JSON.stringify({
          transitions: (options.transitionNames ?? ["Started", "In Progress"]).map((name, index) => ({
            id: String(31 - index * 10),
            to: { name, statusCategory: { key: "indeterminate" } },
          })),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/rest/api/3/issue/") && url.endsWith("/assignee")) {
      jiraPickupMutationRequests.push({
        url,
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response("", { status: 200 });
    }
    if (url.includes("/rest/api/3/issue/")) {
      if (options.refetchStatus && options.refetchStatus >= 400) {
        return new Response("{}", { status: options.refetchStatus });
      }
      return new Response(
        JSON.stringify({
          id: "10001",
          key: "ENG-7",
          fields: {
            summary: "Fix the flaky test",
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "It fails often." }] }],
            },
            status: { name: "To Do", statusCategory: { key: "new" } },
            assignee: null,
            issuetype: { name: "Bug" },
            labels: options.refetchedLabels ?? ["cycloid"],
            attachment: options.attachments ?? [],
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

async function seedInstallation(db: D1Database): Promise<void> {
  await upsertJiraWebhookInstallation(db, {
    businessId: "biz-1",
    jiraCloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "Acme",
    installationToken: INSTALL_TOKEN,
    connectedByUserId: 42,
  });
}

async function seedActor(db: D1Database, options: { cloudId?: string } = {}): Promise<void> {
  await upsertJiraUserSite(db, {
    userId: 42,
    jiraCloudId: options.cloudId ?? "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    jiraAccountId: "acct-42",
  });
  (db as unknown as SqliteD1).db
    .prepare(
      "INSERT INTO user_integrations (user_id, integration_id, oauth_access_token, external_user_id, encrypted) VALUES (42, 'jira', 'enc', 'acct-42', 1)",
    )
    .run();
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    JIRA_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    JIRA_TRIGGER_LABEL: "cycloid",
  } as unknown as Env;
}

async function postWebhook(
  env: Env,
  options: {
    body?: Record<string, unknown> | string;
    token?: string;
    jwt?: string | null;
  } = {},
): Promise<Response> {
  const body =
    typeof options.body === "string"
      ? options.body
      : JSON.stringify(
          options.body ?? {
            webhookEvent: "jira:issue_updated",
            issue: { key: "ENG-7", id: "10001" },
            user: { accountId: "acct-42" },
            timestamp: 1718000000000,
          },
        );
  const jwt = options.jwt === undefined ? await signJiraJwt(CLIENT_SECRET) : options.jwt;
  const request = new Request("https://api.test/api/webhooks/jira/" + (options.token ?? INSTALL_TOKEN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `JWT ${jwt}` } : {}),
    },
    body,
  });
  return handleJiraWebhook(request, env, options.token ?? INSTALL_TOKEN);
}

describe("handleJiraWebhook", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    jiraCommentRequests.length = 0;
    jiraPickupMutationRequests.length = 0;
    jiraCommentStatus = 201;
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
    await seedInstallation(db);
    await seedActor(db);
    stubIssueRefetch();

    getValidJiraTokenMock.mockResolvedValue("binding-token");
    createSessionStateMock.mockImplementation(async (_env, sessionId: string) => ({
      session: { sessionId },
      replay: {},
    }));
    enqueueSessionPromptMock.mockResolvedValue({ ok: true });
    closeSessionForWebhookMock.mockResolvedValue({ closed: true, session: null });
    syncSessionProjectionMock.mockResolvedValue(undefined);
    resolveUserSettingsMock.mockResolvedValue({ default_repo: "https://github.com/acme/app", default_model: null });
    authorizeWebhookRepoPolicyMock.mockResolvedValue({
      status: "authorized",
      owner: "acme",
      repo: "app",
      installation: { installation_id: 555 },
      accessCheck: "verified",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a session and enqueues the bootstrap prompt on the happy path", async () => {
    const res = await postWebhook(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created?: boolean; sessionId?: string };
    expect(body.created).toBe(true);

    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBe(body.sessionId);
    const prompt = String(enqueueSessionPromptMock.mock.calls[0]?.[2]);
    expect(prompt).toContain("Jira Issue: ENG-7");
    expect(prompt).toContain("Fix the flaky test");
    expect(prompt).toContain("It fails often.");
    expect(prompt).toContain('source="jira_issue_comment"');
    expect(prompt).toContain("Recent Jira comment.");
    expect(prompt).toContain("https://acme.atlassian.net/browse/ENG-7");

    const refRow = (db as unknown as SqliteD1).db
      .prepare("SELECT session_id FROM session_webhook_refs WHERE source = 'jira_issue' AND external_ref = ?")
      .get("cloud-1:10001") as { session_id: string } | undefined;
    expect(refRow?.session_id).toBe(body.sessionId);
    expect(jiraCommentRequests).toHaveLength(1);
    expect(jiraPickupMutationRequests).toEqual([
      expect.objectContaining({ method: "GET", url: expect.stringContaining("/transitions") }),
      expect.objectContaining({
        method: "POST",
        url: expect.stringContaining("/transitions"),
        body: { transition: { id: "21" } },
      }),
      expect.objectContaining({
        method: "PUT",
        url: expect.stringContaining("/assignee"),
        body: { accountId: "acct-42" },
      }),
    ]);
    expect(JSON.stringify(jiraCommentRequests[0].body)).toContain("A pull request will follow");
  });

  it("does not transition completed or reassign an already-assigned issue", async () => {
    const installation = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    if (!installation) throw new Error("installation missing");
    await markJiraIssuePickedUp({
      env,
      db,
      installation,
      issueKey: "ENG-7",
      sessionId: "session-1",
      statusCategoryKey: "done",
      statusCategoryKnown: true,
      assigneeAccountId: "acct-existing",
      assigneeKnown: true,
      actorAccountId: "acct-42",
    });
    expect(jiraCommentRequests).toHaveLength(1);
    expect(jiraPickupMutationRequests).toHaveLength(0);
  });

  it("does not choose an arbitrary Jira transition when In Progress is unavailable", async () => {
    stubIssueRefetch({ transitionNames: ["Started", "In Review"] });
    const installation = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    if (!installation) throw new Error("installation missing");
    await markJiraIssuePickedUp({
      env,
      db,
      installation,
      issueKey: "ENG-7",
      sessionId: "session-1",
      statusCategoryKey: "new",
      statusCategoryKnown: true,
      assigneeAccountId: "acct-existing",
      assigneeKnown: true,
      actorAccountId: "acct-42",
    });
    expect(jiraPickupMutationRequests).toEqual([
      expect.objectContaining({ method: "GET", url: expect.stringContaining("/transitions") }),
    ]);
  });

  it("does not mutate Jira when refetched state is unknown", async () => {
    const installation = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    if (!installation) throw new Error("installation missing");
    await markJiraIssuePickedUp({
      env,
      db,
      installation,
      issueKey: "ENG-7",
      sessionId: "session-1",
      statusCategoryKey: null,
      statusCategoryKnown: false,
      assigneeAccountId: null,
      assigneeKnown: false,
      actorAccountId: "acct-42",
    });
    expect(jiraCommentRequests).toHaveLength(1);
    expect(jiraPickupMutationRequests).toHaveLength(0);
  });

  it("continues Jira session creation when prior comments cannot be fetched", async () => {
    stubIssueRefetch({ commentsStatus: 403 });

    const res = await postWebhook(env);
    expect(res.status).toBe(200);

    const prompt = String(enqueueSessionPromptMock.mock.calls[0]?.[2]);
    expect(prompt).toContain("Jira Issue: ENG-7");
    expect(prompt).not.toContain('source="jira_issue_comment"');
  });

  it("parses Jira comments from the real response shape oldest-first for prompts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              comments: [
                {
                  author: { displayName: "Newer Reviewer" },
                  body: {
                    type: "doc",
                    version: 1,
                    content: [{ type: "paragraph", content: [{ type: "text", text: "newer comment" }] }],
                  },
                },
                {
                  author: { displayName: "Older Reviewer" },
                  body: {
                    type: "doc",
                    version: 1,
                    content: [{ type: "paragraph", content: [{ type: "text", text: "older comment" }] }],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const comments = await fetchJiraIssueComments({ token: "tok", cloudId: "cloud-1", issueKey: "ENG-7" });

    expect(comments).toEqual([
      { authorName: "Older Reviewer", body: "older comment" },
      { authorName: "Newer Reviewer", body: "newer comment" },
    ]);
  });

  it("passes refetched Jira image attachments into the bootstrap prompt enqueue", async () => {
    const contentUrl = "https://acme.atlassian.net/jira/rest/api/3/attachment/content/10000";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/transitions")) return new Response(JSON.stringify({ transitions: [] }), { status: 200 });
        if (url.endsWith("/assignee")) return new Response("", { status: 200 });
        if (url.includes("/rest/api/3/issue/") && url.includes("/comment") && init?.method !== "POST") {
          return new Response(JSON.stringify({ comments: [] }), { status: 200 });
        }
        if (url.endsWith("/comment")) return new Response(JSON.stringify({ id: "comment-pickup" }), { status: 201 });
        if (url.includes("/rest/api/3/issue/")) {
          expect(url).toContain("fields=summary,description,status,labels,issuetype,attachment,assignee");
          return new Response(
            JSON.stringify({
              id: "10001",
              key: "ENG-7",
              fields: {
                summary: "Fix the flaky test",
                description: {
                  type: "doc",
                  version: 1,
                  content: [{ type: "paragraph", content: [{ type: "text", text: "It fails often." }] }],
                },
                status: { name: "To Do" },
                issuetype: { name: "Bug" },
                labels: ["cycloid"],
                attachment: [
                  {
                    id: 10000,
                    filename: "screen.png",
                    mimeType: "image/png",
                    content: contentUrl,
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        expect(url).toBe(contentUrl);
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer binding-token");
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-length": "4" },
        });
      }),
    );

    const res = await postWebhook(env);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
    expect(enqueueSessionPromptMock.mock.calls[0]?.[4]).toEqual({
      uploadedImages: [
        {
          name: "jira-10000-screen.png",
          mediaType: "image/png",
          data: btoa(String.fromCharCode(137, 80, 78, 71)),
        },
      ],
    });
  });

  it("drops deliveries without a valid JWT before touching Atlassian", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const missing = await postWebhook(env, { jwt: null });
    expect(((await missing.json()) as { reason?: string }).reason).toBe("jwt_verification_failed");

    const badSignature = await postWebhook(env, { jwt: await signJiraJwt("wrong-secret") });
    expect(((await badSignature.json()) as { reason?: string }).reason).toBe("jwt_verification_failed");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("rejects expired JWTs", async () => {
    const expired = await signJiraJwt(CLIENT_SECRET, { exp: Math.floor(Date.now() / 1000) - 10 });
    const res = await postWebhook(env, { jwt: expired });
    expect(((await res.json()) as { reason?: string }).reason).toBe("jwt_verification_failed");
  });

  it("rejects JWTs without an exp claim", async () => {
    const noExp = await signJiraJwt(CLIENT_SECRET, { exp: undefined });
    const res = await postWebhook(env, { jwt: noExp });
    expect(((await res.json()) as { reason?: string }).reason).toBe("jwt_verification_failed");
  });

  it("drops unknown installation tokens", async () => {
    const res = await postWebhook(env, { token: "tok-unknown" });
    expect(((await res.json()) as { reason?: string }).reason).toBe("unknown_installation_token");
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("dedupes byte-identical redeliveries", async () => {
    const first = await postWebhook(env);
    expect(((await first.json()) as { created?: boolean }).created).toBe(true);

    const second = await postWebhook(env);
    expect(((await second.json()) as { reason?: string }).reason).toBe("duplicate");
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes a retry whose top-level timestamp was regenerated (stable changelog id)", async () => {
    const base = {
      webhookEvent: "jira:issue_updated",
      issue: { key: "ENG-7", id: "10001" },
      user: { accountId: "acct-42" },
      changelog: { id: "9001" },
    };
    const first = await postWebhook(env, { body: { ...base, timestamp: 1718000000000 } });
    expect(((await first.json()) as { created?: boolean }).created).toBe(true);

    // Same logical delivery, new timestamp -> different payload hash, but the
    // changelog-id-keyed claim still dedupes it (this is the bug being fixed).
    const retry = await postWebhook(env, { body: { ...base, timestamp: 1718000009999 } });
    expect(((await retry.json()) as { reason?: string }).reason).toBe("duplicate");
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe a distinct later update on the same issue (new changelog id)", async () => {
    const base = {
      webhookEvent: "jira:issue_updated",
      issue: { key: "ENG-7", id: "10001" },
      user: { accountId: "acct-42" },
    };
    const first = await postWebhook(env, { body: { ...base, changelog: { id: "9001" }, timestamp: 1 } });
    expect(((await first.json()) as { reason?: string }).reason).not.toBe("duplicate");

    // A genuinely new change (different changelog id) must clear the idempotency
    // claim, not be suppressed forever by a coarser issue-level key.
    const later = await postWebhook(env, { body: { ...base, changelog: { id: "9002" }, timestamp: 2 } });
    expect(((await later.json()) as { reason?: string }).reason).not.toBe("duplicate");
  });

  it("drops malformed, oversized, and unexpected payloads without calling Atlassian", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const malformed = await postWebhook(env, { body: "{not json" });
    expect(malformed.status).toBe(400);

    const oversized = await postWebhook(env, { body: `{"pad":"${"x".repeat(300 * 1024)}"}` });
    expect(((await oversized.json()) as { reason?: string }).reason).toBe("payload_too_large");

    const wrongEvent = await postWebhook(env, {
      body: { webhookEvent: "comment_created", issue: { key: "ENG-7" }, user: { accountId: "acct-42" } },
    });
    expect(await wrongEvent.json()).toMatchObject({ skipped: true, reason: "unexpected_event_type" });

    const missingKey = await postWebhook(env, {
      body: { webhookEvent: "jira:issue_updated", issue: {}, user: { accountId: "acct-42" }, t: 1 },
    });
    expect(((await missingKey.json()) as { reason?: string }).reason).toBe("missing_issue_key");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("treats the re-fetched issue as authoritative for the trigger label", async () => {
    stubIssueRefetch({ refetchedLabels: ["other-label"] });
    const res = await postWebhook(env);
    expect(((await res.json()) as { reason?: string }).reason).toBe("trigger_label_missing");
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("drops when the issue re-fetch 404s", async () => {
    stubIssueRefetch({ refetchStatus: 404 });
    const res = await postWebhook(env);
    expect(((await res.json()) as { reason?: string }).reason).toBe("issue_not_found");
  });

  it("returns 503 and frees the dedupe claim on a transient re-fetch failure", async () => {
    stubIssueRefetch({ refetchStatus: 503 });
    const res = await postWebhook(env);
    expect(res.status).toBe(503);
    expect(createSessionStateMock).not.toHaveBeenCalled();

    // The byte-identical Jira redelivery must be processable once the
    // dependency recovers, not deduplicated by a held claim.
    stubIssueRefetch();
    const retry = await postWebhook(env);
    expect(((await retry.json()) as { created?: boolean }).created).toBe(true);
  });

  it("validates the trigger label against the installation's registered label", async () => {
    (db as unknown as SqliteD1).db
      .prepare("UPDATE jira_webhook_installations SET trigger_label = 'custom-label'")
      .run();
    // env still says "cycloid"; the issue carries the label the remote JQL
    // was actually registered with.
    stubIssueRefetch({ refetchedLabels: ["custom-label"] });
    const res = await postWebhook(env);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
  });

  it("drops unmapped actors, business mismatches, and site mismatches", async () => {
    const unmapped = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-unknown" },
        t: 1,
      },
    });
    expect(((await unmapped.json()) as { reason?: string }).reason).toBe("actor_not_connected");

    // Actor exists but belongs to another business.
    (db as unknown as SqliteD1).db
      .prepare(
        "INSERT INTO user_integrations (user_id, integration_id, oauth_access_token, external_user_id, encrypted) VALUES (77, 'jira', 'enc', 'acct-77', 1)",
      )
      .run();
    const mismatch = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-77" },
        t: 2,
      },
    });
    expect(((await mismatch.json()) as { reason?: string }).reason).toBe("actor_business_mismatch");

    // Right business, wrong selected site.
    await upsertJiraUserSite(db, {
      userId: 42,
      jiraCloudId: "cloud-other",
      siteUrl: "https://other.atlassian.net",
      jiraAccountId: "acct-42",
    });
    const siteMismatch = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        t: 3,
      },
    });
    expect(((await siteMismatch.json()) as { reason?: string }).reason).toBe("actor_site_mismatch");
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("skips issues that already have a live session", async () => {
    const first = await postWebhook(env);
    const firstBody = (await first.json()) as { sessionId?: string };
    (db as unknown as SqliteD1).db
      .prepare("INSERT INTO session_index (session_id, status) VALUES (?, 'active')")
      .run(firstBody.sessionId);

    const second = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        t: 99,
      },
    });
    const body = (await second.json()) as { reason?: string; sessionId?: string };
    expect(body.reason).toBe("session_already_exists");
    expect(body.sessionId).toBe(firstBody.sessionId);
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("drops with a repo reason when no repo can be resolved", async () => {
    resolveUserSettingsMock.mockResolvedValue({ default_repo: null, default_model: null });
    const res = await postWebhook(env);
    expect(((await res.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");
    expect(jiraCommentRequests).toHaveLength(1);
    expect(jiraCommentRequests[0].url).toContain("/rest/api/3/issue/ENG-7/comment");
    expect(jiraCommentRequests[0].body).toEqual({
      body: expect.objectContaining({
        type: "doc",
        version: 1,
        content: [
          expect.objectContaining({ type: "heading", attrs: { level: 3 } }),
          expect.objectContaining({ type: "paragraph" }),
          expect.objectContaining({
            type: "bulletList",
            content: [
              expect.objectContaining({
                type: "listItem",
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: "paragraph",
                    content: expect.arrayContaining([
                      expect.objectContaining({
                        type: "text",
                        text: "repo=owner/name",
                        marks: [{ type: "code" }],
                      }),
                    ]),
                  }),
                ]),
              }),
            ],
          }),
        ],
      }),
    });
    // The issue claim was released so a later delivery can retry.
    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBeNull();
  });

  it("suppresses duplicate Jira skip comments for fresh deliveries with the same issue and reason", async () => {
    resolveUserSettingsMock.mockResolvedValue({ default_repo: null, default_model: null });

    const first = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        changelog: { id: "skip-1" },
      },
    });
    expect(((await first.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");

    const second = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        changelog: { id: "skip-2" },
      },
    });
    expect(((await second.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");
    expect(jiraCommentRequests).toHaveLength(1);
  });

  it("does not post Jira skip comments for non-actionable actor drops", async () => {
    const res = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-unknown" },
        changelog: { id: "actor-drop" },
      },
    });
    expect(((await res.json()) as { reason?: string }).reason).toBe("actor_not_connected");
    expect(jiraCommentRequests).toHaveLength(0);
  });

  it("releases the Jira skip-notice claim when comment posting fails", async () => {
    resolveUserSettingsMock.mockResolvedValue({ default_repo: null, default_model: null });
    jiraCommentStatus = 500;
    const first = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        changelog: { id: "skip-fail-1" },
      },
    });
    expect(((await first.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");

    jiraCommentStatus = 201;
    const second = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        changelog: { id: "skip-fail-2" },
      },
    });
    expect(((await second.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");
    expect(jiraCommentRequests).toHaveLength(2);
  });

  it("emits exactly one lifecycle row and one Datadog drop event for a Jira repo skip", async () => {
    resolveUserSettingsMock.mockResolvedValue({ default_repo: null, default_model: null });
    emitLifecycleEventMock.mockClear();
    postStructuredEventToDdMock.mockClear();

    const res = await postWebhook(env, {
      body: {
        webhookEvent: "jira:issue_updated",
        issue: { key: "ENG-7", id: "10001" },
        user: { accountId: "acct-42" },
        changelog: { id: "skip-observability" },
      },
    });
    expect(((await res.json()) as { reason?: string }).reason).toBe("repo_inference_unknown");
    const skippedLifecycleEvents = emitLifecycleEventMock.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "stage" in event &&
          event.stage === "session_bootstrap_skipped",
      );
    expect(skippedLifecycleEvents).toHaveLength(1);
    expect(skippedLifecycleEvents[0]).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          jiraIssueKey: "ENG-7",
          payloadHash: expect.any(String),
        }),
      }),
    );
    expect(
      postStructuredEventToDdMock.mock.calls.filter(
        ([, event]) =>
          typeof event === "object" && event !== null && "event" in event && event.event === "jira.webhook_dropped",
      ),
    ).toHaveLength(1);
  });

  it("returns 503 and frees the dedupe claim on transient repo verification failures", async () => {
    authorizeWebhookRepoPolicyMock.mockResolvedValue({
      status: "skipped",
      reason: "repo_access_verification_failed",
      repoUrl: "https://github.com/acme/app",
    });
    const res = await postWebhook(env);
    expect(res.status).toBe(503);
    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBeNull();

    // The same body must be processable again after the transient failure.
    authorizeWebhookRepoPolicyMock.mockResolvedValue({
      status: "authorized",
      owner: "acme",
      repo: "app",
      installation: { installation_id: 555 },
      accessCheck: "verified",
    });
    const retry = await postWebhook(env);
    expect(((await retry.json()) as { created?: boolean }).created).toBe(true);
  });

  it("names the parsed repo in Jira authorization skip comments", async () => {
    authorizeWebhookRepoPolicyMock.mockResolvedValue({
      status: "skipped",
      reason: "no_installation",
      repoUrl: "https://github.com/acme/app",
      owner: "acme",
      repo: "app",
    });

    const res = await postWebhook(env);
    expect(((await res.json()) as { reason?: string }).reason).toBe("no_installation");
    expect(jiraCommentRequests).toHaveLength(1);
    expect(JSON.stringify(jiraCommentRequests[0].body)).toContain('"text":"acme/app","marks":[{"type":"code"}]');
  });

  it("cleans up the session and ref when the bootstrap enqueue fails", async () => {
    enqueueSessionPromptMock.mockResolvedValue({ ok: false, error: "queue_unavailable" });

    await expect(postWebhook(env)).rejects.toThrow(/bootstrap enqueue failed/);
    expect(closeSessionForWebhookMock).toHaveBeenCalled();
    expect(await getSessionIdByJiraIssueRef(db, "cloud-1:10001")).toBeNull();
  });
});

describe("buildJiraStableDeliveryId", () => {
  it("keys on the changelog id, scoped by cloud/event/issue, excluding the timestamp", () => {
    const payload = {
      webhookEvent: "jira:issue_updated",
      issue: { id: "10001", key: "ENG-7" },
      changelog: { id: "9001" },
      timestamp: 1718000000000,
    };
    expect(buildJiraStableDeliveryId("cloud-1", payload)).toBe("cloud-1:jira:issue_updated:10001:9001");
    // A regenerated timestamp does not change the key.
    expect(buildJiraStableDeliveryId("cloud-1", { ...payload, timestamp: 999 })).toBe(
      "cloud-1:jira:issue_updated:10001:9001",
    );
  });

  it("falls back to the comment id when there is no changelog", () => {
    expect(
      buildJiraStableDeliveryId("cloud-1", {
        webhookEvent: "comment_created",
        issue: { id: "10001" },
        comment: { id: "55" },
      }),
    ).toBe("cloud-1:comment_created:10001:55");
  });

  it("distinct changes on the same issue yield distinct keys", () => {
    const base = { webhookEvent: "jira:issue_updated", issue: { id: "10001" } };
    expect(buildJiraStableDeliveryId("cloud-1", { ...base, changelog: { id: "9001" } })).not.toBe(
      buildJiraStableDeliveryId("cloud-1", { ...base, changelog: { id: "9002" } }),
    );
  });

  it("returns null (payload-hash fallback) when no stable sub-id is present", () => {
    expect(
      buildJiraStableDeliveryId("cloud-1", { webhookEvent: "jira:issue_updated", issue: { id: "10001" } }),
    ).toBeNull();
    expect(buildJiraStableDeliveryId("cloud-1", { issue: { id: "10001" }, changelog: { id: "9001" } })).toBeNull();
  });
});

describe("fetchJiraIssueImages", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function attachment(id: string, overrides: Partial<Parameters<typeof fetchJiraIssueImages>[0][number]> = {}) {
    return {
      id,
      filename: `${id}.png`,
      mimeType: "image/png",
      content: `https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/content/${id}`,
      ...overrides,
    };
  }

  it("accepts images, skips non-images, dedupes by Jira attachment id, and caps the image count", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchJiraIssueImages(
      [
        attachment("a1"),
        attachment("doc", { mimeType: "application/pdf" }),
        attachment("a1", { filename: "duplicate.png" }),
        attachment("a2"),
        attachment("a3"),
        attachment("a4"),
        attachment("a5"),
        attachment("a6"),
      ],
      "jira-token",
      "cloud-1",
      env,
    );

    expect(images.map((image) => image.name)).toEqual([
      "jira-a1-a1.png",
      "jira-a2-a2.png",
      "jira-a3-a3.png",
      "jira-a4-a4.png",
      "jira-a5-a5.png",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("rejects unsafe attachment hosts before sending the Jira bearer token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchJiraIssueImages(
      [attachment("evil", { content: "https://evil.example.test/attachment.png" })],
      "jira-token",
      "cloud-1",
      env,
    );

    expect(images).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows Jira signed redirects without the Atlassian bearer token", async () => {
    const signedUrl = "https://api.media.atlassian.com/file/signed-object";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.atlassian.com")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer jira-token");
        return new Response(null, { status: 302, headers: { location: signedUrl } });
      }
      expect(url).toBe(signedUrl);
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchJiraIssueImages([attachment("a1")], "jira-token", "cloud-1", env);

    expect(images).toEqual([
      {
        name: "jira-a1-a1.png",
        mediaType: "image/png",
        data: btoa(String.fromCharCode(9, 8, 7)),
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows safe S3 redirect hostnames that start with IPv6 ULA prefixes", async () => {
    const signedUrl = "https://fd-attachments.s3.amazonaws.com/signed-object";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.atlassian.com")) {
        return new Response(null, { status: 303, headers: { location: signedUrl } });
      }
      expect(url).toBe(signedUrl);
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchJiraIssueImages([attachment("a1")], "jira-token", "cloud-1", env);

    expect(images.map((image) => image.name)).toEqual(["jira-a1-a1.png"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects disallowed redirects and skips oversized or auth-failed downloads fail-soft", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/redirect"))
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } });
      if (url.endsWith("/oversize")) {
        return new Response("", { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } });
      }
      if (url.endsWith("/auth")) return new Response("forbidden", { status: 403 });
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const images = await fetchJiraIssueImages(
      [attachment("redirect"), attachment("oversize"), attachment("auth"), attachment("ok")],
      "jira-token",
      "cloud-1",
      env,
    );

    expect(images.map((image) => image.name)).toEqual(["jira-ok-ok.png"]);
  });

  it("trims images to the prompt SQL payload budget before enqueueing", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const imageAttachments = Array.from({ length: 3 }, (_, index) => attachment(`a${index}`));
    const images = await fetchJiraIssueImages(imageAttachments, "jira-token", "cloud-1", env);
    const hugePrompt = "x".repeat(1_799_950);
    const { trimUploadedImagesToPromptBudget } = await import("../../shared/utils/uploads");
    const trimmed = trimUploadedImagesToPromptBudget({ promptText: hugePrompt, uploadedImages: images });

    expect(images).toHaveLength(3);
    expect(trimmed.uploadedImages).toEqual([]);
    expect(trimmed.droppedCount).toBe(3);
  });
});

describe("refetchJiraIssue reactive degrade", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
    await seedInstallation(db);
    getValidJiraTokenMock.mockResolvedValue("binding-token");
  });

  async function installation() {
    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    if (!row) throw new Error("seed installation missing");
    return row;
  }

  it("reactively degrades the installation on a 401 (installer token dead)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const result = await refetchJiraIssue(env, db, await installation(), "ENG-7");
    expect(result).toEqual({ status: "skipped", reason: "issue_refetch_failed" });
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ event: "integration.reactive_degrade", operation: "jira.webhook.issueRefetch" }),
    );
  });

  it("does NOT degrade on a 403 (no access to this one issue, not token death)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    const result = await refetchJiraIssue(env, db, await installation(), "ENG-7");
    expect(result).toEqual({ status: "skipped", reason: "issue_refetch_failed" });
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("active");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  it("does NOT degrade on a 404 (issue not found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const result = await refetchJiraIssue(env, db, await installation(), "ENG-7");
    expect(result).toEqual({ status: "skipped", reason: "issue_not_found" });
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("active");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });
});
