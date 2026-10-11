import { beforeEach, describe, expect, it, vi } from "vitest";

const tracedFetch = vi.fn();
vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch,
}));

const getValidJiraToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidJiraToken,
}));

const listDueJiraPersonalDataReportAccounts = vi.fn();
const getJiraPersonalDataReportingTokenUserId = vi.fn();
const markJiraPersonalDataReportAccountsFailed = vi.fn();
const markJiraPersonalDataReportAccountsReported = vi.fn();
const markJiraPersonalDataReportAccountsUpdated = vi.fn();
const deleteJiraUserDataByAccountIds = vi.fn();

vi.mock("../../apps/control-plane-worker/src/integrations/db", () => ({
  listDueJiraPersonalDataReportAccounts,
  getJiraPersonalDataReportingTokenUserId,
  markJiraPersonalDataReportAccountsFailed,
  markJiraPersonalDataReportAccountsReported,
  markJiraPersonalDataReportAccountsUpdated,
  deleteJiraUserDataByAccountIds,
}));

const now = Date.UTC(2026, 5, 12, 16, 0, 0);
const db = {} as D1Database;
const env = {
  DB: db,
  TOKEN_ENCRYPTION_KEY: "token-key",
  JIRA_OAUTH_CLIENT_ID: "jira-client",
  JIRA_OAUTH_CLIENT_SECRET: "jira-secret",
} as import("../../apps/control-plane-worker/src/types").Env;

function dueAccounts() {
  return [
    { jiraAccountId: "acct-1", personalDataUpdatedAt: Date.UTC(2026, 5, 10, 12, 0, 0) },
    { jiraAccountId: "acct-2", personalDataUpdatedAt: Date.UTC(2026, 5, 11, 12, 0, 0) },
  ];
}

describe("Jira personal-data reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDueJiraPersonalDataReportAccounts.mockResolvedValue(dueAccounts());
    getJiraPersonalDataReportingTokenUserId.mockResolvedValue(42);
    getValidJiraToken.mockResolvedValue("jira-access-token");
  });

  it("skips when no accounts are due", async () => {
    listDueJiraPersonalDataReportAccounts.mockResolvedValueOnce([]);
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 0 });
    expect(tracedFetch).not.toHaveBeenCalled();
  });

  it("posts due accounts and marks 204 responses reported with the cycle period", async () => {
    tracedFetch.mockResolvedValueOnce(new Response(null, { status: 204, headers: { "Cycle-Period": "3600" } }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 2, closed: 0, updated: 0, skipped: 0, failed: 0 });
    expect(tracedFetch).toHaveBeenCalledWith(
      "https://api.atlassian.com/app/report-accounts/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer jira-access-token" }),
      }),
      "jira.personal_data.report_accounts",
    );
    const body = JSON.parse(tracedFetch.mock.calls[0][1].body as string) as {
      accounts: Array<{ accountId: string; updatedAt: string }>;
    };
    expect(body.accounts).toEqual([
      { accountId: "acct-1", updatedAt: "2026-06-10T12:00:00.000Z" },
      { accountId: "acct-2", updatedAt: "2026-06-11T12:00:00.000Z" },
    ]);
    expect(markJiraPersonalDataReportAccountsReported).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      reportedAt: now,
      nextReportAfter: now + 3_600_000,
      status: "reported",
    });
  });

  it("deletes local Jira user data for closed and unknown accounts and leaves updated accounts connected", async () => {
    listDueJiraPersonalDataReportAccounts.mockResolvedValueOnce([
      ...dueAccounts(),
      { jiraAccountId: "acct-3", personalDataUpdatedAt: Date.UTC(2026, 5, 11, 18, 0, 0) },
    ]);
    tracedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accounts: [
            { accountId: "acct-1", status: "closed" },
            { accountId: "acct-2", status: "updated" },
            { accountId: "acct-3", status: "unknown" },
          ],
        }),
        { status: 200 },
      ),
    );
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 2, updated: 1, skipped: 0, failed: 0 });
    expect(deleteJiraUserDataByAccountIds).toHaveBeenCalledWith(db, ["acct-1", "acct-3"]);
    expect(deleteJiraUserDataByAccountIds).toHaveBeenCalledTimes(1);
    expect(markJiraPersonalDataReportAccountsUpdated).toHaveBeenCalledWith(db, ["acct-2"], {
      personalDataUpdatedAt: now,
      reportedAt: now,
      nextReportAfter: now + 7 * 24 * 60 * 60 * 1000,
    });
    expect(markJiraPersonalDataReportAccountsReported).not.toHaveBeenCalled();
  });

  it("treats unmentioned 200-response accounts as reported", async () => {
    tracedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 2, closed: 0, updated: 0, skipped: 0, failed: 0 });
    expect(markJiraPersonalDataReportAccountsReported).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      reportedAt: now,
      nextReportAfter: now + 7 * 24 * 60 * 60 * 1000,
      status: "reported",
    });
  });

  it("respects Retry-After on 429 responses", async () => {
    tracedFetch.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_rate_limited",
      now,
      nextReportAfter: now + 120_000,
    });
  });

  it("backs off on 429 responses without Retry-After", async () => {
    tracedFetch.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_rate_limited",
      now,
      nextReportAfter: now + 3_600_000,
    });
  });

  it("backs off on request failures", async () => {
    tracedFetch.mockRejectedValueOnce(new TypeError("network down"));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_request_failed",
      now,
      nextReportAfter: now + 3_600_000,
    });
  });

  it("backs off on non-2xx report responses", async () => {
    tracedFetch.mockResolvedValueOnce(new Response("upstream broke", { status: 503 }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_http_503",
      now,
      nextReportAfter: now + 3_600_000,
    });
  });

  it("marks malformed 200-response bodies failed instead of reported", async () => {
    tracedFetch.mockResolvedValueOnce(new Response("{", { status: 200 }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_invalid_response",
      now,
      nextReportAfter: now + 3_600_000,
    });
    expect(markJiraPersonalDataReportAccountsReported).not.toHaveBeenCalled();
  });

  it("marks 200 responses without an accounts array failed instead of reported", async () => {
    tracedFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 2 });
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_invalid_response",
      now,
      nextReportAfter: now + 3_600_000,
    });
    expect(markJiraPersonalDataReportAccountsReported).not.toHaveBeenCalled();
  });

  it("fails closed without deleting data when no reporting token is available", async () => {
    getJiraPersonalDataReportingTokenUserId.mockResolvedValueOnce(null);
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 2, failed: 2 });
    expect(tracedFetch).not.toHaveBeenCalled();
    expect(deleteJiraUserDataByAccountIds).not.toHaveBeenCalled();
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_token_missing",
      now,
      nextReportAfter: now + 3_600_000,
    });
  });

  it("backs off when the selected reporting token cannot be refreshed", async () => {
    getValidJiraToken.mockResolvedValueOnce(null);
    const { runDueJiraPersonalDataReports } =
      await import("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting");

    const result = await runDueJiraPersonalDataReports(env, { now });

    expect(result).toEqual({ reported: 0, closed: 0, updated: 0, skipped: 2, failed: 2 });
    expect(tracedFetch).not.toHaveBeenCalled();
    expect(markJiraPersonalDataReportAccountsFailed).toHaveBeenCalledWith(db, ["acct-1", "acct-2"], {
      error: "jira_reporting_token_unavailable",
      now,
      nextReportAfter: now + 3_600_000,
    });
  });
});
