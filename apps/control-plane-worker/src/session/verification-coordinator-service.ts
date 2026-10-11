import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import type { VerificationPrContext } from "../../../../shared/types/sandbox.js";
import { fetchVerificationPrContext, parseGithubPullRequestUrl } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { CallbackContext, Env } from "../types";
import { normalizeWebhookReference } from "../utils";
import { applyEvent } from "./fsm/apply-event";
import { buildLiveGuardResolver } from "./fsm/live-resolver";
import { liveFsmSinks } from "./fsm/live-side-effects";
import {
  getPrCoordination,
  getSyntheticPrCoordinationByPrUrl,
  insertPrCoordination,
  type PrCoordinationRecord,
  stampVerificationChildId,
  syntheticPrCoordinatorSessionId,
} from "./pr-coordination-db";
import { assertDatabase } from "./state";
import { checkVerificationConflict, findActiveVerificationSession } from "./verification-gate";
import { scheduleVerificationForPr } from "./verification-spawn";

type VerificationRequestSource = "api" | "child_session" | "slack" | "github";

export type CoordinatedVerificationResult =
  | { ok: true; sessionId: string; coordinatorSessionId: string; prUrl: string; headSha: string; duplicate: false }
  | { ok: true; sessionId: string; coordinatorSessionId: string; prUrl: string; headSha: string; duplicate: true }
  | {
      ok: false;
      reason: "admitted_elsewhere" | "invalid_pr" | "run_limit_reached" | "schedule_failed";
      coordinatorSessionId?: string;
      prUrl?: string;
      headSha?: string;
      error?: string;
    };

interface VerificationCoordinatorInput {
  env: Env;
  logger: Logger;
  waitUntil?: (promise: Promise<unknown>) => void;
  source: VerificationRequestSource;
  ownerUserId: string;
  businessId?: string | null;
  repoOwner: string;
  repoName: string;
  installationId: number;
  prUrl: string;
  prompt?: string | null;
  requestId?: string | null;
  modelId?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend | null;
  reasoningEffort?: string | null;
  callbackContext?: CallbackContext | null;
  /**
   * The manual "Verify" button intent (surfaced only from the user-initiated UI entries): always
   * start a FRESH verifier for this PR instead of reusing an in-flight one. Skips the advisory
   * active-verifier dedup and, when a verifier is already running (`pr_coordination` in VERIFYING),
   * supersedes it via the forced `verification.requested` edge (kill the active child + admit a new
   * run). Still bounded by the per-PR run cap (fails closed with `run_limit_reached`). Defaults to
   * false so auto-QA / webhook entry points keep their single-verifier reuse semantics.
   */
  forceNewSession?: boolean;
  childParentContext?: {
    parentSessionId: string;
    parentPromptId: string;
    spawnedByUserId: number;
    spawnDepth: number;
  } | null;
}

function buildSyntheticCoordinatorRecord(input: {
  coordinatorSessionId: string;
  prUrl: string;
  headSha: string;
  nowMs: number;
}): PrCoordinationRecord {
  return {
    sessionId: input.coordinatorSessionId,
    version: 0,
    state: "REVIEW",
    prUrl: input.prUrl,
    headSha: input.headSha,
    verdict: "none",
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: true,
    promptIntendsChange: true,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: input.nowMs,
  };
}

async function ensureSyntheticCoordinator(
  db: D1Database,
  input: { prUrl: string; headSha: string; nowMs: number },
): Promise<PrCoordinationRecord> {
  const coordinatorSessionId = syntheticPrCoordinatorSessionId(input.prUrl);
  const existing = await getPrCoordination(db, coordinatorSessionId);
  if (existing) return existing;

  const record = buildSyntheticCoordinatorRecord({
    coordinatorSessionId,
    prUrl: input.prUrl,
    headSha: input.headSha,
    nowMs: input.nowMs,
  });
  try {
    await insertPrCoordination(db, record);
    return record;
  } catch (error) {
    const raced = await getSyntheticPrCoordinationByPrUrl(db, input.prUrl);
    if (raced) return raced;
    throw error;
  }
}

async function emitCoordinatorEvent(
  input: VerificationCoordinatorInput,
  event: Record<string, unknown>,
): Promise<void> {
  const promise = postStructuredEventToDd(input.env, event).catch((error) => {
    input.logger.warn({ error: String(error), event: event.event }, "Verification coordinator telemetry failed");
  });
  if (input.waitUntil) input.waitUntil(promise);
  else void promise;
}

async function resolveTargetPr(input: VerificationCoordinatorInput): Promise<VerificationPrContext | null> {
  const parsed = parseGithubPullRequestUrl(input.prUrl);
  if (!parsed) return null;
  if (
    parsed.owner.toLowerCase() !== input.repoOwner.toLowerCase() ||
    parsed.repo.toLowerCase() !== input.repoName.toLowerCase()
  ) {
    return null;
  }
  return fetchVerificationPrContext(input.env, input.prUrl, {
    installationId: input.installationId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    requireRepoMatch: true,
  });
}

export async function requestCoordinatedVerification(
  input: VerificationCoordinatorInput,
): Promise<CoordinatedVerificationResult> {
  const prUrl = normalizeWebhookReference(input.prUrl);
  if (!prUrl) return { ok: false, reason: "invalid_pr", prUrl: input.prUrl };
  const db = assertDatabase(input.env);
  const prContext = await resolveTargetPr({ ...input, prUrl });
  if (!prContext?.headSha) return { ok: false, reason: "invalid_pr", prUrl };

  const coordinator = await ensureSyntheticCoordinator(db, {
    prUrl,
    headSha: prContext.headSha,
    nowMs: Date.now(),
  });
  const coordinatorSessionId = coordinator.sessionId;
  const conflictCheck = await checkVerificationConflict(input.env, input.logger, {
    prUrl,
    installationId: input.installationId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });
  const mergeConflictQa = conflictCheck.skip && conflictCheck.reason === "merge_conflict";

  // A manual force-new-session request skips the advisory dedup entirely: the whole point is to
  // start a fresh verifier even when one is already active for this PR (the in-flight run is
  // superseded below via the forced `verification.requested` edge, not reused).
  const activeVerifier = input.forceNewSession
    ? null
    : await findActiveVerificationSession(input.env, input.logger, prUrl);
  if (activeVerifier) {
    await emitCoordinatorEvent(input, {
      event: "verification_coordinator.duplicate_returned",
      source: input.source,
      pr_url: prUrl,
      coordinator_session_id: coordinatorSessionId,
      verifier_session_id: activeVerifier.sessionId,
    });
    return {
      ok: true,
      sessionId: activeVerifier.sessionId,
      coordinatorSessionId,
      prUrl,
      headSha: prContext.headSha,
      duplicate: true,
    };
  }

  const resolver = buildLiveGuardResolver(input.env, coordinatorSessionId);
  const applyResult = await applyEvent(
    {
      db,
      env: input.env,
      now: Date.now,
      resolver,
      ...liveFsmSinks(input.env, { waitUntil: input.waitUntil }),
      businessId: input.businessId ?? null,
      waitUntil: input.waitUntil,
    },
    {
      sessionId: coordinatorSessionId,
      event: {
        type: "verification.requested",
        headSha: prContext.headSha,
        force: input.forceNewSession ?? false,
        bypassRunLimitForMergeConflict: mergeConflictQa,
      },
      metadata: {
        type: "verification.requested",
        headSha: prContext.headSha,
        force: input.forceNewSession ?? false,
        bypassRunLimitForMergeConflict: mergeConflictQa,
      },
      actor: "user",
    },
  );

  if (applyResult.outcome !== "handled" || applyResult.to !== "VERIFYING") {
    const current = await getPrCoordination(db, coordinatorSessionId);
    if (
      applyResult.outcome === "handled" &&
      applyResult.to === "NEEDS_YOU" &&
      current?.blockedReason === "verification_run_limit"
    ) {
      await emitCoordinatorEvent(input, {
        event: "verification_coordinator.run_limit_reached",
        source: input.source,
        pr_url: prUrl,
        coordinator_session_id: coordinatorSessionId,
      });
      return {
        ok: false,
        reason: "run_limit_reached",
        coordinatorSessionId,
        prUrl,
        headSha: prContext.headSha,
      };
    }
    // A forced request never reuses the in-flight verifier: if the forced edge did not admit a fresh
    // run (only the NEEDS_YOU run-cap arm above lands here for a forced request), fall through to the
    // admitted_elsewhere signal rather than returning the existing child as a duplicate.
    if (!input.forceNewSession && current?.verificationChildId) {
      return {
        ok: true,
        sessionId: current.verificationChildId,
        coordinatorSessionId,
        prUrl,
        headSha: prContext.headSha,
        duplicate: true,
      };
    }
    return {
      ok: false,
      reason: "admitted_elsewhere",
      coordinatorSessionId,
      prUrl,
      headSha: prContext.headSha,
    };
  }

  const admitted = await getPrCoordination(db, coordinatorSessionId);
  const verificationRunId = admitted?.verificationRunId ?? coordinator.verificationRunId + 1;
  const scheduleResult = await scheduleVerificationForPr({
    env: input.env,
    logger: input.logger,
    waitUntil: input.waitUntil,
    parentSessionId: coordinatorSessionId,
    parentPromptId: null,
    projectionParentContext: input.childParentContext ?? null,
    ownerUserId: input.ownerUserId,
    businessId: input.businessId ?? null,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    installationId: input.installationId,
    prUrl,
    headSha: prContext.headSha,
    agentRole: null,
    requestId: input.requestId ?? undefined,
    verificationRunId,
    verifierPrompt: input.prompt ?? null,
    modelId: input.modelId ?? null,
    agentRuntimeBackend: input.agentRuntimeBackend ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    // Every coordinator entry point is user-initiated manual QA — api,
    // child_session, slack, AND the `github` issue-comment (`@cycloid qa`) path,
    // whose requester is the commenting user — so all of them fall the verifier
    // back to the requesting user's stored default model when no explicit model
    // is threaded. Automated github-webhook verification never flows through here
    // (the FSM `spawn_verification_child` executor calls scheduleVerificationForPr
    // directly and leaves this unset), so it keeps pinning the global Codex default.
    allowUserDefaultModel: true,
    callbackContext: input.callbackContext ?? null,
    fsmNative: true,
    // A forced supersede already killed the in-flight verifier via the FSM edge; skip the scheduler's
    // advisory active-verifier decline so the fresh run isn't blocked by the not-yet-torn-down child.
    forceNewSession: input.forceNewSession ?? false,
    allowMergeConflict: mergeConflictQa,
  });

  if (!scheduleResult.scheduled) {
    if (
      scheduleResult.reason === "merge_conflict" ||
      (scheduleResult.reason === "schedule_failed" && scheduleResult.failureStage === "pre_enqueue")
    ) {
      const { shadowEmitVerificationOutcome } = await import("./fsm/verification-producer");
      await shadowEmitVerificationOutcome(
        input.env,
        coordinatorSessionId,
        { outcome: "failed", runId: verificationRunId, headSha: null },
        input.logger,
        input.waitUntil,
      );
    } else if (scheduleResult.reason === "schedule_failed" && scheduleResult.failureStage === "post_enqueue") {
      if (scheduleResult.verificationSessionId) {
        await stampVerificationChildId(
          db,
          coordinatorSessionId,
          verificationRunId,
          scheduleResult.verificationSessionId,
        );
        // Keep this aligned with spawnVerificationChildExecutor's post_enqueue contract:
        // the verifier child is already running, so its verdict or the VERIFYING
        // deadline backstop owns settlement.
        await emitCoordinatorEvent(input, {
          event: "verification_coordinator.spawn_failed",
          source: input.source,
          reason: scheduleResult.reason,
          pr_url: prUrl,
          coordinator_session_id: coordinatorSessionId,
          failure_stage: scheduleResult.failureStage ?? null,
          verifier_session_id: scheduleResult.verificationSessionId,
        });
        return {
          ok: true,
          sessionId: scheduleResult.verificationSessionId,
          coordinatorSessionId,
          prUrl,
          headSha: prContext.headSha,
          duplicate: false,
        };
      }
    }
    await emitCoordinatorEvent(input, {
      event: "verification_coordinator.spawn_failed",
      source: input.source,
      reason: scheduleResult.reason,
      pr_url: prUrl,
      coordinator_session_id: coordinatorSessionId,
      failure_stage: scheduleResult.failureStage ?? null,
      verifier_session_id: scheduleResult.verificationSessionId ?? null,
    });
    return {
      ok: false,
      reason: "schedule_failed",
      coordinatorSessionId,
      prUrl,
      headSha: prContext.headSha,
      error: scheduleResult.reason,
    };
  }

  await stampVerificationChildId(db, coordinatorSessionId, verificationRunId, scheduleResult.sessionId);
  await emitCoordinatorEvent(input, {
    event: "verification_coordinator.admission_claimed",
    source: input.source,
    pr_url: prUrl,
    coordinator_session_id: coordinatorSessionId,
    verifier_session_id: scheduleResult.sessionId,
  });
  return {
    ok: true,
    sessionId: scheduleResult.sessionId,
    coordinatorSessionId,
    prUrl,
    headSha: prContext.headSha,
    duplicate: false,
  };
}
