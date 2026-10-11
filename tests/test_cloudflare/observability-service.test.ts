import { describe, expect, it, vi } from "vitest";

import { ADMIN_TOKEN_ROUTE_ALLOWLIST } from "../../apps/control-plane-worker/src/constants/auth-tokens";
import {
  getSessionTelemetry,
  queryPromptRuns,
  searchSessions,
} from "../../apps/control-plane-worker/src/services/observability";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

function makeDb() {
  let sql = "";
  let params: unknown[] = [];
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn((...boundParams: unknown[]) => {
    params = boundParams;
    return { all };
  });
  const prepare = vi.fn((preparedSql: string) => {
    sql = preparedSql;
    return { bind };
  });

  return {
    db: { prepare } as unknown as D1Database,
    getSql: () => sql,
    getParams: () => params,
  };
}

const sharedBusinessAuth = {
  userId: "user-1",
  tokenSource: "test",
  authMode: "user_session",
  canAccessAllSessions: false,
  user: {
    id: 1,
    login: "alice",
    name: "Alice",
    email: "alice@example.com",
    businessId: "biz-1",
    sharedSessions: true,
    businessMemberIds: ["user-1", "user-2"],
  },
} satisfies AuthInfo;

describe("observability service", () => {
  it("owner-scopes prompt run search for shared-business non-admins and binds Unix millisecond timestamps", async () => {
    const { db, getParams, getSql } = makeDb();
    const createdAfter = Date.parse("2026-04-14T00:00:00.000Z");
    const createdBefore = Date.parse("2026-04-15T00:00:00.000Z");

    await queryPromptRuns(db, { createdAfter, createdBefore }, sharedBusinessAuth);

    expect(getSql()).toContain("owner_user_id = ?");
    expect(getSql()).not.toContain("business_id = ?");
    expect(getParams()).toEqual(["user-1", createdAfter, createdBefore, 50, 0]);
  });

  it("bounds session telemetry to the newest prompt runs and returns them ascending", async () => {
    const { db, getParams, getSql } = makeDb();

    await getSessionTelemetry(db, "sess-1", 75);

    expect(getSql()).toContain("FROM (");
    expect(getSql()).toContain("FROM prompt_runs");
    expect(getSql()).toContain("ORDER BY created_at DESC");
    expect(getSql()).toContain("LIMIT ?");
    expect(getSql()).toContain("ORDER BY created_at ASC");
    expect(getSql()).not.toContain("SELECT *");
    expect(getParams()).toEqual(["sess-1", 75]);
  });

  it("clamps session telemetry service limits to the max", async () => {
    const { db, getParams } = makeDb();

    await getSessionTelemetry(db, "sess-1", 500);

    expect(getParams()).toEqual(["sess-1", 200]);
  });

  it("clamps a negative prompt-run limit to 1 so it never binds the SQLite unlimited sentinel", async () => {
    const { db, getParams } = makeDb();

    // `LIMIT -1` is SQLite's "no limit": a negative limit must not reach the query.
    await queryPromptRuns(db, { limit: -1, offset: -5 }, sharedBusinessAuth);

    const params = getParams();
    expect(params[params.length - 2]).toBe(1); // limit
    expect(params[params.length - 1]).toBe(0); // offset
  });

  it("clamps a negative session-search limit to 1", async () => {
    const { db, getParams } = makeDb();

    await searchSessions(db, { repo: "acme/api", limit: -1 }, sharedBusinessAuth);

    const params = getParams();
    expect(params[params.length - 1]).toBe(1);
  });

  it("owner-scopes session search for shared-business non-admins", async () => {
    const { db, getParams, getSql } = makeDb();

    await searchSessions(db, { repo: "acme/api" }, sharedBusinessAuth);

    expect(getSql()).toContain("s.owner_user_id = ?");
    expect(getSql()).not.toContain("s.business_id = ?");
    expect(getParams()).toEqual(["user-1", "acme/api", 50]);
  });

  it("labels prompt-run aggregates as matching aggregates and returns nulls when no prompt-run filter is used", async () => {
    const joined = makeDb();
    await searchSessions(joined.db, { outcome: "failed" }, sharedBusinessAuth);

    expect(joined.getSql()).toContain("COUNT(pr.id) AS matching_prompt_count");
    expect(joined.getSql()).not.toContain(" AS prompt_count");
    expect(joined.getSql()).not.toContain(" AS failed_count");
    expect(joined.getSql()).not.toContain(" AS total_cost_usd_micros");

    const unjoined = makeDb();
    await searchSessions(unjoined.db, { status: "active" }, sharedBusinessAuth);

    expect(unjoined.getSql()).toContain("NULL AS matching_prompt_count");
    expect(unjoined.getSql()).toContain("NULL AS matching_failed_count");
    expect(unjoined.getSql()).toContain("NULL AS matching_total_cost_usd_micros");
  });

  it("keeps observability debugging read routes on the admin-token allowlist", () => {
    const observabilityReadRoutes = [
      ["GET", "/api/sessions/:sessionId/sandbox-state"],
      ["GET", "/api/sessions/:sessionId/artifacts/list"],
      ["GET", "/api/sessions/:sessionId/feedback/all"],
      ["GET", "/api/observability/sessions"],
    ];

    expect(ADMIN_TOKEN_ROUTE_ALLOWLIST).toEqual(expect.arrayContaining(observabilityReadRoutes));
  });

  it("keeps the session-outcomes harm ranking on the admin-token allowlist", () => {
    expect(ADMIN_TOKEN_ROUTE_ALLOWLIST).toEqual(
      expect.arrayContaining([["GET", "/api/observability/session-outcomes"]]),
    );
  });

  it("keeps Slack channel memory setup routes on the admin-token allowlist", () => {
    expect(ADMIN_TOKEN_ROUTE_ALLOWLIST).toEqual(
      expect.arrayContaining([
        ["GET", "/api/admin/slack-channel-intake"],
        ["GET", "/api/admin/slack-channel-intake/channels"],
        ["POST", "/api/admin/slack-channel-intake"],
      ]),
    );
  });
});
