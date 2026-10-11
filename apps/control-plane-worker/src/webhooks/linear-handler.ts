import {
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { trimUploadedImagesToPromptBudget } from "../../../../shared/utils/uploads.js";
import { getValidLinearToken } from "../auth/db";
import type { Env } from "../types";
import { computeSha256Hex, jsonErrorResponse, jsonResponse, normalizeWebhookReference } from "../utils";
import { readCappedWebhookBody } from "./body-limit";
import {
  claimLinearBootstrapJob,
  claimLinearBootstrapJobLease,
  getLinearBootstrapJob,
  getLinearIssueSessionRef,
  getSessionIdByLinearIssueRef,
  releaseWebhookIdempotencyClaim,
  revokeLinearWebhookInstallation,
  updateLinearBootstrapJobUploadedImages,
} from "./db";
import { fetchLinearIssueImages } from "./linear";
import { LINEAR_BOOTSTRAP_LEASE_MS, runLinearBootstrapJobPhases } from "./linear-bootstrap";
import { parseLinearLabelNames } from "./prompts";
import {
  authorizeLinearWebhookRepo,
  buildLinearBootstrapPrompt,
  claimOrSkip,
  displaceStaleLinearSessionRef,
  emitLifecycleEvent,
  isAcceptableLinearWebhookTimestamp,
  isDisplaceableLinearSessionRef,
  isLinearOAuthRevocationEvent,
  isRecentLinearWebhookTimestamp,
  log,
  notifyLinearWebhookSkip,
  recordLinearWebhookDrop,
  resolveLinearIssueActorContext,
  resolveLinearWebhookRepo,
  resolveLinearWebhookTenantContext,
  WEBHOOK_SOURCE_LINEAR,
} from "./shared";
import { verifyLinearWebhookSignature } from "./verify";

// Skip reasons caused by transient dependency failures rather than user
// configuration. These release the idempotency claim and return 503 so
// Linear's redelivery schedule (+1m/+1h/+6h) retries them; everything else is
// user-actionable and stays a 200 skip so retries don't spam notifications.
// repo_inference_unavailable stays permanent on purpose: the resolver already
// posts a clarification comment asking the user to specify the repo, and a
// retried delivery would post it again.
const TRANSIENT_LINEAR_SKIP_REASONS = new Set(["repo_access_verification_failed"]);

// Actor-resolution skip reasons whose D1 lifecycle event is already written
// inside resolveLinearIssueActorContext; the handler adds only the Datadog
// drop signal for these. integration_disabled is deliberately absent — the
// resolver does not record it.
const ACTOR_SKIP_REASONS_WITH_RESOLVER_LIFECYCLE = new Set([
  "non_user_actor",
  "linear_user_not_connected",
  "linear_actor_business_mismatch",
]);

const REQUIRED_LINEAR_LABEL = "cycloid";

export async function handleLinearWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const signature = request.headers.get("linear-signature");
  if (!signature) {
    return jsonErrorResponse("Missing signature", 401);
  }

  const bodyResult = await readCappedWebhookBody(request);
  if (bodyResult instanceof Response) return bodyResult;
  const rawBody = bodyResult;
  const valid = await verifyLinearWebhookSignature(rawBody, signature, env.LINEAR_WEBHOOK_SECRET || "");
  if (!valid) {
    return jsonErrorResponse("Invalid signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonErrorResponse("Invalid JSON", 400);
  }

  const db = env.DB;
  const linearDeliveryId = request.headers.get("linear-delivery");
  const isOAuthRevocation = isLinearOAuthRevocationEvent(payload);
  // Evaluate both timestamp gates against a single `now` so a webhook near a
  // window boundary cannot pass one check and fail the other on ms drift.
  const now = Date.now();
  // Strict 60s check, kept solely for the OAuth-revocation unbound-binding
  // gate below; issue webhooks use the wide retry-friendly window.
  const hasRecentTimestamp = isRecentLinearWebhookTimestamp(payload.webhookTimestamp, now);
  if (!isOAuthRevocation && !isAcceptableLinearWebhookTimestamp(payload.webhookTimestamp, now)) {
    log.warn({ webhookTimestamp: payload.webhookTimestamp }, "Linear webhook rejected: stale or missing timestamp");
    recordLinearWebhookDrop({
      env,
      db,
      ctx,
      fields: { reason: "webhook_timestamp_rejected", deliveryId: linearDeliveryId },
    });
    return jsonErrorResponse("Invalid timestamp", 401);
  }

  const payloadHash = await computeSha256Hex(rawBody);
  // Idempotency is keyed on the signed payload hash, NOT the linear-delivery
  // header: the header is not covered by the HMAC, so keying on it would let a
  // replayed signed body bypass dedupe by changing the header. A redelivery
  // carries a byte-identical body (same webhookTimestamp), so it maps to the
  // same key.
  const { duplicate, idempotencyKey } = await claimOrSkip(db, WEBHOOK_SOURCE_LINEAR, null, payloadHash);
  if (duplicate) return duplicate;

  // Frees the payload-hash claim so a Linear redelivery of this exact body is
  // processed instead of skipped as duplicate. Call on every retryable
  // failure path; best-effort, never masks the original failure.
  const releaseIdempotencyClaim = async (context: string): Promise<void> => {
    try {
      await releaseWebhookIdempotencyClaim(db, WEBHOOK_SOURCE_LINEAR, idempotencyKey);
    } catch (releaseErr) {
      log.error(
        { idempotencyKey, context, error: String(releaseErr) },
        "Failed to release Linear webhook idempotency claim; redelivery will be deduped until the claim TTL expires",
      );
    }
  };

  try {
    return await processLinearWebhook({
      env,
      db,
      ctx,
      payload,
      payloadHash,
      linearDeliveryId,
      isOAuthRevocation,
      hasRecentTimestamp,
      releaseIdempotencyClaim,
    });
  } catch (err) {
    // Any escaped error becomes a 5xx; free the dedupe claim here — after all
    // inner cleanup, so a cleanup failure can never strand the claim — and
    // Linear's redelivery reprocesses instead of skipping as duplicate.
    await releaseIdempotencyClaim("handler_error");
    throw err;
  }
}

async function processLinearWebhook(params: {
  env: Env;
  db: D1Database;
  ctx?: ExecutionContext;
  payload: Record<string, unknown>;
  payloadHash: string;
  linearDeliveryId: string | null;
  isOAuthRevocation: boolean;
  hasRecentTimestamp: boolean;
  releaseIdempotencyClaim: (context: string) => Promise<void>;
}): Promise<Response> {
  const {
    env,
    db,
    ctx,
    payload,
    payloadHash,
    linearDeliveryId,
    isOAuthRevocation,
    hasRecentTimestamp,
    releaseIdempotencyClaim,
  } = params;

  const tenantResult = await resolveLinearWebhookTenantContext(db, payload, {
    allowUnboundWebhookBinding: !isOAuthRevocation || hasRecentTimestamp,
  });
  if (tenantResult.status === "skipped") {
    recordLinearWebhookDrop({
      env,
      db,
      ctx,
      fields: {
        reason: tenantResult.reason,
        deliveryId: linearDeliveryId,
        payloadHash,
        workspaceId: normalizeWebhookReference(payload.organizationId),
      },
    });
    return tenantResult.response;
  }
  const tenant = tenantResult.context;

  await emitLifecycleEvent({
    db,
    integrationId: "linear",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_VERIFIED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: tenant.linearInstallation.businessId,
    message: "Linear webhook signature and tenant context verified.",
    details: {
      provider: "linear",
      webhookDeliveryId: linearDeliveryId,
      workspaceId: tenant.linearOrganizationId,
    },
  });

  if (isOAuthRevocation) {
    await revokeLinearWebhookInstallation(db, tenant.linearOrganizationId, tenant.linearWebhookId);
    return jsonResponse({ ok: true, revoked: true });
  }

  const issue = payload?.data as Record<string, unknown> | undefined;
  if (payload?.type !== "Issue" || !issue || typeof issue !== "object") {
    return jsonResponse({ ok: true, skipped: true });
  }

  const linearIssueId = normalizeWebhookReference(issue.id);
  if (!linearIssueId) {
    recordLinearWebhookDrop({
      env,
      db,
      ctx,
      fields: {
        reason: "missing_issue_id",
        deliveryId: linearDeliveryId,
        payloadHash,
        workspaceId: tenant.linearOrganizationId,
        businessId: tenant.linearInstallation.businessId,
      },
    });
    return jsonResponse({ ok: true, skipped: true, reason: "missing_issue_id" });
  }

  const labels = parseLinearLabelNames(issue.labels);
  const hasTriggerLabel = labels.some((label) => label.toLowerCase() === REQUIRED_LINEAR_LABEL);
  if (!hasTriggerLabel) {
    return jsonResponse({ ok: true, skipped: true, reason: "trigger_label_missing" });
  }

  const existingRef = await getLinearIssueSessionRef(db, linearIssueId);
  if (existingRef) {
    // A ref normally dedupes the issue for good. Displace it only when it
    // provably points at a dead session (a leaked claim from a failed
    // bootstrap) so a label re-add can recover the issue.
    const displaceable = await isDisplaceableLinearSessionRef(db, existingRef);
    if (!displaceable) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "session_already_exists",
        sessionId: existingRef.sessionId,
      });
    }
    const displaced = await displaceStaleLinearSessionRef({ env, db, ctx, linearIssueId, ref: existingRef });
    if (!displaced) {
      // A concurrent delivery displaced first; defer to whatever it claimed.
      // If its claim has not landed yet, report claim-lost (non-2xx so Linear
      // redelivers) instead of echoing the known-dead session id.
      const claimedSessionId = await getSessionIdByLinearIssueRef(db, linearIssueId);
      if (!claimedSessionId) {
        log.warn({ linearIssueId }, "Stale Linear ref displaced concurrently without a winner yet");
        recordLinearWebhookDrop({
          env,
          db,
          ctx,
          fields: {
            reason: "session_claim_lost",
            status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
            deliveryId: linearDeliveryId,
            payloadHash,
            workspaceId: tenant.linearOrganizationId,
            businessId: tenant.linearInstallation.businessId,
            linearIssueId,
          },
        });
        return jsonResponse({ ok: false, error: "session_claim_lost" }, 503);
      }
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "session_already_exists",
        sessionId: claimedSessionId,
      });
    }
  }

  const actorResult = await resolveLinearIssueActorContext({ db, payload, tenant });
  if (actorResult.status === "skipped") {
    // The resolver writes its own lifecycle events for actor-resolution
    // failures, so those get the Datadog-queryable drop signal only;
    // integration_disabled has no resolver-side event and gets both.
    recordLinearWebhookDrop({
      env,
      db,
      ctx,
      fields: {
        reason: actorResult.reason,
        emitLifecycle: !ACTOR_SKIP_REASONS_WITH_RESOLVER_LIFECYCLE.has(actorResult.reason),
        deliveryId: linearDeliveryId,
        payloadHash,
        workspaceId: tenant.linearOrganizationId,
        businessId: tenant.linearInstallation.businessId,
        linearIssueId,
      },
    });
    return actorResult.response;
  }
  const actorContext = actorResult.context;

  await emitLifecycleEvent({
    db,
    integrationId: "linear",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_CONTEXT_RESOLVED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: tenant.linearInstallation.businessId,
    userId: actorContext.actorUserId,
    message: "Linear webhook resolved the tenant and actor context.",
    details: {
      provider: "linear",
      workspaceId: tenant.linearOrganizationId,
      actor: normalizeWebhookReference((payload.actor as Record<string, unknown> | undefined)?.id),
    },
  });

  const notifySkip = (reason: string, repo?: { repoOwner: string; repoName: string }): Promise<void> =>
    notifyLinearWebhookSkip({
      env,
      db,
      ctx,
      businessId: tenant.linearInstallation.businessId,
      actorUserId: actorContext.actorUserId,
      linearIssueId,
      reason,
      repoOwner: repo?.repoOwner,
      repoName: repo?.repoName,
      deliveryId: linearDeliveryId,
      payloadHash,
      workspaceId: tenant.linearOrganizationId,
    });

  // Repo resolve + authorize run BEFORE the claim (ARC-1051, B1) so the durable
  // bootstrap job can carry repo_owner/repo_name/installation_id atomically.
  // These gates are read-only and fail-closed, so running them pre-claim is
  // safe and re-runs cheaply on redelivery.
  const repoResult = await resolveLinearWebhookRepo({
    env,
    db,
    ctx,
    actorUserId: actorContext.actorUserId,
    issue,
    labels,
    triggerLabel: REQUIRED_LINEAR_LABEL,
    linearIssueId,
  });
  if (repoResult.status === "skipped") {
    await notifySkip(repoResult.reason);
    return repoResult.response;
  }
  const repo = repoResult.repo;

  const authorizationResult = await authorizeLinearWebhookRepo({
    env,
    db,
    actorUserId: actorContext.actorUserId,
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoFromDescription: repo.repoFromDescription,
  });
  if (authorizationResult.status === "skipped") {
    if (TRANSIENT_LINEAR_SKIP_REASONS.has(authorizationResult.reason)) {
      // Transient dependency failure: skip the user notification (a retry may
      // succeed silently) and ask Linear to redeliver.
      await releaseIdempotencyClaim(authorizationResult.reason);
      recordLinearWebhookDrop({
        env,
        db,
        ctx,
        fields: {
          reason: authorizationResult.reason,
          deliveryId: linearDeliveryId,
          payloadHash,
          workspaceId: tenant.linearOrganizationId,
          businessId: tenant.linearInstallation.businessId,
          userId: actorContext.actorUserId,
          linearIssueId,
        },
      });
      return jsonResponse({ ok: false, error: authorizationResult.reason }, 503);
    }
    await notifySkip(authorizationResult.reason, repo);
    return authorizationResult.response;
  }

  // Build the bootstrap prompt now so it is stored verbatim on the job and
  // replayed byte-for-byte on resume (keeps the prompt dedup stable).
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const promptTemplate = await buildLinearBootstrapPrompt({
    env,
    db,
    actorUserId: actorContext.actorUserId,
    linearIssueId,
    sessionId,
    issue,
    labels,
    repo,
  });
  const issueSnapshot = JSON.stringify({ issue });

  // Atomically claim the issue ref + durable bootstrap job. Initial
  // retry_after_ms = now + lease so the 5-minute sweep cannot steal a job the
  // in-request driver is still running (B9).
  const claimed = await claimLinearBootstrapJob(db, {
    linearIssueId,
    sessionId,
    businessId: tenant.linearInstallation.businessId,
    actorUserId: actorContext.actorUserId,
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    installationId: authorizationResult.authorization.installationId,
    model: repo.linearDefaultModel,
    promptTemplate,
    issueSnapshot,
    uploadedImages: [],
    retryAfterMs: now + LINEAR_BOOTSTRAP_LEASE_MS,
    nowMs: now,
  });
  if (!claimed) {
    const claimedSessionId = await getSessionIdByLinearIssueRef(db, linearIssueId);
    if (!claimedSessionId) {
      log.warn({ linearIssueId, attemptedSessionId: sessionId }, "Linear issue session claim lost without winner");
      await releaseIdempotencyClaim("session_claim_lost");
      recordLinearWebhookDrop({
        env,
        db,
        ctx,
        fields: {
          reason: "session_claim_lost",
          status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
          deliveryId: linearDeliveryId,
          payloadHash,
          workspaceId: tenant.linearOrganizationId,
          businessId: tenant.linearInstallation.businessId,
          userId: actorContext.actorUserId,
          linearIssueId,
        },
      });
      return jsonResponse({ ok: false, error: "session_claim_lost" }, 503);
    }
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: "session_already_exists",
      sessionId: claimedSessionId,
    });
  }

  try {
    const linearToken = await getValidLinearToken(db, actorContext.actorUserId, env);
    if (linearToken) {
      const uploadedImageBudget = trimUploadedImagesToPromptBudget({
        promptText: promptTemplate,
        uploadedImages: await fetchLinearIssueImages(linearToken, linearIssueId),
      });
      if (uploadedImageBudget.droppedCount > 0) {
        log.warn(
          {
            event: "linear_attachment_skipped",
            reason: "payload_budget",
            linearIssueId,
            droppedCount: uploadedImageBudget.droppedCount,
          },
          "Skipped Linear image attachment",
        );
      }
      await updateLinearBootstrapJobUploadedImages(db, linearIssueId, uploadedImageBudget.uploadedImages, Date.now());
    }
  } catch (err) {
    log.warn({ linearIssueId, error: String(err) }, "Linear image fetch skipped after bootstrap job claim");
  }

  // Drive the durable phase machine in-request through prompt_enqueue. The
  // link-back (the slow Linear call) runs out of band so the 2xx does not block
  // on it; a crash or transient failure is recovered by the cron sweep. Repo
  // authorization just ran, so skip the redundant re-auth probe in phase 1.
  await claimLinearBootstrapJobLease(db, linearIssueId, now, now + LINEAR_BOOTSTRAP_LEASE_MS);
  const job = await getLinearBootstrapJob(db, linearIssueId);
  const outcome = job
    ? await runLinearBootstrapJobPhases(env, job, now, { ctx, alreadyAuthorized: true, stopBeforeLink: true })
    : ({ status: "noop" } as const);

  // Finish the link-back + completion out of band so the 2xx does not block on
  // the Linear call. Created eagerly (so it runs even without an execution
  // context, e.g. in tests) and registered with `ctx.waitUntil` when present so
  // the worker stays alive for it. Re-fetch so we only run the tail when the
  // synchronous part reached prompt_enqueued; otherwise the sweep (which takes a
  // fresh lease) owns recovery.
  const linkTail = (async () => {
    const latest = await getLinearBootstrapJob(db, linearIssueId);
    if (latest && !latest.terminalOutcome && latest.phase === "prompt_enqueued") {
      await runLinearBootstrapJobPhases(env, latest, Date.now(), {});
    }
  })().catch((err) => {
    log.error({ linearIssueId, error: String(err) }, "Linear bootstrap link tail failed");
  });
  if (ctx) ctx.waitUntil(linkTail);

  if (outcome.status === "rescheduled") {
    // Synchronous bootstrap hit a transient failure before enqueue; the durable
    // job is pending and the sweep owns recovery. Keep the idempotency claim
    // (a redelivery would only hit the lost-claim path).
    return jsonResponse({
      ok: true,
      created: true,
      sessionId,
      linearIssueId,
      enqueued: false,
      pending: true,
      reason: outcome.reason,
      repoSource: repo.repoResolutionSource,
    });
  }
  if (outcome.status === "failed") {
    return jsonResponse({ ok: true, skipped: true, reason: outcome.reason, sessionId, linearIssueId });
  }
  return jsonResponse({
    ok: true,
    created: true,
    sessionId,
    linearIssueId,
    enqueued: true,
    repoSource: repo.repoResolutionSource,
  });
}
