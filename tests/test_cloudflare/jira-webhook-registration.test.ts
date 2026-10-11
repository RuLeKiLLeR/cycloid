import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getValidJiraTokenMock, postStructuredEventToDdMock } = vi.hoisted(() => ({
  getValidJiraTokenMock: vi.fn(),
  postStructuredEventToDdMock: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/auth/db")>();
  return { ...actual, getValidJiraToken: getValidJiraTokenMock };
});

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: postStructuredEventToDdMock,
}));

import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  getJiraWebhookInstallationByBusiness,
  upsertJiraWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";
import {
  deleteJiraWebhooksBestEffort,
  jiraWebhookCallbackUrl,
  parseJiraWebhookIds,
  refreshDueJiraWebhooks,
  registerJiraWebhooks,
} from "../../apps/control-plane-worker/src/webhooks/jira-registration";

class SqliteD1 {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY);");
    this.db.exec("INSERT INTO businesses (id) VALUES ('biz-1'); INSERT INTO users (id) VALUES (42);");
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
        if (query.trimStart().startsWith("CREATE")) {
          try {
            db.prepare(query).run(...values);
          } catch {
            // Table families outside this fixture's scope.
          }
          return { success: true as const, meta: { changes: 0 } };
        }
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

const INSTALL = {
  businessId: "biz-1",
  jiraCloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  installationToken: "tok-1",
  connectedByUserId: 42,
};

function findCallByMethod(fetchSpy: ReturnType<typeof vi.fn>, method: string): [string, RequestInit] {
  const call = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
  if (!call) throw new Error(`no ${method} fetch call recorded`);
  return call as unknown as [string, RequestInit];
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CONTROL_PLANE_URL: "https://api.test",
    JIRA_TRIGGER_LABEL: "cycloid",
  } as unknown as Env;
}

describe("registerJiraWebhooks", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
    await upsertJiraWebhookInstallation(db, INSTALL);
    getValidJiraTokenMock.mockResolvedValue("binding-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers webhooks with the JQL trigger filter and persists the result", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 9001 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(true);

    const [url, init] = findCallByMethod(fetchSpy, "POST");
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/webhook");
    const body = JSON.parse(String(init.body)) as {
      url: string;
      webhooks: Array<{ events: string[]; jqlFilter: string }>;
    };
    expect(body.url).toBe("https://api.test/api/webhooks/jira/tok-1");
    expect(body.webhooks[0].events).toEqual(["jira:issue_created", "jira:issue_updated"]);
    expect(body.webhooks[0].jqlFilter).toBe('labels = "cycloid"');

    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("active");
    expect(row?.triggerLabel).toBe("cycloid");
    expect(parseJiraWebhookIds(row?.webhooksJson ?? null)).toEqual([9001]);
    expect(row?.webhookExpiresAt).not.toBeNull();
  });

  it("escapes quotes and backslashes in the trigger label JQL", async () => {
    env = { ...env, JIRA_TRIGGER_LABEL: 'arc"label\\x' } as Env;
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 9001 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(true);
    const [, init] = findCallByMethod(fetchSpy, "POST");
    const body = JSON.parse(String(init.body)) as { webhooks: Array<{ jqlFilter: string }> };
    expect(body.webhooks[0].jqlFilter).toBe('labels = "arc\\"label\\\\x"');
  });

  it("deletes previously registered remote webhooks before re-registering", async () => {
    (db as unknown as SqliteD1).db
      .prepare("UPDATE jira_webhook_installations SET webhooks_json = ? WHERE business_id = 'biz-1'")
      .run(JSON.stringify([{ webhookId: 7001, events: [], expiresAt: Date.now() }]));
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 9001 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(true);

    const methods = fetchSpy.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method);
    expect(methods).toEqual(["DELETE", "GET", "POST"]);
    const [, deleteInit] = findCallByMethod(fetchSpy, "DELETE");
    expect(JSON.parse(String(deleteInit.body))).toEqual({ webhookIds: [7001] });
    expect(
      parseJiraWebhookIds((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.webhooksJson ?? null),
    ).toEqual([9001]);
  });

  it("deletes stale remote webhooks the installation never recorded before registering", async () => {
    // Simulates Atlassian's one-callback-URL-per-user-per-app limit: another
    // environment registered a webhook this row has no record of.
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ values: [{ id: 5555 }], isLast: true }), { status: 200 });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 9001 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(true);

    const [, deleteInit] = findCallByMethod(fetchSpy, "DELETE");
    expect(JSON.parse(String(deleteInit.body))).toEqual({ webhookIds: [5555] });
    expect(
      parseJiraWebhookIds((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.webhooksJson ?? null),
    ).toEqual([9001]);
  });

  it("marks the installation degraded on per-item registration failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              webhookRegistrationResult: [{ createdWebhookId: 9001 }, { errors: ["Invalid JQL"] }],
            }),
            { status: 200 },
          ),
      ),
    );

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("degraded");
    expect(row?.webhooksJson).toBeNull();
  });

  it("marks the installation degraded when the binding credential is unavailable", async () => {
    getValidJiraTokenMock.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
  });

  it("degrades and emits the reactive metric on HTTP auth rejection (403)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "integration.reactive_degrade",
        operation: "jira.webhook.register",
        reason_code: "provider_authn_rejected",
      }),
    );
  });

  it("degrades WITHOUT a reactive metric on a client error (400) since it is not an auth signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  // Registration deletes the remote webhooks before the POST, so a transient
  // failure must still degrade (leaving the row active would silently stop
  // events). It must NOT emit the reactive metric — a 429/5xx is not an auth signal.
  it("degrades WITHOUT a metric on a 429 during registration (remote webhooks already deleted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429 })),
    );
    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  it("degrades WITHOUT a metric on a 5xx during registration (remote webhooks already deleted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    expect(await registerJiraWebhooks(env, db, INSTALL)).toBe(false);
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });
});

describe("refreshDueJiraWebhooks", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
    await upsertJiraWebhookInstallation(db, INSTALL);
    getValidJiraTokenMock.mockResolvedValue("binding-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedRegistration(expiresAt: number): Promise<void> {
    (db as unknown as SqliteD1).db
      .prepare(
        "UPDATE jira_webhook_installations SET webhooks_json = ?, webhook_expires_at = ? WHERE business_id = 'biz-1'",
      )
      .run(JSON.stringify([{ webhookId: 9001, events: [], expiresAt }]), expiresAt);
  }

  it("refreshes registrations inside the expiry window and extends the stored expiry", async () => {
    const soon = Date.now() + 24 * 60 * 60 * 1000;
    await seedRegistration(soon);
    const newExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ expirationDate: newExpiry }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 1, failed: 0 });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/webhook/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ webhookIds: [9001] });

    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.webhookExpiresAt).toBe(newExpiry);
    expect(row?.status).toBe("active");
  });

  it("re-registers installations whose registration never stored webhook IDs", async () => {
    // webhooks_json is still null: the connect-time registration failed
    // transiently and the row sits degraded.
    (db as unknown as SqliteD1).db
      .prepare("UPDATE jira_webhook_installations SET status = 'degraded' WHERE business_id = 'biz-1'")
      .run();
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 9002 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 1, failed: 0 });

    const [url] = findCallByMethod(fetchSpy, "POST");
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/webhook");
    const row = await getJiraWebhookInstallationByBusiness(db, "biz-1");
    expect(row?.status).toBe("active");
    expect(parseJiraWebhookIds(row?.webhooksJson ?? null)).toEqual([9002]);
  });

  it("skips registrations that are far from expiry", async () => {
    await seedRegistration(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 0, skipped: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks the installation degraded when refresh auth fails", async () => {
    await seedRegistration(Date.now() + 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 0, failed: 1 });
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
  });

  it("marks the installation degraded when the binding credential is gone", async () => {
    await seedRegistration(Date.now() + 1000);
    getValidJiraTokenMock.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
  });

  it("does NOT degrade the installation when refresh is rate limited (429) — webhooks stay live", async () => {
    await seedRegistration(Date.now() + 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429 })),
    );

    const result = await refreshDueJiraWebhooks(env);
    expect(result).toMatchObject({ refreshed: 0, failed: 1 });
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("active");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });
});

describe("deleteJiraWebhooksBestEffort", () => {
  it("deletes known remote webhook IDs and never throws", async () => {
    const db = new SqliteD1() as unknown as D1Database;
    const env = makeEnv(db);
    getValidJiraTokenMock.mockResolvedValue("binding-token");
    const fetchSpy = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);

    await deleteJiraWebhooksBestEffort(env, db, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      connectedByUserId: 42,
      webhooksJson: JSON.stringify([{ webhookId: 9001 }]),
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/webhook");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ webhookIds: [9001] });

    // Failures stay silent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      deleteJiraWebhooksBestEffort(env, db, {
        businessId: "biz-1",
        jiraCloudId: "cloud-1",
        connectedByUserId: 42,
        webhooksJson: JSON.stringify([{ webhookId: 9001 }]),
      }),
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("builds the public callback URL from CONTROL_PLANE_URL", () => {
    const env = makeEnv(new SqliteD1() as unknown as D1Database);
    expect(jiraWebhookCallbackUrl(env, "tok-x")).toBe("https://api.test/api/webhooks/jira/tok-x");
  });
});
