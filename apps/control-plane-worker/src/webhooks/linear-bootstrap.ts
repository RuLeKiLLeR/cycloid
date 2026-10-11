/**
 * Durable, resumable runner for Linear-webhook session bootstrap (ARC-1051).
 *
 * Mirrors the scheduled-automation phase machine (`automation/scheduler.ts`).
 * A `linear_webhook_bootstrap_jobs` row checkpoints each step; on crash or
 * transient failure the row is left non-terminal and the existing 5-minute
 * cron sweep (`linearBootstrapSweepTick`) resumes it. The webhook handler
 * drives the same runner synchronously in-request through `prompt_enqueued`,
 * then completes the link-back via `ctx.waitUntil` / sweep so the 2xx response
 * never blocks on the Linear attachment call.
 *
 * Phases: linear_issue_claimed -> gate_revalidated -> session_projected ->
 * prompt_enqueued -> linked -> picked_up -> (terminal_outcome = "completed").
 */
import {
  INTEGRATION_LIFECYCLE_STAGE,
  INTEGRATION_LIFECYCLE_STATUS,
} from "../../../../shared/enums/integration-lifecycle.js";
import { trimUploadedImagesToPromptBudget } from "../../../../shared/utils/uploads.js";
import { getValidLinearToken } from "../auth/db";
import { createLogger } from "../logger";
import { isOpencodeAccessDeniedError, OPENCODE_ACCESS_DENIED_ERROR } from "../services/opencode-access-gate";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import { getSessionLivenessRows } from "../session/db";
import { closeSessionForWebhook, enqueueSessionPrompt, listSessionPrompts } from "../session/state";
import type { Env, InternalAuthContext } from "../types";
import {
  claimLinearBootstrapJobLease,
  getLinearBootstrapJob,
  type LinearBootstrapJob,
  listDueLinearBootstrapJobs,
  markLinearBootstrapJobTerminal,
  rescheduleLinearBootstrapJob,
  updateLinearBootstrapJobPhase,
} from "./db";
import {
  fetchLinearIssuePickupContext,
  findLinearAttachmentExternalIdByUrl,
  type LinearMutationResult,
  linearSessionAttachmentUrl,
  linkSessionToLinearIssue,
  pickupCommentBody,
  postLinearIssueComment,
  selectLinearIssuePickupUpdate,
  updateLinearIssueForPickup,
} from "./linear";
import { authorizeLinearWebhookRepo, createAndPersistLinearWebhookSession, emitLifecycleEvent } from "./shared";

const log = createLogger({ bindings: { component: "linear-bootstrap" } });

/** Lease window. Both the in-request driver and the sweep hold it so they
 * never run the same job concurrently. The initial `retry_after_ms` at claim
 * time is set to `now + LEASE_MS` so the sweep cannot steal an in-flight job. */
export const LINEAR_BOOTSTRAP_LEASE_MS = 10 * 60 * 1000;

/** Max transient retries before terminal-failing, so a persistently-failing
 * dependency cannot accrue zombie in-flight jobs forever (S9). */
export const MAX_LINEAR_BOOTSTRAP_ATTEMPTS = 5;

/** Per-tick budget for the recovery sweep. */
export const LINEAR_BOOTSTRAP_PER_TICK_BUDGET = 50;

/** Exponential backoff for transient retries (base, doubled per attempt, capped).
 * Without it `retry_after_ms = now` makes a job eligible on the very next sweep
 * tick, so a sustained dependency outage burns the whole attempt budget in a few
 * sweep periods. Mirrors the scheduler's "reschedule to a future time" approach. */
export const LINEAR_BOOTSTRAP_RETRY_BASE_MS = 5 * 60 * 1000;
export const LINEAR_BOOTSTRAP_RETRY_CAP_MS = 60 * 60 * 1000;

/** Authorize skip reason that is a transient dependency failure (mirrors the
 * handler's TRANSIENT_LINEAR_SKIP_REASONS); everything else is durable. */
const TRANSIENT_AUTH_SKIP_REASON = "repo_access_verification_failed";

export type RunLinearBootstrapOptions = {
  ctx?: ExecutionContext;
  /** In-request path only: repo authorization just ran before the claim, so
   * skip the redundant re-authorization probe in phase 1. The sweep always
   * re-authorizes (B4). */
  alreadyAuthorized?: boolean;
  /** In-request path only: stop after `prompt_enqueued` so the 2xx response
   * does not block on the Linear link-back; the caller finishes `linked` via
   * `ctx.waitUntil` / sweep. */
  stopBeforeLink?: boolean;
};

export type LinearBootstrapRunOutcome =
  | { status: "completed" }
  | { status: "paused_before_link" }
  | { status: "rescheduled"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "noop" };

function parseIssueSnapshot(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const issue = (parsed as Record<string, unknown>).issue;
    return issue && typeof issue === "object" ? (issue as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reschedule a transient failure for the next sweep, or terminal-fail once the
 * attempt budget is exhausted. When the session already exists, terminal close
 * it so an exhausted job does not leave a promptless zombie session.
 */
async function rescheduleOrExhaust(
  env: Env,
  job: LinearBootstrapJob,
  now: number,
  reason: string,
  sessionLive: boolean,
): Promise<LinearBootstrapRunOutcome> {
  const db = env.DB;
  if (job.attemptCount + 1 >= MAX_LINEAR_BOOTSTRAP_ATTEMPTS) {
    await markLinearBootstrapJobTerminal(db, job.linearIssueId, "failed", now, `${reason}_exhausted`);
    if (sessionLive) {
      await closeSessionForWebhook(env, db, job.sessionId, { reason: "linear_bootstrap_failed" });
    }
    log.warn(
      {
        linearIssueId: job.linearIssueId,
        sessionId: job.sessionId,
        phase: job.phase,
        reason,
        attemptCount: job.attemptCount,
      },
      "linear_bootstrap_job_exhausted",
    );
    return { status: "failed", reason: `${reason}_exhausted` };
  }
  const backoffMs = Math.min(LINEAR_BOOTSTRAP_RETRY_BASE_MS * 2 ** job.attemptCount, LINEAR_BOOTSTRAP_RETRY_CAP_MS);
  await rescheduleLinearBootstrapJob(db, job.linearIssueId, now + backoffMs, now, reason);
  log.info(
    {
      linearIssueId: job.linearIssueId,
      sessionId: job.sessionId,
      phase: job.phase,
      reason,
      attemptCount: job.attemptCount,
      backoffMs,
    },
    "linear_bootstrap_job_rescheduled",
  );
  return { status: "rescheduled", reason };
}

async function terminalFail(
  env: Env,
  job: LinearBootstrapJob,
  now: number,
  reason: string,
  sessionLive: boolean,
): Promise<LinearBootstrapRunOutcome> {
  const db = env.DB;
  await markLinearBootstrapJobTerminal(db, job.linearIssueId, "failed", now, reason);
  if (sessionLive) {
    await closeSessionForWebhook(env, db, job.sessionId, { reason: "linear_bootstrap_failed" });
  }
  log.warn(
    { linearIssueId: job.linearIssueId, sessionId: job.sessionId, phase: job.phase, reason },
    "linear_bootstrap_job_failed_durable",
  );
  return { status: "failed", reason };
}

type LinkBackResult =
  | { status: "linked"; externalId: string | null }
  | { status: "transient"; reason: string }
  | { status: "durable"; reason: string };

type PickupResult =
  { status: "picked_up" } | { status: "transient"; reason: string } | { status: "durable"; reason: string };

/**
 * Idempotent link-back. If the external id is already stored, skip. Otherwise
 * query the issue's attachments for the deterministic session URL (recovery
 * for the crash window between Linear accepting the post and D1 persisting the
 * id, B7); only post when none exists.
 */
async function performLinkBack(env: Env, job: LinearBootstrapJob): Promise<LinkBackResult> {
  if (job.linearAttachmentExternalId) {
    return { status: "linked", externalId: job.linearAttachmentExternalId };
  }
  const db = env.DB;
  const token = await getValidLinearToken(db, job.actorUserId, env);
  // No token => the actor disconnected Linear or never connected: durable, not
  // worth retrying.
  if (!token) return { status: "durable", reason: "linear_token_unavailable" };

  const frontendUrl = resolvePublicAppBaseUrl(env);
  const attachmentUrl = linearSessionAttachmentUrl(frontendUrl, job.sessionId);

  let existingId: string | null;
  try {
    existingId = await findLinearAttachmentExternalIdByUrl(token, job.linearIssueId, attachmentUrl);
  } catch (err) {
    log.warn({ linearIssueId: job.linearIssueId, error: String(err) }, "linear_bootstrap_attachment_lookup_failed");
    return { status: "transient", reason: "attachment_lookup_failed" };
  }
  if (existingId) return { status: "linked", externalId: existingId };

  let result: LinearMutationResult;
  try {
    result = await linkSessionToLinearIssue(
      token,
      job.linearIssueId,
      job.sessionId,
      frontendUrl,
      `${job.repoOwner}/${job.repoName}`,
    );
  } catch (err) {
    log.warn({ linearIssueId: job.linearIssueId, error: String(err) }, "linear_bootstrap_attachment_create_threw");
    return { status: "transient", reason: "attachment_create_threw" };
  }
  // The mutation helper collapses 4xx/5xx into success=false. We treat post
  // failures as transient; the attempt-count bound prevents infinite retries.
  if (!result.success) return { status: "transient", reason: "attachment_create_failed" };
  return { status: "linked", externalId: result.externalId };
}

async function performPickup(env: Env, job: LinearBootstrapJob): Promise<PickupResult> {
  const token = await getValidLinearToken(env.DB, job.actorUserId, env);
  if (!token) return { status: "durable", reason: "linear_token_unavailable" };
  const sessionUrl = linearSessionAttachmentUrl(resolvePublicAppBaseUrl(env), job.sessionId);
  let context;
  try {
    context = await fetchLinearIssuePickupContext(token, job.linearIssueId);
  } catch (err) {
    log.warn({ linearIssueId: job.linearIssueId, error: String(err) }, "linear_bootstrap_pickup_context_failed");
    return { status: "transient", reason: "pickup_context_failed" };
  }

  const update = selectLinearIssuePickupUpdate(context);
  if (!update.stateId && context.issue.state && ["triage", "backlog", "unstarted"].includes(context.issue.state.type)) {
    log.warn({ linearIssueId: job.linearIssueId }, "linear_bootstrap_pickup_started_state_missing");
  }
  if (update.stateId || update.assigneeId) {
    try {
      const result = await updateLinearIssueForPickup(token, job.linearIssueId, update);
      if (!result.success) {
        log.warn({ linearIssueId: job.linearIssueId }, "linear_bootstrap_pickup_issue_update_failed");
        return { status: "transient", reason: "pickup_issue_update_failed" };
      }
    } catch (err) {
      log.warn({ linearIssueId: job.linearIssueId, error: String(err) }, "linear_bootstrap_pickup_issue_update_threw");
      return { status: "transient", reason: "pickup_issue_update_threw" };
    }
  }

  if (context.issue.commentBodies.some((body) => body.includes(sessionUrl))) return { status: "picked_up" };
  try {
    const result = await postLinearIssueComment(token, job.linearIssueId, pickupCommentBody(sessionUrl));
    if (!result.success) return { status: "transient", reason: "pickup_comment_failed" };
  } catch (err) {
    log.warn({ linearIssueId: job.linearIssueId, error: String(err) }, "linear_bootstrap_pickup_comment_threw");
    return { status: "transient", reason: "pickup_comment_threw" };
  }
  return { status: "picked_up" };
}

/**
 * Advance the bootstrap job from its current phase, running only the remaining
 * steps. Each phase advance is phase-conditional in D1, so a lease-overrun
 * double-runner cannot skip a phase or re-run a non-idempotent step.
 */
export async function runLinearBootstrapJobPhases(
  env: Env,
  initial: LinearBootstrapJob,
  now: number,
  options: RunLinearBootstrapOptions = {},
): Promise<LinearBootstrapRunOutcome> {
  const db = env.DB;
  let job = initial;

  // Phase 1: linear_issue_claimed -> gate_revalidated (re-authorize on sweep).
  if (job.phase === "linear_issue_claimed") {
    let installationId = job.installationId;
    if (!options.alreadyAuthorized) {
      const auth = await authorizeLinearWebhookRepo({
        env,
        db,
        actorUserId: job.actorUserId,
        repoOwner: job.repoOwner,
        repoName: job.repoName,
        repoFromDescription: false,
      });
      if (auth.status === "skipped") {
        if (auth.reason === TRANSIENT_AUTH_SKIP_REASON) {
          return rescheduleOrExhaust(env, job, now, `gate_${auth.reason}`, false);
        }
        return terminalFail(env, job, now, `gate_${auth.reason}`, false);
      }
      installationId = auth.authorization.installationId;
    }
    const advanced = await updateLinearBootstrapJobPhase(
      db,
      job.linearIssueId,
      "linear_issue_claimed",
      "gate_revalidated",
      now,
      { installationId },
    );
    if (!advanced) return { status: "noop" };
    job = { ...job, phase: "gate_revalidated", installationId };
  }

  // Phase 2: gate_revalidated -> session_projected (idempotent create).
  if (job.phase === "gate_revalidated") {
    const issue = parseIssueSnapshot(job.issueSnapshot);
    if (!issue) return terminalFail(env, job, now, "issue_snapshot_unparseable", false);

    const liveness = await getSessionLivenessRows(db, [job.sessionId]);
    if (liveness.length === 0) {
      try {
        await createAndPersistLinearWebhookSession({
          env,
          db,
          sessionId: job.sessionId,
          actorUserId: job.actorUserId,
          linearIssueId: job.linearIssueId,
          issue,
          repoOwner: job.repoOwner,
          repoName: job.repoName,
          installationId: job.installationId,
          model: job.model,
          waitUntil: options.ctx ? options.ctx.waitUntil.bind(options.ctx) : undefined,
        });
      } catch (err) {
        if (isOpencodeAccessDeniedError(err)) {
          return terminalFail(env, job, now, OPENCODE_ACCESS_DENIED_ERROR, false);
        }
        // No next slot for a Linear issue, so transient D1/DO/projection errors
        // are retried, not terminal (B6).
        log.warn(
          { linearIssueId: job.linearIssueId, sessionId: job.sessionId, error: String(err) },
          "linear_bootstrap_session_create_failed",
        );
        return rescheduleOrExhaust(env, job, now, "session_create_failed", false);
      }
    }
    const advanced = await updateLinearBootstrapJobPhase(
      db,
      job.linearIssueId,
      "gate_revalidated",
      "session_projected",
      now,
    );
    if (!advanced) return { status: "noop" };
    job = { ...job, phase: "session_projected" };
  }

  // Phase 3: session_projected -> prompt_enqueued (dedup enqueue).
  if (job.phase === "session_projected") {
    const auth: InternalAuthContext = {
      userId: job.actorUserId,
      canAccessAllSessions: false,
      businessId: job.businessId,
    };
    const alreadyEnqueued = await hasMatchingBootstrapPrompt(env, job, auth);
    if (!alreadyEnqueued) {
      const uploadedImageBudget = trimUploadedImagesToPromptBudget({
        promptText: job.promptTemplate,
        uploadedImages: job.uploadedImages,
      });
      if (uploadedImageBudget.droppedCount > 0) {
        log.warn(
          {
            event: "linear_attachment_skipped",
            reason: "payload_budget",
            linearIssueId: job.linearIssueId,
            droppedCount: uploadedImageBudget.droppedCount,
          },
          "Skipped Linear image attachment",
        );
      }
      const enqueue = await enqueueSessionPrompt(env, job.sessionId, job.promptTemplate, job.actorUserId, {
        auth,
        uploadedImages: uploadedImageBudget.uploadedImages,
      });
      if (!enqueue.ok) {
        return rescheduleOrExhaust(env, job, now, `prompt_enqueue_${enqueue.status}`, true);
      }
    }
    const advanced = await updateLinearBootstrapJobPhase(
      db,
      job.linearIssueId,
      "session_projected",
      "prompt_enqueued",
      now,
    );
    if (!advanced) return { status: "noop" };
    job = { ...job, phase: "prompt_enqueued" };
    // The session is live and the prompt is durably enqueued. Emit the followup
    // lifecycle event now -- exactly once, gated by the phase-conditional advance
    // above (S11) -- so it fires independent of the decorative link-back outcome.
    // A durable link-back failure (e.g. the actor disconnected Linear) must not
    // suppress it; this also matches the pre-ARC-1051 behavior of emitting right
    // after enqueue rather than after the Linear attachment is posted.
    await emitFollowupLifecycle(env, job);
  }

  // In-request path stops here: the prompt is durably enqueued and the session
  // is live, so we return 2xx and complete link-back out of band.
  if (options.stopBeforeLink) return { status: "paused_before_link" };

  // Phase 4: prompt_enqueued -> linked (idempotent link-back + recovery query).
  if (job.phase === "prompt_enqueued") {
    const link = await performLinkBack(env, job);
    if (link.status === "transient") {
      return rescheduleOrExhaust(env, job, now, `link_${link.reason}`, true);
    }
    if (link.status === "durable") {
      // The session + prompt are live; only the decorative link failed durably.
      // Terminal-fail the job (no infinite retry) but leave the session running.
      await markLinearBootstrapJobTerminal(db, job.linearIssueId, "failed", now, `link_${link.reason}`);
      log.warn(
        { linearIssueId: job.linearIssueId, sessionId: job.sessionId, reason: link.reason },
        "linear_bootstrap_link_failed_durable",
      );
      return { status: "failed", reason: `link_${link.reason}` };
    }
    const advanced = await updateLinearBootstrapJobPhase(db, job.linearIssueId, "prompt_enqueued", "linked", now, {
      attachmentExternalId: link.externalId,
    });
    if (!advanced) return { status: "noop" };
    job = { ...job, phase: "linked", linearAttachmentExternalId: link.externalId };
  }

  // Phase 5: linked -> picked_up.
  if (job.phase === "linked") {
    const pickup = await performPickup(env, job);
    if (pickup.status === "transient") {
      return rescheduleOrExhaust(env, job, now, `pickup_${pickup.reason}`, false);
    }
    if (pickup.status === "durable") {
      return terminalFail(env, job, now, `pickup_${pickup.reason}`, false);
    }
    const advanced = await updateLinearBootstrapJobPhase(db, job.linearIssueId, "linked", "picked_up", now);
    if (!advanced) return { status: "noop" };
    job = { ...job, phase: "picked_up" };
  }

  // Phase 6: picked_up -> completed.
  if (job.phase === "picked_up") {
    await markLinearBootstrapJobTerminal(db, job.linearIssueId, "completed", now);
    log.info({ linearIssueId: job.linearIssueId, sessionId: job.sessionId }, "linear_bootstrap_job_completed");
    return { status: "completed" };
  }

  return { status: "noop" };
}

async function hasMatchingBootstrapPrompt(
  env: Env,
  job: LinearBootstrapJob,
  auth: InternalAuthContext,
): Promise<boolean> {
  const prompts = await listSessionPrompts(env, job.sessionId, { auth });
  if (!prompts.ok || !prompts.payload) return false;
  return prompts.payload.prompts.some(
    (prompt) => prompt.prompt === job.promptTemplate && prompt.actorUserId === job.actorUserId,
  );
}

async function emitFollowupLifecycle(env: Env, job: LinearBootstrapJob): Promise<void> {
  // emitLifecycleEvent never throws (it logs internally).
  await emitLifecycleEvent({
    db: env.DB,
    integrationId: "linear",
    stage: INTEGRATION_LIFECYCLE_STAGE.WEBHOOK_FOLLOWUP_ENQUEUED,
    status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
    businessId: job.businessId,
    userId: job.actorUserId,
    sessionId: job.sessionId,
    message: "Linear webhook created a session and enqueued the bootstrap prompt.",
    details: { provider: "linear", eventKind: "issue_bootstrap" },
  });
}

/**
 * Sweep path: claim the lease, re-fetch the latest job, run remaining phases.
 * Mirrors `processSlotJob`.
 */
async function processLinearBootstrapJob(env: Env, job: LinearBootstrapJob, now: number): Promise<void> {
  const db = env.DB;
  const leased = await claimLinearBootstrapJobLease(db, job.linearIssueId, now, now + LINEAR_BOOTSTRAP_LEASE_MS);
  if (!leased) {
    log.info({ linearIssueId: job.linearIssueId }, "linear_bootstrap_job_lease_skipped");
    return;
  }
  const latest = await getLinearBootstrapJob(db, job.linearIssueId);
  if (!latest || latest.terminalOutcome) return;
  await runLinearBootstrapJobPhases(env, latest, now);
}

export type LinearBootstrapSweepReport = {
  scanned: number;
  completed: number;
  rescheduled: number;
  terminalFailed: number;
  cleared: number;
  errors: number;
};

export type LinearBootstrapSweepOptions = {
  now?: () => number;
  limit?: number;
};

/**
 * Drain stuck Linear bootstrap jobs. Hooked into the existing 5-minute cron
 * sweep next to `automationSchedulerTick`; no new cron trigger. Each job runs
 * in its own try/catch so one bad row never aborts the sweep (S7).
 */
export async function linearBootstrapSweepTick(
  env: Env,
  options: LinearBootstrapSweepOptions = {},
): Promise<LinearBootstrapSweepReport> {
  const now = options.now?.() ?? Date.now();
  const limit = options.limit ?? LINEAR_BOOTSTRAP_PER_TICK_BUDGET;
  const report: LinearBootstrapSweepReport = {
    scanned: 0,
    completed: 0,
    rescheduled: 0,
    terminalFailed: 0,
    cleared: 0,
    errors: 0,
  };

  const db = env.DB;
  if (!db) {
    log.warn({}, "linear_bootstrap_sweep_db_missing");
    return report;
  }

  const due = await listDueLinearBootstrapJobs(db, now, limit);
  report.scanned = due.length;
  for (const job of due) {
    try {
      await processLinearBootstrapJob(env, job, now);
      const after = await getLinearBootstrapJob(db, job.linearIssueId);
      if (!after) report.cleared += 1;
      else if (after.terminalOutcome === "completed") report.completed += 1;
      else if (after.terminalOutcome === "failed") report.terminalFailed += 1;
      else report.rescheduled += 1;
    } catch (err) {
      report.errors += 1;
      log.error(
        { linearIssueId: job.linearIssueId, sessionId: job.sessionId, phase: job.phase, error: String(err) },
        "linear_bootstrap_job_unhandled_error",
      );
    }
  }

  log.info({ ...report, now }, "linear_bootstrap_sweep_tick_complete");
  return report;
}
