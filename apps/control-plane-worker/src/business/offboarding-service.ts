import { stringifyError } from "../../../../shared/utils/errors.js";
import { disconnectBusinessJiraWorkspace, disconnectBusinessLinearWorkspace } from "../integrations/service";
import type { Logger } from "../logger";
import { deleteS3Objects, listSessionArchiveKeys } from "../services/archive";
import type { SessionOffboardingPurgeRequest, SessionOffboardingPurgeResponse } from "../session/internal-routes";
import { SESSION_BEARER_INTERNAL_ROUTES, SESSION_INTERNAL_ORIGIN } from "../session/internal-routes";
import type { Env } from "../types";
import { mapBounded } from "../utils";
import {
  createOffboardingJobManifest,
  deleteBusinessCascade,
  type OffboardingJob,
  readBusinessOffboardingRows,
  updateOffboardingJobProgress,
} from "./db";
import { exportBusinessOffboardingRows } from "./offboarding-export";

const AUTH_INVALIDATION_BATCH_SIZE = 100;
const SESSION_OFFBOARDING_FANOUT_CONCURRENCY = 5;

export type BusinessOffboardingOptions = {
  businessId: string;
  confirm: boolean;
  now?: number;
};

export type BusinessOffboardingSummary = {
  ok: true;
  dryRun: boolean;
  alreadyActive: boolean;
  job: OffboardingJob;
  archiveKey: string;
  tableCounts: Record<string, number>;
  capturedUserIds: number[];
  capturedSessionIds: string[];
  sessionArtifactKeys: string[];
  externalResults: Record<string, unknown>;
};

export async function offboardBusiness(
  env: Env,
  db: D1Database,
  input: BusinessOffboardingOptions,
  log: Logger,
): Promise<BusinessOffboardingSummary> {
  const manifest = await createOffboardingJobManifest(db, { businessId: input.businessId, now: input.now });
  let job = manifest.job;
  if (input.confirm && !manifest.created) {
    return {
      ok: true,
      dryRun: false,
      alreadyActive: true,
      job,
      archiveKey: job.archiveKey,
      tableCounts: job.tableCounts,
      capturedUserIds: job.capturedUserIds,
      capturedSessionIds: job.capturedSessionIds,
      sessionArtifactKeys: [],
      externalResults: job.externalResults,
    };
  }
  const sessionArtifactKeys = await listBusinessSessionArtifactKeys(env, job.capturedSessionIds, log);
  const tableCounts = await readBusinessOffboardingTableCounts(db, job);

  if (!input.confirm) {
    return {
      ok: true,
      dryRun: true,
      alreadyActive: !manifest.created,
      job,
      archiveKey: job.archiveKey,
      tableCounts,
      capturedUserIds: job.capturedUserIds,
      capturedSessionIds: job.capturedSessionIds,
      sessionArtifactKeys,
      externalResults: {},
    };
  }

  if (job.capturedSessionIds.length > 0 && !env.SANDBOX_RUNTIME_CLEANUP_SECRET) {
    throw new Error("SANDBOX_RUNTIME_CLEANUP_SECRET is required to purge SessionDO state");
  }

  try {
    const exportManifest = await exportBusinessOffboardingRows(env, db, job, sessionArtifactKeys, log, input.now);
    job = await updateOffboardingJobProgress(db, job, {
      phase: "exported",
      stepMarkers: { exported: true },
      tableCounts: exportManifest.tableCounts,
      externalResults: { exportManifest },
      now: input.now,
    });

    const sessionPurgeResults = await purgeBusinessSessionDurableObjects(env, job.capturedSessionIds);
    job = await updateOffboardingJobProgress(db, job, {
      phase: "durable_objects_purged",
      stepMarkers: { durableObjectsPurged: true },
      externalResults: { sessionPurgeResults },
      now: input.now,
    });

    const authInvalidation = await invalidateBusinessAuth(db, job.capturedUserIds, input.now ?? Date.now());
    const [linearDisconnect, jiraDisconnect] = await Promise.allSettled([
      disconnectBusinessLinearWorkspace(db, job.businessId),
      disconnectBusinessJiraWorkspace(env, db, job.businessId),
    ]);
    const externalCleanup = {
      authInvalidation,
      linearDisconnect: settledValue(linearDisconnect),
      jiraDisconnect: settledValue(jiraDisconnect),
    };
    job = await updateOffboardingJobProgress(db, job, {
      phase: "external_cleanup_finished",
      stepMarkers: { externalCleanupFinished: true },
      externalResults: { externalCleanup },
      now: input.now,
    });

    const s3DeleteResult = await deleteS3Objects(env, sessionArtifactKeys, log);
    job = await updateOffboardingJobProgress(db, job, {
      phase: "s3_artifacts_deleted",
      stepMarkers: { s3ArtifactsDeleted: true },
      externalResults: { s3DeleteResult },
      now: input.now,
    });
    // Fail closed: deleteS3Objects reports failures via failedKeys instead of throwing.
    // Aborting before the irreversible DB cascade keeps the business (and its manifest)
    // recoverable for retry rather than orphaning the un-deleted artifacts permanently.
    if (s3DeleteResult.failedKeys.length > 0) {
      throw new Error(
        `S3 artifact deletion failed for ${s3DeleteResult.failedKeys.length} key(s); aborting before DB cascade`,
      );
    }

    const cascade = await deleteBusinessCascade(db, job);
    job = await updateOffboardingJobProgress(db, job, {
      phase: "completed",
      stepMarkers: { dbPurged: true, completed: true },
      tableCounts: cascade.tableCounts,
      externalResults: { dbCascade: cascade },
      completedAt: input.now ?? Date.now(),
      now: input.now,
    });

    return {
      ok: true,
      dryRun: false,
      alreadyActive: false,
      job,
      archiveKey: job.archiveKey,
      tableCounts: job.tableCounts,
      capturedUserIds: job.capturedUserIds,
      capturedSessionIds: job.capturedSessionIds,
      sessionArtifactKeys,
      externalResults: job.externalResults,
    };
  } catch (error) {
    await updateOffboardingJobProgress(db, job, {
      phase: "failed",
      error: { message: stringifyError(error) },
      now: input.now,
    });
    throw error;
  }
}

async function readBusinessOffboardingTableCounts(
  db: D1Database,
  job: OffboardingJob,
): Promise<Record<string, number>> {
  const tableExports = await readBusinessOffboardingRows(db, job);
  return Object.fromEntries(tableExports.map((tableExport) => [tableExport.table, tableExport.rows.length]));
}

async function listBusinessSessionArtifactKeys(env: Env, sessionIds: string[], log: Logger): Promise<string[]> {
  const keys = new Set<string>();
  const keysBySession = await mapBounded(sessionIds, SESSION_OFFBOARDING_FANOUT_CONCURRENCY, (sessionId) =>
    listSessionArchiveKeys(env, sessionId, log),
  );
  for (const sessionKeys of keysBySession) {
    for (const key of sessionKeys) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

async function purgeBusinessSessionDurableObjects(
  env: Env,
  sessionIds: string[],
): Promise<Array<SessionOffboardingPurgeResponse & { sessionId: string }>> {
  const route = SESSION_BEARER_INTERNAL_ROUTES.sessionOffboardingPurge;
  return mapBounded(sessionIds, SESSION_OFFBOARDING_FANOUT_CONCURRENCY, async (sessionId) => {
    const request: SessionOffboardingPurgeRequest = { sessionId };
    const response = await env.SESSION.get(env.SESSION.idFromName(sessionId)).fetch(
      new URL(route.path, SESSION_INTERNAL_ORIGIN).href,
      {
        method: route.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw new Error(
        `SessionDO offboarding purge failed for ${sessionId}: ${response.status} ${await response.text()}`,
      );
    }
    return { ...((await response.json()) as SessionOffboardingPurgeResponse), sessionId };
  });
}

async function invalidateBusinessAuth(
  db: D1Database,
  userIds: number[],
  now: number,
): Promise<{ authSessionsDeleted: number; cliTokensRevoked: number }> {
  let authSessionsDeleted = 0;
  let cliTokensRevoked = 0;
  for (let start = 0; start < userIds.length; start += AUTH_INVALIDATION_BATCH_SIZE) {
    const batch = userIds.slice(start, start + AUTH_INVALIDATION_BATCH_SIZE);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(", ");
    const authResult = await db
      .prepare(`DELETE FROM auth_sessions WHERE user_id IN (${placeholders})`)
      .bind(...batch)
      .run();
    const cliResult = await db
      .prepare(`UPDATE cli_tokens SET revoked_at = ? WHERE user_id IN (${placeholders}) AND revoked_at IS NULL`)
      .bind(now, ...batch)
      .run();
    authSessionsDeleted += authResult.meta?.changes ?? 0;
    cliTokensRevoked += cliResult.meta?.changes ?? 0;
  }
  return { authSessionsDeleted, cliTokensRevoked };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | { error: string } {
  if (result.status === "fulfilled") return result.value;
  return { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
