import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { postStructuredEventToDdMock } = vi.hoisted(() => ({ postStructuredEventToDdMock: vi.fn() }));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: postStructuredEventToDdMock,
}));

import { degradeJiraInstallationReactively } from "../../apps/control-plane-worker/src/integrations/reactive-health";
import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  getJiraWebhookInstallationByBusiness,
  upsertJiraWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../shared/enums/integration-lifecycle";

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
            // Out-of-fixture table families.
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

function makeEnv(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

describe("degradeJiraInstallationReactively", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new SqliteD1() as unknown as D1Database;
    env = makeEnv(db);
    await upsertJiraWebhookInstallation(db, INSTALL);
  });

  it("flips an active installation to degraded and emits the reactive metric", async () => {
    await degradeJiraInstallationReactively(db, env, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      operation: "jira.webhook.issueRefetch",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      httpStatus: 401,
    });

    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
    expect(postStructuredEventToDdMock).toHaveBeenCalledTimes(1);
    expect(postStructuredEventToDdMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "integration.reactive_degrade",
        integration: "jira",
        operation: "jira.webhook.issueRefetch",
        reason_code: "provider_authn_rejected",
        business_id: "biz-1",
        http_status: 401,
      }),
    );
  });

  it("never logs a raw provider body or token in the metric payload", async () => {
    await degradeJiraInstallationReactively(db, env, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      operation: "jira.webhook.register",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
    });
    const payload = postStructuredEventToDdMock.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["business_id", "event", "http_status", "integration", "operation", "reason_code"].sort(),
    );
  });

  it("coalesces: a second durable failure while already degraded does not re-emit the metric", async () => {
    const params = {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      operation: "jira.webhook.issueRefetch",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      httpStatus: 401,
    };
    await degradeJiraInstallationReactively(db, env, params);
    await degradeJiraInstallationReactively(db, env, params);
    await degradeJiraInstallationReactively(db, env, params);

    expect(postStructuredEventToDdMock).toHaveBeenCalledTimes(1);
  });

  it("does not emit when the installation is already revoked (no active row to transition)", async () => {
    (db as unknown as SqliteD1).db
      .prepare("UPDATE jira_webhook_installations SET status = 'revoked' WHERE business_id = 'biz-1'")
      .run();

    await degradeJiraInstallationReactively(db, env, {
      businessId: "biz-1",
      jiraCloudId: "cloud-1",
      operation: "jira.webhook.issueRefetch",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
      httpStatus: 401,
    });

    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("revoked");
    expect(postStructuredEventToDdMock).not.toHaveBeenCalled();
  });

  it("does not throw into the caller when metric emission fails", async () => {
    postStructuredEventToDdMock.mockRejectedValueOnce(new Error("dd down"));
    await expect(
      degradeJiraInstallationReactively(db, env, {
        businessId: "biz-1",
        jiraCloudId: "cloud-1",
        operation: "jira.webhook.issueRefetch",
        reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED,
        httpStatus: 401,
      }),
    ).resolves.toBeUndefined();
    // The degrade still landed even though the metric failed.
    expect((await getJiraWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("degraded");
  });
});
