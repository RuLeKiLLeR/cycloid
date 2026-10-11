import {
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import {
  getIntegrationLifecycleSummary,
  mapReasonCodeToBusinessMessage,
  mapReasonCodeToUserMessage,
  writeIntegrationLifecycleEvent,
} from "../integrations/lifecycle/service";
import { GithubProvider } from "../integrations/providers/github";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "integration-gating" } });

type IntegrationGateOutcome =
  | { ok: true; installationId: number }
  | {
      ok: false;
      status: 409;
      body: {
        ok: false;
        error: "integration_blocked";
        integrationId: "github";
        stage: string;
        reasonCode: string;
        userMessage: string;
      };
    };

export async function gateGithubSessionStart(
  env: Env,
  params: {
    userId: string;
    businessId: string | null;
    sessionId: string;
    repoOwner: string;
    repoName: string;
  },
): Promise<IntegrationGateOutcome> {
  const db = env.DB;
  const provider = new GithubProvider(env);
  const userIdNumber = Number(params.userId);
  const now = Date.now();

  await writeIntegrationLifecycleEvent(db, {
    integrationId: "github",
    stage: INTEGRATION_LIFECYCLE_STAGE.CONTROL_PLANE_CONFIGURED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: params.businessId,
    userId: Number.isFinite(userIdNumber) ? userIdNumber : null,
    sessionId: params.sessionId,
    message: "GitHub session-start preflight began.",
    createdAt: now,
  });

  const result = await provider.runPreflightProbe({
    db,
    userId: params.userId,
    businessId: params.businessId,
    sessionId: params.sessionId,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
  });

  if (!result.ok) {
    await writeIntegrationLifecycleEvent(db, {
      integrationId: "github",
      stage: result.failure.stage,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      businessId: params.businessId,
      userId: Number.isFinite(userIdNumber) ? userIdNumber : null,
      sessionId: params.sessionId,
      reasonCode: result.failure.reasonCode,
      message: result.failure.message,
      details: {
        ...result.failure.details,
        nextStage: "blocked",
      },
    });
    const body = {
      ok: false as const,
      error: "integration_blocked" as const,
      integrationId: "github" as const,
      stage: result.failure.stage,
      reasonCode: result.failure.reasonCode,
      userMessage: mapReasonCodeToUserMessage("github", result.failure.reasonCode, {
        owner: params.repoOwner,
        name: params.repoName,
      }),
    };
    log.warn({ sessionId: params.sessionId, body }, "GitHub integration gate blocked session start");
    return { ok: false, status: 409, body };
  }

  const installationId = result.sessionMetadata?.installationId ?? null;
  if (!installationId) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: INTEGRATION_LIFECYCLE_STAGE.SANDBOX_TOKEN_PREPARED,
        reasonCode: "sandbox_token_unprepared",
        userMessage: mapReasonCodeToUserMessage("github", "sandbox_token_unprepared", {
          owner: params.repoOwner,
          name: params.repoName,
        }),
      },
    };
  }

  await writeIntegrationLifecycleEvent(db, {
    integrationId: "github",
    stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: params.businessId,
    userId: Number.isFinite(userIdNumber) ? userIdNumber : null,
    sessionId: params.sessionId,
    message: "GitHub repo access and installation probe passed.",
    details: { repoOwner: params.repoOwner, repoName: params.repoName, installationId },
  });
  await writeIntegrationLifecycleEvent(db, {
    integrationId: "github",
    stage: INTEGRATION_LIFECYCLE_STAGE.SANDBOX_TOKEN_PREPARED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: params.businessId,
    userId: Number.isFinite(userIdNumber) ? userIdNumber : null,
    sessionId: params.sessionId,
    message: "GitHub session credentials are ready for sandbox startup.",
    details: { installationId, repoOwner: params.repoOwner, repoName: params.repoName },
  });

  return { ok: true, installationId };
}

export async function getGithubBusinessLifecycleSummary(
  db: D1Database,
  businessId: string,
): Promise<ReturnType<typeof getIntegrationLifecycleSummary>> {
  const summary = await getIntegrationLifecycleSummary(db, { integrationId: "github", businessId });
  if (!summary) return null;
  if (summary.status !== INTEGRATION_LIFECYCLE_STATUS.FAILED) {
    return summary;
  }
  return {
    ...summary,
    message: mapReasonCodeToBusinessMessage("github", summary.reasonCode),
  };
}
