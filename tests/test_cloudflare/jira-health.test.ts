// Determinism guard for the Jira health sweep: when two installations for the
// same business share an updatedAt, the candidate chosen (and therefore the
// jiraCloudId recorded) must not depend on DB row arrival order.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListInstallations = vi.hoisted(() => vi.fn());
const mockGetValidJiraToken = vi.hoisted(() => vi.fn());
const mockTracedFetch = vi.hoisted(() => vi.fn());
const mockListLatestChecks = vi.hoisted(() => vi.fn());
const mockRecordCheck = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  listNonRevokedJiraWebhookInstallations: mockListInstallations,
}));
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidJiraToken: mockGetValidJiraToken,
}));
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: mockTracedFetch,
}));
vi.mock("../../apps/control-plane-worker/src/integrations/health-db", () => ({
  listLatestBusinessIntegrationHealthChecks: mockListLatestChecks,
  recordBusinessIntegrationHealthCheck: mockRecordCheck,
}));

import { runDueJiraHealthChecks } from "../../apps/control-plane-worker/src/integrations/jira-health";
import type { Env } from "../../apps/control-plane-worker/src/types";

const UPDATED_AT = 1_700_000_000_000;

function installation(jiraCloudId: string) {
  return {
    businessId: "biz-1",
    jiraCloudId,
    connectedByUserId: 42,
    updatedAt: UPDATED_AT,
    status: "active" as const,
    webhookExpiresAt: null,
  };
}

async function recordedCloudIdForOrder(order: ReturnType<typeof installation>[]): Promise<string | undefined> {
  mockRecordCheck.mockClear();
  mockListInstallations.mockResolvedValue(order);
  await runDueJiraHealthChecks({ DB: {} as D1Database } as unknown as Env, { now: UPDATED_AT + 60_000 });
  // Exactly one candidate per business is checked.
  expect(mockRecordCheck).toHaveBeenCalledTimes(1);
  const details = mockRecordCheck.mock.calls[0][1]?.details as { expectedCloudId?: string } | undefined;
  return details?.expectedCloudId;
}

describe("runDueJiraHealthChecks candidate determinism", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetValidJiraToken.mockResolvedValue("jira-token");
    // Fresh Response per call: a single shared Response body would be consumed
    // on the first sweep and fail the second. Bound site present, so the check
    // passes and the recorded expectedCloudId is the chosen candidate's cloud id.
    mockTracedFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify([{ id: "cloud-aaa", url: "https://acme.atlassian.net" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    mockListLatestChecks.mockResolvedValue([]);
    mockRecordCheck.mockResolvedValue(undefined);
  });

  it("picks the same installation regardless of input row order when updatedAt ties", async () => {
    const forward = await recordedCloudIdForOrder([installation("cloud-aaa"), installation("cloud-zzz")]);
    const reversed = await recordedCloudIdForOrder([installation("cloud-zzz"), installation("cloud-aaa")]);

    expect(forward).toBe(reversed);
    // Tiebreak is jiraCloudId ascending, so the lexicographically smaller id wins.
    expect(forward).toBe("cloud-aaa");
  });
});
