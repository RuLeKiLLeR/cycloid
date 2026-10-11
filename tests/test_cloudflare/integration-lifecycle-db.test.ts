import { describe, expect, it, vi } from "vitest";

import { D1_RETRY_SAFE_MARKER } from "../../apps/control-plane-worker/src/db/errors";
import {
  deleteIntegrationLifecycleEventsBefore,
  listIntegrationLifecycleEvents,
  listLatestIntegrationLifecycleEvents,
  recordIntegrationLifecycleEvent,
  recordIntegrationLifecycleEvents,
} from "../../apps/control-plane-worker/src/integrations/lifecycle/db";

describe("integration lifecycle db", () => {
  it("records a single event via a d1-retry-safe INSERT OR IGNORE keyed on a pre-generated id", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const id = await recordIntegrationLifecycleEvent(db, {
      integrationId: "github",
      stage: "provider_probe_passed",
      status: "passed",
    });

    expect(id).toBeTruthy();
    const sql = prepare.mock.calls[0][0] as unknown as string;
    // Exact-once under wrapper retry: OR IGNORE + the id bound before the
    // first attempt makes a replay a no-op instead of a duplicate row.
    expect(sql).toContain(D1_RETRY_SAFE_MARKER);
    expect(sql).toContain("INSERT OR IGNORE INTO integration_lifecycle_events");
    expect(bind.mock.calls[0][0]).toBe(id);
  });

  it("retries the batch once on a transient D1 error, replaying the same statements", async () => {
    const bound: unknown[] = [];
    const bind = vi.fn((...values: unknown[]) => {
      const statement = { values };
      bound.push(statement);
      return statement;
    });
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn().mockRejectedValueOnce(new Error("D1_ERROR: Network connection lost.")).mockResolvedValue([]);
    const db = { prepare, batch } as unknown as D1Database;

    await recordIntegrationLifecycleEvents(db, [
      { integrationId: "github", stage: "provider_probe_passed", status: "passed" },
      { integrationId: "slack", stage: "provider_probe_passed", status: "passed" },
    ]);

    expect(batch).toHaveBeenCalledTimes(2);
    // The replayed batch reuses the SAME prepared statements (same ids), so a
    // partially committed first attempt no-ops per committed row.
    expect(batch.mock.calls[0][0]).toEqual(batch.mock.calls[1][0]);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
  });

  it("does not retry the batch on a non-transient error", async () => {
    const bind = vi.fn(() => ({}));
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table: integration_lifecycle_events"));
    const db = { prepare, batch } as unknown as D1Database;

    await expect(
      recordIntegrationLifecycleEvents(db, [
        { integrationId: "github", stage: "provider_probe_passed", status: "passed" },
      ]),
    ).rejects.toThrow("no such table");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("treats a replayed single insert that reports changes = 0 as success", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 0 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await expect(
      recordIntegrationLifecycleEvent(db, {
        id: "evt-replay",
        integrationId: "github",
        stage: "provider_probe_passed",
        status: "passed",
      }),
    ).resolves.toBe("evt-replay");
  });

  it("deletes old rows via a subquery instead of DELETE ... LIMIT", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 3 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await expect(deleteIntegrationLifecycleEventsBefore(db, 100, 25)).resolves.toBe(3);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE id IN"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("SELECT id"));
    expect(bind).toHaveBeenCalledWith(100, 25);
  });

  it("can prune old rows for one lifecycle status at a time", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 2 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await expect(deleteIntegrationLifecycleEventsBefore(db, 200, 10, "failed")).resolves.toBe(2);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("AND status = ?"));
    expect(bind).toHaveBeenCalledWith(200, "failed", 10);
  });

  it("uses created_at and id together for stable pagination", async () => {
    const rows = [
      {
        id: "evt-c",
        business_id: "biz-1",
        user_id: 1,
        session_id: "sess-1",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "passed",
        reason_code: null,
        message: null,
        details_json: null,
        latency_ms: 0,
        created_at: 200,
      },
      {
        id: "evt-b",
        business_id: "biz-1",
        user_id: 1,
        session_id: "sess-1",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "passed",
        reason_code: null,
        message: null,
        details_json: null,
        latency_ms: 0,
        created_at: 100,
      },
      {
        id: "evt-a",
        business_id: "biz-1",
        user_id: 1,
        session_id: "sess-1",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "passed",
        reason_code: null,
        message: null,
        details_json: null,
        latency_ms: 0,
        created_at: 100,
      },
    ];
    const all = vi.fn(async () => ({ results: rows.filter((row) => row.id !== "evt-b") }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn((query: string) => {
      expect(query).toContain("created_at = ? AND id < ?");
      expect(query).toContain("ORDER BY created_at DESC, id DESC");
      return { bind };
    });
    const db = { prepare } as unknown as D1Database;

    const result = await listIntegrationLifecycleEvents(db, {
      integrationId: "github",
      limit: 10,
      cursor: { createdAt: 100, id: "evt-b" },
    });

    expect(bind).toHaveBeenCalledWith("github", 100, 100, "evt-b", 10);
    expect(result.map((row) => row.id)).toEqual(["evt-c", "evt-a"]);
  });

  it("loads latest lifecycle rows for multiple integration scopes in one query", async () => {
    const rows = [
      {
        id: "evt-github",
        business_id: "biz-1",
        user_id: 42,
        session_id: null,
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "failed",
        reason_code: "repo_access_denied",
        message: "GitHub probe failed",
        details_json: null,
        latency_ms: 0,
        created_at: 200,
      },
      {
        id: "evt-sentry",
        business_id: "biz-1",
        user_id: null,
        session_id: null,
        integration_id: "sentry",
        stage: "credential_resolved",
        status: "failed",
        reason_code: "token_missing",
        message: "Sentry credentials missing",
        details_json: null,
        latency_ms: 0,
        created_at: 100,
      },
    ];
    const all = vi.fn(async () => ({ results: rows }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn((query: string) => {
      expect(query).toContain("WITH requested");
      expect(query).toContain("FROM json_each(?)");
      expect(query).toContain("INDEXED BY idx_integration_lifecycle_user");
      expect(query).toContain("INDEXED BY idx_integration_lifecycle_business");
      expect(query).toContain("ROW_NUMBER()");
      expect(query).toContain("PARTITION BY integration_id");
      return { bind };
    });
    const db = { prepare } as unknown as D1Database;

    const result = await listLatestIntegrationLifecycleEvents(db, [
      { integrationId: "github", businessId: "biz-1", userId: 42 },
      { integrationId: "sentry", businessId: "biz-1" },
    ]);

    expect(bind).toHaveBeenCalledWith(
      JSON.stringify([
        { integrationId: "github", businessId: "biz-1", userId: 42, sessionId: null },
        { integrationId: "sentry", businessId: "biz-1", userId: null, sessionId: null },
      ]),
    );
    expect(result.map((row) => row.id)).toEqual(["evt-github", "evt-sentry"]);
  });

  it("rejects duplicate integration ids in lifecycle summary scopes", async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;

    await expect(
      listLatestIntegrationLifecycleEvents(db, [
        { integrationId: "github", businessId: "biz-1", userId: 42 },
        { integrationId: "github", businessId: "biz-1" },
      ]),
    ).rejects.toThrow("Duplicate integrationId in lifecycle summary scopes: github");
  });
});
