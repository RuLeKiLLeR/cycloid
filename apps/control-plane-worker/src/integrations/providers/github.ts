import type {
  IntegrationLifecycleReasonCode,
  IntegrationLifecycleStage,
} from "../../../../../shared/enums/integration-lifecycle.js";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
} from "../../../../../shared/enums/integration-lifecycle.js";
import { getValidGithubTokenResult, type GithubTokenRefreshEnv } from "../../auth/db";
import { probeGithubRepoAccess } from "../../auth/repo-authorization";
import { getInstallationByOwner } from "../../github/installations-db";
import { createLogger } from "../../logger";
import { getGithubTokens } from "../db";

const log = createLogger({ bindings: { component: "github-provider" } });

interface IntegrationFailure {
  stage: IntegrationLifecycleStage;
  reasonCode: IntegrationLifecycleReasonCode;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface ProviderProbeContext {
  db: D1Database;
  userId: string;
  businessId?: string | null;
  sessionId?: string | null;
  repoOwner?: string;
  repoName?: string;
}

export type ProviderProbeResult =
  | { ok: true; sessionMetadata?: { installationId?: number } }
  | {
      ok: false;
      failure: IntegrationFailure;
    };

type GithubProviderEnv = GithubTokenRefreshEnv & {
  REPOS_CACHE?: KVNamespace;
};

export class GithubProvider {
  readonly id = "github";

  constructor(private readonly env: GithubProviderEnv) {}

  async runPreflightProbe(ctx: ProviderProbeContext): Promise<ProviderProbeResult> {
    if (!ctx.repoOwner || !ctx.repoName) {
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CONTROL_PLANE_CONFIGURED,
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.SANDBOX_TOKEN_UNPREPARED,
          message: "GitHub preflight requires repository context.",
        },
      };
    }

    const preloadedTokens = await getGithubTokens(ctx.db, ctx.userId, this.env.TOKEN_ENCRYPTION_KEY);
    if (!preloadedTokens) {
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_MISSING,
          message: "No GitHub OAuth token is stored for this user.",
        },
      };
    }

    const tokenResult = await getValidGithubTokenResult(ctx.db, ctx.userId, this.env, preloadedTokens);
    if (!tokenResult.ok) {
      const reasonCode =
        tokenResult.reason === "token_refresh_unavailable"
          ? INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_API_UNAVAILABLE
          : INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REFRESH_FAILED;
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode,
          message: tokenResult.message,
          ...(tokenResult.status ? { details: { httpStatus: tokenResult.status } } : {}),
        },
      };
    }

    const probe = await probeGithubRepoAccess(ctx.db, ctx.userId, ctx.repoOwner, ctx.repoName, {
      githubTokenEnv: this.env,
      reposCacheEnv: this.env.REPOS_CACHE ? { REPOS_CACHE: this.env.REPOS_CACHE } : null,
    });
    if (!probe.ok) {
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_API_UNAVAILABLE,
          message: probe.message,
        },
      };
    }
    if (!probe.access) {
      const reasonCode =
        probe.reason === "provider_authn_rejected"
          ? INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_AUTHN_REJECTED
          : probe.reason === "provider_rate_limited"
            ? INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_RATE_LIMITED
            : INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED;
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode,
          message: `GitHub repo probe failed with HTTP ${probe.status}.`,
          details: { httpStatus: probe.status, repoOwner: ctx.repoOwner, repoName: ctx.repoName },
        },
      };
    }

    const installation = await getInstallationByOwner(ctx.db, ctx.repoOwner);
    if (!installation) {
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.INSTALL_MISSING,
          message: "Cycloid is not installed for this GitHub organization.",
          details: { repoOwner: ctx.repoOwner, repoName: ctx.repoName },
        },
      };
    }
    if (installation.suspended_at) {
      return {
        ok: false,
        failure: {
          stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
          reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.REPO_ACCESS_DENIED,
          message: "The GitHub App installation is suspended.",
          details: { installationId: installation.installation_id, repoOwner: ctx.repoOwner, repoName: ctx.repoName },
        },
      };
    }

    log.info(
      {
        userId: ctx.userId,
        repoOwner: ctx.repoOwner,
        repoName: ctx.repoName,
        installationId: installation.installation_id,
      },
      "GitHub preflight probe passed",
    );
    return {
      ok: true,
      sessionMetadata: { installationId: installation.installation_id },
    };
  }
}
