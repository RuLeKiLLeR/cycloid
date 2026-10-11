import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const TEST_SIGNING_SECRET = "pd-test-signing-secret";

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

const gateGithubSessionStartMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => gateGithubSessionStartMock(...args),
}));

const createSessionStateMock = vi.fn();
const enqueueSessionPromptMock = vi.fn();
const closeSessionForWebhookMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/state", async (importActual) => ({
  ...(await importActual<object>()),
  createSessionState: (...args: unknown[]) => createSessionStateMock(...args),
  enqueueSessionPrompt: (...args: unknown[]) => enqueueSessionPromptMock(...args),
  closeSessionForWebhook: (...args: unknown[]) => closeSessionForWebhookMock(...args),
}));

const persistInitialSessionProjectionMock = vi.fn(async (env: { DB: D1Database }, input: Record<string, unknown>) => {
  const { upsertSessionWebhookRef } = await import("../../apps/control-plane-worker/src/webhooks/db");
  const webhookRef = input.webhookRef as { source: string; externalRef: string } | undefined;
  const session = input.session as { sessionId: string };
  if (webhookRef) {
    await upsertSessionWebhookRef(env.DB, webhookRef.source, webhookRef.externalRef, session.sessionId);
  }
});
vi.mock("../../apps/control-plane-worker/src/services/session-create", async (importActual) => ({
  ...(await importActual<object>()),
  persistInitialSessionProjection: (...args: unknown[]) => persistInitialSessionProjectionMock(...args),
}));

const resolveUserSettingsMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/webhooks/shared", async (importActual) => ({
  ...(await importActual<object>()),
  resolveUserSettings: (...args: unknown[]) => resolveUserSettingsMock(...args),
}));

import { InitiationMode } from "../../apps/control-plane-worker/src/enums/initiation-mode";
import { SessionEntrypoint } from "../../apps/control-plane-worker/src/enums/session-entrypoint";
import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  buildPagerDutyIncidentWebhookRef,
  getPagerDutyWebhookInstallationByBusiness,
  listSessionIdsByWebhookRef,
  SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
  upsertPagerDutyWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";
import { handlePagerDutyWebhook } from "../../apps/control-plane-worker/src/webhooks/pagerduty-handler";

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
  async run() {
    const result = this.d1.sqlite.prepare(this.query).run(...(this.boundValues as never[]));
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return (this.d1.sqlite.prepare(this.query).get(...(this.boundValues as never[])) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.d1.sqlite.prepare(this.query).all(...(this.boundValues as never[])) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
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

function makeEnv(db: SqliteD1): Env {
  return { DB: db, TOKEN_ENCRYPTION_KEY: "test-token-encryption-key" } as unknown as Env;
}

function seedUserWithSettings(db: SqliteD1, defaultModel: string | null): void {
  const now = Date.now();
  db.sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("biz-1", "Acme", now, now);
  db.sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("biz-2", "Other", now, now);
  db.sqlite
    .prepare(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(42, 4242, "pagerduty-user", "PagerDuty User", "pagerduty@example.com", null, "biz-1", now, now);
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
    .run(42, 1, 0, defaultModel, "https://github.com/acme/api", now, now);
}

function pagerDutySignature(body: string, secret = TEST_SIGNING_SECRET): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `v1=${digest}`;
}

function pagerDutyV3Body(eventId = "evt-1"): string {
  return JSON.stringify({
    event: {
      id: eventId,
      event_type: "incident.triggered",
      resource_type: "incident",
      occurred_at: "2026-07-07T12:00:00.000Z",
      data: {
        id: "PINC123",
        incident_number: 1234,
        title: "Checkout returns HTTP 500",
        html_url: "https://pd.test/incidents/PINC123",
        status: "triggered",
        urgency: "high",
        priority: { summary: "P1" },
        service: { id: "svc-1", summary: "checkout-api" },
        escalation_policy: { summary: "Primary on-call" },
        assignments: [{ assignee: { summary: "Alice Admin" } }],
        body: { type: "incident_body", details: "Users cannot complete checkout." },
        impacted_region: "us-east-1",
      },
    },
  });
}

function pagerDutyLegacyBody(eventId = "legacy-1"): string {
  return JSON.stringify({
    messages: [
      {
        id: eventId,
        event: "incident.trigger",
        created_on: "2026-07-07T12:00:00.000Z",
        incident: {
          id: "PINC999",
          incident_number: 999,
          html_url: "https://pd.test/incidents/PINC999",
          status: "triggered",
          urgency: "high",
          trigger_summary_data: {
            subject: "Legacy trigger payload",
            description: "Legacy payload path should also start a session.",
          },
          service: { id: "svc-legacy", summary: "legacy-api" },
        },
      },
    ],
  });
}

async function seedInstallation(
  db: D1Database,
  params: {
    businessId: string;
    installationToken: string;
    connectedByUserId: number;
    repoOwner: string;
    repoName: string;
    modelId?: string | null;
    signingSecret?: string;
  },
): Promise<void> {
  await upsertPagerDutyWebhookInstallation(db, {
    businessId: params.businessId,
    installationToken: params.installationToken,
    connectedByUserId: params.connectedByUserId,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    modelId: params.modelId ?? null,
    webhookSigningSecretEncrypted: params.signingSecret ?? TEST_SIGNING_SECRET,
  });
}

function pagerDutyRequest(token: string, body: string, secret = TEST_SIGNING_SECRET): Request {
  return new Request(`https://cp.test/api/webhooks/pagerduty/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-PagerDuty-Signature": pagerDutySignature(body, secret),
    },
    body,
  });
}

describe("PagerDuty webhook handler", () => {
  beforeEach(() => {
    gateGithubSessionStartMock.mockReset().mockResolvedValue({ ok: true, installationId: 77 });
    createSessionStateMock.mockReset().mockImplementation(async (_env: unknown, sessionId: string) => ({
      session: { sessionId },
      replay: {},
    }));
    enqueueSessionPromptMock.mockReset().mockResolvedValue({ ok: true });
    closeSessionForWebhookMock.mockReset().mockResolvedValue({ closed: true, session: null });
    persistInitialSessionProjectionMock.mockClear();
    resolveUserSettingsMock.mockReset().mockResolvedValue({ default_model: "gpt-5.4" });
  });

  it("creates a repo automation session from a PagerDuty incident.open delivery", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    const bodyText = pagerDutyV3Body();
    const res = await handlePagerDutyWebhook(pagerDutyRequest("tok-pd-1", bodyText), makeEnv(db), "tok-pd-1");
    const body = (await res.json()) as { created: boolean; enqueued: boolean; sessionId: string };

    expect(res.status).toBe(200);
    expect(body.created).toBe(true);
    expect(body.enqueued).toBe(true);
    expect(createSessionStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "42",
      expect.objectContaining({
        repoContext: { repoOwner: "acme", repoName: "api" },
        installationId: 77,
        initiationMode: InitiationMode.AUTOMATION,
        entrypoint: SessionEntrypoint.PAGERDUTY,
      }),
    );
    const prompt = enqueueSessionPromptMock.mock.calls[0]?.[2] as string;
    expect(prompt).toContain("PagerDuty Incident: 1234");
    expect(prompt).toContain("Checkout returns HTTP 500");
    expect(prompt).toContain("checkout-api");
    expect(
      await listSessionIdsByWebhookRef(
        db as unknown as D1Database,
        SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
        buildPagerDutyIncidentWebhookRef("biz-1", "PINC123"),
      ),
    ).toEqual([body.sessionId]);
  });

  it("rejects forged deliveries without a valid PagerDuty signature", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    const bodyText = pagerDutyV3Body("evt-forged");
    const res = await handlePagerDutyWebhook(
      new Request(`https://cp.test/api/webhooks/pagerduty/tok-pd-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      }),
      makeEnv(db),
      "tok-pd-1",
    );

    expect(res.status).toBe(401);
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("dedupes duplicate deliveries by the PagerDuty event id", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    const request = pagerDutyRequest("tok-pd-1", pagerDutyV3Body("evt-dup"));
    const first = await handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1");
    const second = await handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1");
    expect((await first.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect((await second.json()) as { skipped?: boolean; reason?: string }).toMatchObject({
      skipped: true,
      reason: "duplicate",
    });
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("returns session_already_exists without creating a second session for the same incident", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    const first = await handlePagerDutyWebhook(
      pagerDutyRequest("tok-pd-1", pagerDutyV3Body("evt-first")),
      makeEnv(db),
      "tok-pd-1",
    );
    const second = await handlePagerDutyWebhook(
      pagerDutyRequest("tok-pd-1", pagerDutyV3Body("evt-second")),
      makeEnv(db),
      "tok-pd-1",
    );

    expect((await first.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect((await second.json()) as { skipped?: boolean; reason?: string }).toMatchObject({
      skipped: true,
      reason: "session_already_exists",
    });
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress dispatch for the same incident id on a different business installation", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-2",
      installationToken: "tok-pd-2",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "worker",
      signingSecret: "pd-other-secret",
    });

    const first = await handlePagerDutyWebhook(
      pagerDutyRequest("tok-pd-1", pagerDutyV3Body("evt-biz-1")),
      makeEnv(db),
      "tok-pd-1",
    );
    const second = await handlePagerDutyWebhook(
      pagerDutyRequest("tok-pd-2", pagerDutyV3Body("evt-biz-2"), "pd-other-secret"),
      makeEnv(db),
      "tok-pd-2",
    );

    expect((await first.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect((await second.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect(createSessionStateMock).toHaveBeenCalledTimes(2);
  });

  it("skips unsupported PagerDuty events without creating a session", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    const body = JSON.stringify({
      event: {
        id: "evt-resolved",
        event_type: "incident.resolved",
        resource_type: "incident",
        data: { id: "PINC123" },
      },
    });
    const res = await handlePagerDutyWebhook(pagerDutyRequest("tok-pd-1", body), makeEnv(db), "tok-pd-1");
    expect((await res.json()) as { skipped?: boolean; reason?: string }).toMatchObject({
      skipped: true,
      reason: "unexpected_event_type",
    });
    expect(createSessionStateMock).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim after a transient repo gate failure so redelivery can retry", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    gateGithubSessionStartMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: "integration_blocked",
          integrationId: "github",
          stage: "provider_probe_passed",
          reasonCode: "repo_access_check_failed",
          userMessage: "retry later",
        },
      })
      .mockResolvedValueOnce({ ok: true, installationId: 77 });

    const request = pagerDutyRequest("tok-pd-1", pagerDutyV3Body("evt-retry"));
    const first = await handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1");
    expect(first.status).toBe(503);

    const second = await handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1");
    expect((await second.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect(createSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up the webhook ref and closes the session when bootstrap enqueue fails", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
    });

    enqueueSessionPromptMock
      .mockResolvedValueOnce({ ok: false, error: "dispatch_failed" })
      .mockResolvedValueOnce({ ok: true });

    const request = pagerDutyRequest("tok-pd-1", pagerDutyLegacyBody("legacy-retry"));
    await expect(handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1")).rejects.toThrow(
      /bootstrap enqueue failed/i,
    );
    expect(closeSessionForWebhookMock).toHaveBeenCalledTimes(1);
    expect(
      await listSessionIdsByWebhookRef(
        db as unknown as D1Database,
        SESSION_WEBHOOK_REF_SOURCE_PAGERDUTY_INCIDENT,
        buildPagerDutyIncidentWebhookRef("biz-1", "PINC999"),
      ),
    ).toEqual([]);

    const retry = await handlePagerDutyWebhook(request.clone(), makeEnv(db), "tok-pd-1");
    expect((await retry.json()) as { created?: boolean }).toMatchObject({ created: true });
    expect(createSessionStateMock).toHaveBeenCalledTimes(2);
  });

  it("returns the configured binding row for local verification helpers", async () => {
    const db = new SqliteD1();
    seedUserWithSettings(db, "gpt-5.4");
    await seedInstallation(db as unknown as D1Database, {
      businessId: "biz-1",
      installationToken: "tok-pd-1",
      connectedByUserId: 42,
      repoOwner: "acme",
      repoName: "api",
      modelId: "gpt-5.4",
    });

    const install = await getPagerDutyWebhookInstallationByBusiness(db as unknown as D1Database, "biz-1");
    expect(install).toMatchObject({
      status: "active",
      repoOwner: "acme",
      repoName: "api",
      modelId: "gpt-5.4",
      webhookSigningSecretEncrypted: TEST_SIGNING_SECRET,
    });
  });
});
