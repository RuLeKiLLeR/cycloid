import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAutomationRunHistory = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/automation/run-history-service", () => ({
  getAutomationRunHistory: mockGetAutomationRunHistory,
}));

import { automationRunRoutes } from "../../apps/control-plane-worker/src/routes/automation-runs";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

function auth(businessId: string | null): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user",
    canAccessAllSessions: false,
    user: businessId ? ({ businessId } as AuthInfo["user"]) : null,
  } as AuthInfo;
}

async function invoke(query = "", routeAuth = auth("biz-1")): Promise<Response> {
  const route = automationRunRoutes[0]!;
  const url = `https://example.com/api/automations/runs${query}`;
  const request = new Request(url);
  return route.handler(
    request,
    { DB: {} as D1Database } as Env,
    new URL(url).pathname.match(route.pattern)!,
    routeAuth,
  );
}

describe("GET /api/automations/runs", () => {
  beforeEach(() => mockGetAutomationRunHistory.mockReset());

  it("rejects missing business membership and malformed cursors before querying", async () => {
    expect((await invoke("", auth(null))).status).toBe(403);
    expect((await invoke("?cursor=not-base64")).status).toBe(400);
    expect(mockGetAutomationRunHistory).not.toHaveBeenCalled();
  });

  it("decodes the cursor, scopes by business, and returns the last visible row as nextCursor", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      source: "schedule" as const,
      id: `job-${index}`,
      rule_id: "rule-1",
      rule_name: "Rule",
      trigger_provider: null,
      phase: "fired",
      failure_code: null,
      created_at: 1_000 - index,
      updated_at: 1_000 - index,
      session_id: null,
      session_status: null,
    }));
    mockGetAutomationRunHistory.mockResolvedValue(rows);
    const cursor = btoa(JSON.stringify([2_000, "prior", "slack_alert"]));

    const response = await invoke(`?cursor=${encodeURIComponent(cursor)}`);
    expect(response.status).toBe(200);
    expect(mockGetAutomationRunHistory).toHaveBeenCalledWith({
      db: expect.anything(),
      businessId: "biz-1",
      cursor: { createdAt: 2_000, id: "prior", source: "slack_alert" },
      limit: 51,
    });
    const body = (await response.json()) as { items: unknown[]; nextCursor: string };
    expect(body.items).toHaveLength(50);
    expect(JSON.parse(atob(body.nextCursor))).toEqual([951, "job-49", "schedule"]);
  });
});
