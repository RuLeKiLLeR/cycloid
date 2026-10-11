import { getValidJiraToken } from "../auth/db";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import {
  deleteJiraUserDataByAccountIds,
  getJiraPersonalDataReportingTokenUserId,
  listDueJiraPersonalDataReportAccounts,
  markJiraPersonalDataReportAccountsFailed,
  markJiraPersonalDataReportAccountsReported,
  markJiraPersonalDataReportAccountsUpdated,
} from "./db";

const log = createLogger({ bindings: { component: "jira-personal-data-reporting" } });

const ATLASSIAN_REPORT_ACCOUNTS_URL = "https://api.atlassian.com/app/report-accounts/";
const ATLASSIAN_REPORT_ACCOUNTS_OPERATION = "jira.personal_data.report_accounts";
const ATLASSIAN_REPORT_BATCH_SIZE = 90;
const DEFAULT_REPORT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_UNAVAILABLE_RETRY_MS = 60 * 60 * 1000;
const REPORT_FAILURE_RETRY_MS = 60 * 60 * 1000;

interface AtlassianReportAccountResponse {
  accountId?: string;
  status?: string;
}

interface AtlassianReportResponseBody {
  accounts?: AtlassianReportAccountResponse[];
}

export interface JiraPersonalDataReportSweepResult {
  reported: number;
  closed: number;
  updated: number;
  skipped: number;
  failed: number;
}

function parseHeaderSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nextReportAfter(response: Response, now: number): number {
  const cycleSeconds = parseHeaderSeconds(response.headers.get("Cycle-Period"));
  return now + (cycleSeconds ? cycleSeconds * 1000 : DEFAULT_REPORT_CYCLE_MS);
}

function emptyResult(skipped = 0): JiraPersonalDataReportSweepResult {
  return { reported: 0, closed: 0, updated: 0, skipped, failed: 0 };
}

async function parseReportResponseBody(response: Response): Promise<AtlassianReportResponseBody | null> {
  const body = (await response.json().catch(() => null)) as AtlassianReportResponseBody | null;
  return body && Array.isArray(body.accounts) ? body : null;
}

export async function runDueJiraPersonalDataReports(
  env: Env,
  options: { now?: number; logger?: Logger },
): Promise<JiraPersonalDataReportSweepResult> {
  const db = env.DB;
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now();
  const dueAccounts = await listDueJiraPersonalDataReportAccounts(db, {
    now,
    limit: ATLASSIAN_REPORT_BATCH_SIZE,
  });

  if (dueAccounts.length === 0) return emptyResult();

  const jiraAccountIds = dueAccounts.map((account) => account.jiraAccountId);
  const tokenUserId = await getJiraPersonalDataReportingTokenUserId(db);
  if (tokenUserId === null) {
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: "jira_reporting_token_missing",
      now,
      nextReportAfter: now + TOKEN_UNAVAILABLE_RETRY_MS,
    });
    logger.warn({ dueCount: dueAccounts.length }, "Skipped Jira personal-data reporting: no Jira bearer token");
    return { ...emptyResult(dueAccounts.length), failed: dueAccounts.length };
  }

  const accessToken = await getValidJiraToken(db, String(tokenUserId), env);
  if (!accessToken) {
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: "jira_reporting_token_unavailable",
      now,
      nextReportAfter: now + TOKEN_UNAVAILABLE_RETRY_MS,
    });
    logger.warn(
      { tokenUserId, dueCount: dueAccounts.length },
      "Skipped Jira personal-data reporting: token unavailable",
    );
    return { ...emptyResult(dueAccounts.length), failed: dueAccounts.length };
  }

  let response: Response;
  try {
    response = await tracedFetch(
      ATLASSIAN_REPORT_ACCOUNTS_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          accounts: dueAccounts.map((account) => ({
            accountId: account.jiraAccountId,
            updatedAt: new Date(account.personalDataUpdatedAt).toISOString(),
          })),
        }),
      },
      ATLASSIAN_REPORT_ACCOUNTS_OPERATION,
    );
  } catch (error) {
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: "jira_reporting_request_failed",
      now,
      nextReportAfter: now + REPORT_FAILURE_RETRY_MS,
    });
    logger.warn(
      { dueCount: dueAccounts.length, errorName: error instanceof Error ? error.name : typeof error },
      "Jira personal-data reporting request failed",
    );
    return { ...emptyResult(), failed: dueAccounts.length };
  }

  if (response.status === 204) {
    await markJiraPersonalDataReportAccountsReported(db, jiraAccountIds, {
      reportedAt: now,
      nextReportAfter: nextReportAfter(response, now),
      status: "reported",
    });
    return { ...emptyResult(), reported: dueAccounts.length };
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseHeaderSeconds(response.headers.get("Retry-After"));
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: "jira_reporting_rate_limited",
      now,
      nextReportAfter: retryAfterSeconds ? now + retryAfterSeconds * 1000 : now + REPORT_FAILURE_RETRY_MS,
    });
    return { ...emptyResult(), failed: dueAccounts.length };
  }

  if (!response.ok) {
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: `jira_reporting_http_${response.status}`,
      now,
      nextReportAfter: now + REPORT_FAILURE_RETRY_MS,
    });
    return { ...emptyResult(), failed: dueAccounts.length };
  }

  const body = await parseReportResponseBody(response);
  if (!body) {
    await markJiraPersonalDataReportAccountsFailed(db, jiraAccountIds, {
      error: "jira_reporting_invalid_response",
      now,
      nextReportAfter: now + REPORT_FAILURE_RETRY_MS,
    });
    return { ...emptyResult(), failed: dueAccounts.length };
  }

  const accounts = body.accounts ?? [];
  const statusByAccountId = new Map(
    accounts
      .filter((account): account is { accountId: string; status: string } =>
        Boolean(account.accountId && account.status),
      )
      .map((account) => [account.accountId, account.status]),
  );

  const closedAccountIds = jiraAccountIds.filter((accountId) => statusByAccountId.get(accountId) === "closed");
  const unknownAccountIds = jiraAccountIds.filter((accountId) => statusByAccountId.get(accountId) === "unknown");
  const updatedAccountIds = jiraAccountIds.filter((accountId) => statusByAccountId.get(accountId) === "updated");
  const deletedAccountIds = [...closedAccountIds, ...unknownAccountIds];
  const reportedAccountIds = jiraAccountIds.filter(
    (accountId) => !deletedAccountIds.includes(accountId) && !updatedAccountIds.includes(accountId),
  );
  const dueNextReportAfter = nextReportAfter(response, now);

  await deleteJiraUserDataByAccountIds(db, deletedAccountIds);
  if (updatedAccountIds.length > 0) {
    await markJiraPersonalDataReportAccountsUpdated(db, updatedAccountIds, {
      personalDataUpdatedAt: now,
      reportedAt: now,
      nextReportAfter: dueNextReportAfter,
    });
  }
  if (reportedAccountIds.length > 0) {
    await markJiraPersonalDataReportAccountsReported(db, reportedAccountIds, {
      reportedAt: now,
      nextReportAfter: dueNextReportAfter,
      status: "reported",
    });
  }

  return {
    reported: reportedAccountIds.length,
    closed: deletedAccountIds.length,
    updated: updatedAccountIds.length,
    skipped: 0,
    failed: 0,
  };
}
