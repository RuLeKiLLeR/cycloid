import { getUserBusinessIdOrNull, getValidGithubToken } from "../auth/db";
import { GITHUB_API, githubHeaders } from "../github/pr";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import {
  deleteBusinessIntegrationHealthChecksBefore,
  getLatestBusinessIntegrationHealthCheck,
  type IntegrationHealthStatus,
  recordBusinessIntegrationHealthCheck,
} from "./health-db";
import { envFlagEnabled, parsePositiveEnvMs, sanitizedHealthExceptionDetails } from "./health-util";

const log = createLogger({ bindings: { component: "github-health" } });

const GITHUB_HEALTH_OPERATION = "github.repos.get";
const GITHUB_HEALTH_CHECK_KIND = "basic";
const DEFAULT_GITHUB_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GITHUB_HEALTH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GITHUB_HEALTH_TIMEOUT_MS = 10_000;

type RunGithubHealthCheckOptions = {
  now?: number;
  logger?: Logger;
};

type GithubHealthConfig = {
  businessId: string;
  ownerUserId: string;
  repoOwner: string;
  repoName: string;
  intervalMs: number;
};

type GithubHealthCheckResult = {
  businessId: string;
  status: IntegrationHealthStatus;
  operation: string;
  checkedAt: number;
  latencyMs: number;
  diagnostic: string;
  failureReason: string | null;
  details: Record<string, unknown> | null;
};

function githubRepoApiUrl(repoOwner: string, repoName: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`;
}

async function resolveGithubHealthConfig(env: Env): Promise<GithubHealthConfig | null> {
  if (!envFlagEnabled(env.GITHUB_HEALTH_ENABLED)) return null;

  const ownerUserId = (env.GITHUB_HEALTH_OWNER_USER_ID || "").trim();
  const repoOwner = env.GITHUB_HEALTH_REPO_OWNER?.trim() ?? "";
  const repoName = env.GITHUB_HEALTH_REPO_NAME?.trim() ?? "";
  if (!ownerUserId || !/^\d+$/.test(ownerUserId) || !repoOwner || !repoName) return null;

  const businessId = await getUserBusinessIdOrNull(env.DB, Number(ownerUserId));
  if (!businessId) return null;

  return {
    businessId,
    ownerUserId,
    repoOwner,
    repoName,
    intervalMs: parsePositiveEnvMs(env.GITHUB_HEALTH_INTERVAL_MS, DEFAULT_GITHUB_HEALTH_INTERVAL_MS),
  };
}

async function shouldCheckGithubBusiness(
  db: D1Database,
  businessId: string,
  now: number,
  intervalMs: number,
): Promise<boolean> {
  const latest = await getLatestBusinessIntegrationHealthCheck(db, businessId, "github", GITHUB_HEALTH_CHECK_KIND);
  return !latest || latest.checked_at <= now - intervalMs;
}

function summarizeGithubApiFailure(response: Response): string {
  if (response.status === 401) return "github_auth_rejected";
  if (response.status === 403) return "github_repo_access_denied";
  if (response.status === 404) return "github_repo_not_found";
  if (response.status === 429) return "github_rate_limited";
  if (response.status >= 500) return "github_server_error";
  return "github_api_error";
}

function buildBasicResult(
  config: GithubHealthConfig,
  checkedAt: number,
  startedAt: number,
  params: {
    status: IntegrationHealthStatus;
    diagnostic: string;
    failureReason: string | null;
    details: Record<string, unknown> | null;
  },
): GithubHealthCheckResult {
  return {
    businessId: config.businessId,
    status: params.status,
    operation: GITHUB_HEALTH_OPERATION,
    checkedAt,
    latencyMs: Date.now() - startedAt,
    diagnostic: params.diagnostic,
    failureReason: params.failureReason,
    details: params.details,
  };
}

async function runGithubRepoHealthCheck(
  env: Env,
  config: GithubHealthConfig,
  options: RunGithubHealthCheckOptions,
): Promise<GithubHealthCheckResult> {
  const logger = options.logger ?? log;
  const checkedAt = options.now ?? Date.now();
  const startedAt = Date.now();
  const baseDetails: Record<string, unknown> = {
    repo: `${config.repoOwner}/${config.repoName}`,
    ownerUserId: config.ownerUserId,
  };

  try {
    const token = await getValidGithubToken(env.DB, config.ownerUserId, env);
    if (!token) {
      return buildBasicResult(config, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "github_token_missing",
        failureReason: "GitHub OAuth token could not be resolved or refreshed for the configured owner user.",
        details: baseDetails,
      });
    }

    const response = await tracedFetch(
      githubRepoApiUrl(config.repoOwner, config.repoName),
      {
        method: "GET",
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_HEALTH_TIMEOUT_MS),
      },
      "github.health.repo",
    );

    if (!response.ok) {
      return buildBasicResult(config, checkedAt, startedAt, {
        status: "failed",
        diagnostic: summarizeGithubApiFailure(response),
        failureReason: `GitHub repo API returned HTTP ${response.status}.`,
        details: baseDetails,
      });
    }

    const body = (await response.json()) as { full_name?: unknown; private?: unknown; default_branch?: unknown };
    const expectedFullName = `${config.repoOwner}/${config.repoName}`.toLowerCase();
    if (typeof body.full_name !== "string" || body.full_name.toLowerCase() !== expectedFullName) {
      return buildBasicResult(config, checkedAt, startedAt, {
        status: "failed",
        diagnostic: "github_response_shape_invalid",
        failureReason: "GitHub repo API returned an unexpected repository payload.",
        details: baseDetails,
      });
    }

    return buildBasicResult(config, checkedAt, startedAt, {
      status: "passed",
      diagnostic: "github_repo_access_confirmed",
      failureReason: null,
      details: {
        ...baseDetails,
        private: typeof body.private === "boolean" ? body.private : null,
        defaultBranch: typeof body.default_branch === "string" ? body.default_branch : null,
      },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    const sanitizedError = sanitizedHealthExceptionDetails(error, {
      timeoutFailureReason: "GitHub repo API request timed out.",
      defaultFailureReason: "GitHub health check failed unexpectedly.",
    });
    const diagnostic = isTimeout ? "github_api_timeout" : "github_health_exception";
    logger.warn(
      { businessId: config.businessId, diagnostic, errorName: sanitizedError.errorName },
      "GitHub health check failed",
    );
    return buildBasicResult(config, checkedAt, startedAt, {
      status: "failed",
      diagnostic,
      failureReason: sanitizedError.failureReason,
      details: baseDetails,
    });
  }
}

async function recordGithubHealthCheck(db: D1Database, result: GithubHealthCheckResult): Promise<void> {
  await recordBusinessIntegrationHealthCheck(db, {
    businessId: result.businessId,
    integrationId: "github",
    checkKind: GITHUB_HEALTH_CHECK_KIND,
    status: result.status,
    operation: result.operation,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    diagnostic: result.diagnostic,
    failureReason: result.failureReason,
    details: result.details,
  });
}

export async function runDueGithubHealthChecks(
  env: Env,
  options: RunGithubHealthCheckOptions,
): Promise<{ checked: number; skipped: number; failed: number }> {
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now();
  const config = await resolveGithubHealthConfig(env);
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const deleted = await deleteBusinessIntegrationHealthChecksBefore(
      env.DB,
      "github",
      now - DEFAULT_GITHUB_HEALTH_RETENTION_MS,
    );
    if (deleted > 0) logger.info({ deleted }, "Pruned old integration health check rows");
  } catch (error) {
    const sanitizedError = sanitizedHealthExceptionDetails(error, {
      timeoutFailureReason: "Integration health check retention sweep timed out.",
      defaultFailureReason: "Integration health check retention sweep failed.",
    });
    logger.warn({ errorName: sanitizedError.errorName }, "Integration health check retention sweep failed");
  }

  if (config) {
    if (await shouldCheckGithubBusiness(env.DB, config.businessId, now, config.intervalMs)) {
      const result = await runGithubRepoHealthCheck(env, config, { now, logger });
      await recordGithubHealthCheck(env.DB, result);
      checked += 1;
      if (result.status !== "passed") failed += 1;
    } else {
      skipped += 1;
    }
  }

  return { checked, skipped, failed };
}
