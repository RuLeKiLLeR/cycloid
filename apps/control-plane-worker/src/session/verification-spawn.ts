import type { AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  isCodeReviewerAgentRole,
  isQaTesterAgentRole,
  resolveAgentRuntimeMetadata,
  VERIFY_AGENT_NAME,
} from "../../../../shared/agent/constants.js";
import { MODEL_REASONING_CONFIG } from "../../../../shared/constants/models.js";
import {
  isAwaitingVerificationVerdict,
  type VerificationResult,
  type VerificationState,
} from "../../../../shared/session/phase.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { SessionEntrypoint } from "../enums/session-entrypoint";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import {
  classifyVerificationScheduleFailureReason,
  emitVerificationScheduleFailedEvent,
  QA_TESTER_TELEMETRY_EVENT,
} from "../observability/review-loop-events";
import { closeQaLoopBinding, createQaLoopBinding, getQaLoopBinding, markQaLoopBindingPromptEnqueued } from "../qa/db";
import { resolveVerificationModel } from "../services/session-model-routing";
import { syncSessionProjection } from "../services/session-projection";
import { getUserSettingsIfExists } from "../settings/db";
import type { CallbackContext, Env, SessionState } from "../types";
import { normalizeWebhookReference } from "../utils";
import { SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, upsertSessionWebhookRef } from "../webhooks/db";
import { assertDatabase, closeSessionState, createSessionState, enqueueSessionPrompt, getSessionState } from "./state";
import {
  checkVerificationConflict,
  checkVerificationRunLimit,
  findActiveVerificationSession,
} from "./verification-gate";
import { syncVerificationResultForPr, syncVerificationStateForPr } from "./verification-state";

export type AutoVerificationScheduleResult =
  | { scheduled: true; sessionId: string }
  | {
      scheduled: false;
      reason:
        | "policy_not_auto"
        | "verification_session"
        | "review_session"
        | "auto_verify_disabled"
        | "invalid_input"
        | "active_verification_session_exists"
        | "merge_conflict"
        | "verification_run_limit_reached"
        | "verdict_already_settled"
        | "schedule_failed";
      error?: string;
      /**
       * `schedule_failed` only: whether the verifier prompt was ALREADY enqueued when the failure hit
       * (post-enqueue bookkeeping fault — request-row update, label sync, …). A post-enqueue failure
       * means the child IS running: the caller must NOT terminalize the parent run (ChatGPT P2 #6425 —
       * the child's later valid verdict must still settle it). Pre-enqueue = no child, safe to
       * terminalize. Also carries the child session id when one was created, for observability.
       */
      failureStage?: "pre_enqueue" | "post_enqueue";
      verificationSessionId?: string;
    };

export interface AutoVerificationScheduleInput {
  env: Env;
  logger: Logger;
  // Optional fire-and-forget dispatcher for telemetry posted off the scheduling critical path.
  waitUntil?: (promise: Promise<unknown>) => void;
  parentSessionId?: string | null;
  parentPromptId?: string | null;
  projectionParentContext?: {
    parentSessionId: string;
    parentPromptId: string;
    spawnedByUserId: number;
    spawnDepth: number;
  } | null;
  ownerUserId: string;
  businessId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  installationId?: number | null;
  prUrl: string;
  headSha: string;
  agentRole?: string | null;
  autoVerifyDisabled?: boolean | null;
  requestId?: string | null;
  verifierPrompt?: string | null;
  modelId?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend | null;
  reasoningEffort?: string | null;
  // Manual QA (api / child_session / slack) with no explicit model: fall the
  // verifier back to the requesting user's stored `default_model` before the
  // global Codex default. Automated (github-webhook) verification leaves this
  // false so it keeps pinning the global default.
  allowUserDefaultModel?: boolean | null;
  callbackContext?: CallbackContext | null;
  // Current verification verdict on the implementation session, threaded by the done-state callers.
  // A SETTLED verdict here means re-verification is unnecessary: the done-state endpoint fires on
  // every done transition (including when CI re-runs on a content-identical head — a no-op rebase),
  // and the head-change reset clears the verdict ONLY when the tree actually changed, so a preserved
  // verdict reliably means the content is unchanged since that verdict (ARC-1243 follow-up). Omitting
  // these defaults to "awaiting" — preserving the prior always-schedule behavior for callers that do
  // not thread them.
  currentVerificationState?: VerificationState | null;
  currentVerificationResult?: VerificationResult | null;
  // Head SHA the current verdict was validated for (the no-op-head-change stamp). The skip below only
  // fires when this equals the head being settled, so an outdated verdict left by a silently-failed clear
  // on a real change (different head) is NOT mistaken for a no-op and still re-verifies.
  currentVerificationVerdictHeadSha?: string | null;
  // ARC-1330 §17-A run-identity carry (wired end-to-end in PR 47): the monotonic `verification_run_id`
  // the FSM minted for this run (`request_verification`/`redispatch_verification`). Threaded onto the
  // verifier prompt enqueue below, persisted PER PROMPT on the child DO, and echoed back on the child's
  // `VerifierTerminalResult.verificationRunId`, so the spine run-scopes verdict freshness (the H→H′→H
  // ABA guard). Optional/additive: legacy callers omit it — their runs' verdicts self-source in shadow
  // and are rejected at live (fail-toward-NOT-fresh, B4).
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationRunId?: number;
  // ARC-1330 W11-V3(a): set true by the FSM `spawn_verification_child` executor — the ONLY live caller
  // post-flip. It flips this from the legacy VA orchestrator into the FSM-native spawn destination:
  //   • The env-level tri-state `VerificationPolicy` gate is SKIPPED (the FSM cascade already decided to
  //     spawn at REVIEW.caught_up[code_changed ∧ under_cap]) — the module fold destination for D-50A.
  //     The per-user/session `auto_verify_disabled` opt-out (the #6395 user-settings toggle) IS still
  //     honored — identical to the legacy arm — declining with the first-class structured
  //     `auto_verify_disabled` skip the executor surfaces on the flip dashboard. Whether the FSM path
  //     should go D7 always-on (overriding the toggle) is an OPEN product decision (Jag's), not this
  //     PR's — flipping it later is a one-line change + comms. The `verification_session` structural
  //     gate always applies.
  //   • There is no managed "verification started" PR surface anymore; QA runs off-gate in parallel and
  //     its progress is not rendered on the PR body.
  // Legacy callers omit it (default false) → byte-identical pre-flip behavior until D-50A removes them.
  fsmNative?: boolean;
  // Manual "Verify" button force-new-session (ARC-1514): the coordinator already superseded the in-flight
  // verifier via the forced `verification.requested` FSM edge (kill_verification(active) + a null
  // `verification_child_id`), so a fresh run is intended. The advisory `findActiveVerificationSession`
  // decline below is bypassed when this is set — teardown is best-effort/eventually-consistent, so that
  // read can still observe the just-killed child and would otherwise fail the rerun with
  // `active_verification_session_exists`. The real single-verifier boundary (the FSM-native
  // `verification_child_id IS NULL` spawn anchor, claimed by the coordinator's `stampVerificationChildId`)
  // still holds. Defaults false, so every other caller keeps the advisory dedup.
  forceNewSession?: boolean;
  // Coordinated manual QA can explicitly run against a merge-conflicted PR after the coordinator has
  // already confirmed the conflict and bypassed the FSM run cap. Automated/default callers omit this
  // and keep the normal merge-conflict skip.
  allowMergeConflict?: boolean;
}

function buildAutoVerificationPrompt(
  prUrl: string,
  headSha: string,
  reusedLifecycleVerifier: boolean,
  verifierPrompt?: string | null,
): string {
  return [
    "qa=true",
    "",
    verifierPrompt?.trim() || `Verify the pull request after the review loop completed: ${prUrl}`,
    `Target head SHA: ${headSha}`,
    reusedLifecycleVerifier
      ? "This is another automated QA pass for the same PR lifecycle; verify the whole current PR state, not only the latest delta."
      : null,
    "",
    "First emit the Phase 1 VerificationPlannerArtifact. The planner decides skip/run, whether runtime evidence is needed, and the required proof contract. Do not start app/runtime services during the planner step.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function emitRoutingDecided(input: AutoVerificationScheduleInput, prUrl: string, headSha: string): void {
  const eventPromise = postStructuredEventToDd(input.env, {
    event: QA_TESTER_TELEMETRY_EVENT.ROUTING_DECIDED,
    needs_verification: true,
    needs_app_runtime: false,
    verification_reason_code: "review_loop_done",
    runtime_reason_code: "planner_controlled",
    fail_closed: false,
    confidence: "deterministic",
    pr_url: prUrl,
    head_sha: headSha,
    parent_session_id: input.parentSessionId ?? null,
  }).catch((error) => {
    input.logger.warn(
      { error: String(error), prUrl, headSha, parentSessionId: input.parentSessionId ?? null },
      "Failed to emit QA Tester routing decision telemetry",
    );
  });
  if (input.waitUntil) {
    input.waitUntil(eventPromise);
    return;
  }
  void eventPromise;
}

function parentContext(input: AutoVerificationScheduleInput): {
  parentSessionId: string;
  parentPromptId: string;
  spawnedByUserId: number;
  spawnDepth: number;
} | null {
  if (input.projectionParentContext) return input.projectionParentContext;
  const parentSessionId = input.parentSessionId?.trim();
  if (!parentSessionId) return null;
  const spawnedByUserId = Number(input.ownerUserId);
  if (!Number.isFinite(spawnedByUserId)) return null;
  return {
    parentSessionId,
    parentPromptId: input.parentPromptId?.trim() || `auto-verification:${input.headSha.trim()}`,
    spawnedByUserId,
    spawnDepth: 1,
  };
}

async function rollbackCreatedVerifier(input: AutoVerificationScheduleInput, sessionId: string): Promise<void> {
  const closed = await closeSessionState(input.env, sessionId, input.requestId, {
    reason: "auto_verification_scheduling_failed",
    metadata: {
      parentSessionId: input.parentSessionId ?? null,
      prUrl: input.prUrl,
      headSha: input.headSha,
    },
  });
  if (!closed) return;
  await syncSessionProjection({
    db: assertDatabase(input.env),
    sessionId,
    session: closed.session,
    replay: closed.replay,
    logger: input.logger,
    source: "verification-auto-scheduler.rollback",
    requestId: input.requestId ?? null,
    userId: input.ownerUserId,
  });
}

async function getLifecycleVerificationAttemptCount(
  input: AutoVerificationScheduleInput,
  prUrl: string,
  lifecycleId: string,
): Promise<number | null> {
  try {
    const parentSession = await getSessionState(input.env, lifecycleId, input.requestId ?? undefined);
    const attemptCount = parentSession?.verificationAttemptCount;
    if (typeof attemptCount === "number" && Number.isInteger(attemptCount) && attemptCount >= 0) {
      return attemptCount;
    }
  } catch (error) {
    input.logger.warn(
      { prUrl, parentSessionId: lifecycleId, error: String(error) },
      "Failed to load parent session verification attempt count; using verifier-session count",
    );
  }
  return null;
}

async function isReusableLifecycleVerifier(input: AutoVerificationScheduleInput, prUrl: string, sessionId: string) {
  try {
    const session = await getSessionState(input.env, sessionId, input.requestId ?? undefined);
    if (session?.status === "active" && isQaTesterAgentRole(session.agentRole)) return true;
    input.logger.warn(
      {
        prUrl,
        verificationSessionId: sessionId,
        sessionStatus: session?.status ?? null,
        agentRole: session?.agentRole ?? null,
      },
      "Ignoring stale automatic QA lifecycle binding because the verifier session is not reusable",
    );
  } catch (error) {
    input.logger.warn(
      { prUrl, verificationSessionId: sessionId, error: String(error) },
      "Ignoring stale automatic QA lifecycle binding after verifier session lookup failed",
    );
  }
  return false;
}

export async function scheduleVerificationForPr(
  input: AutoVerificationScheduleInput,
): Promise<AutoVerificationScheduleResult> {
  // ARC-1330 D-50A — D7 always-on. The env-level tri-state `VerificationPolicy` gate is GONE: QA runs
  // whenever the run is reachable (no `disabled`/`manual` deploy-wide arm). The FSM cascade already made
  // the run decision (REVIEW.caught_up[code_changed ∧ under_cap] → VERIFYING) for the FSM path, and the
  // legacy rerun path is gated by the advisory active-verifier check + run-limit below — neither needs a
  // deploy-wide policy switch. The `policy_not_auto` decline VALUE survives in `AutoVerificationScheduleResult`
  // (structured-skip taxonomy) but is no longer emitted here. The per-user/session `auto_verify_disabled`
  // opt-out (the #6395 toggle) is a DIFFERENT, first-class value that is still honored below.
  // BOTH paths honor the per-user/session auto-verify opt-out (the #6395 `user_settings` toggle,
  // migration 0227). DECIDED 2026-07-06 (the formerly-OPEN D7-always-on question): the opt-out is
  // waived at the FSM layer — the caught_up cascade treats verification as not-a-gate for opted-out
  // sessions (guards.autoVerifyDisabled, resolved by live-resolver.ts), so they settle MERGE_READY
  // on green CI instead of parking in VERIFYING for the 1h backstop. This decline therefore fires
  // only as defense-in-depth (a stale/failed session read at the caught_up snapshot) and on the
  // legacy rerun path; it still surfaces as the first-class `auto_verify_disabled` structured skip,
  // with the VERIFYING deadline backstop owning the unwedge.
  if (input.autoVerifyDisabled) return { scheduled: false, reason: "auto_verify_disabled" };
  // Structural (BOTH paths): a verifier child must never spawn its own verifier (infinite regress).
  if (isQaTesterAgentRole(input.agentRole)) return { scheduled: false, reason: "verification_session" };
  if (isCodeReviewerAgentRole(input.agentRole)) return { scheduled: false, reason: "review_session" };

  const prUrl = normalizeWebhookReference(input.prUrl);
  const headSha = input.headSha.trim();
  if (!prUrl || !headSha || !input.ownerUserId.trim()) return { scheduled: false, reason: "invalid_input" };
  // A settled verdict suppresses re-verification ONLY when it is positively tied to the head being
  // settled — i.e. the verdict was validated for exactly this head via the no-op-head-change stamp
  // (verificationVerdictHeadSha). "Verdict present" alone is NOT enough: a real content change whose
  // best-effort verdict clear silently fails leaves an outdated settled verdict stamped for a DIFFERENT
  // head, and that must still re-verify and self-heal. The done-state endpoint re-fires on every done
  // transition (incl. CI re-runs on a content-identical no-op head), so this is the hot path; the
  // check is a cheap in-memory string compare. Skips before creating a verifier session.
  // A null/mismatched stamp falls through to the normal flow (re-verify, bounded downstream by the
  // run-limit + advisory active-verifier check). ARC-1243 follow-up.
  if (
    !isAwaitingVerificationVerdict(input.currentVerificationState ?? null, input.currentVerificationResult ?? null) &&
    input.currentVerificationVerdictHeadSha != null &&
    input.currentVerificationVerdictHeadSha === headSha
  ) {
    return { scheduled: false, reason: "verdict_already_settled" };
  }
  const conflictCheck = await checkVerificationConflict(input.env, input.logger, {
    prUrl,
    installationId: input.installationId ?? null,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
  });
  if (conflictCheck.skip && !(input.allowMergeConflict && conflictCheck.reason === "merge_conflict")) {
    await syncVerificationStateForPr(input.env, {
      prUrl,
      state: "verification-stopped",
      sessionIds: input.parentSessionId ? [input.parentSessionId] : [],
      installationId: input.installationId ?? null,
      repoOwner: input.repoOwner ?? null,
      repoName: input.repoName ?? null,
      requestId: input.requestId ?? null,
      logger: input.logger,
    });
    return { scheduled: false, reason: conflictCheck.reason };
  }
  let verificationAttemptCount: number | null = null;

  let verificationSessionId: string = crypto.randomUUID();

  let db: D1Database | null = null;
  let createdSession = false;
  let createdSessionThisAttempt = false;
  let promptEnqueued = false;
  let automatedLifecycleId: string | null = null;
  let reusingLifecycleVerifier = false;
  let resolvedVerifierBackend: string | null = null;
  let resolvedVerifierModel: string | null = null;
  try {
    db = assertDatabase(input.env);
    input.logger.info(
      {
        prUrl,
        headSha,
        verificationRuntimeMode: "none",
      },
      "Scheduling verification with planner-controlled routing",
    );
    emitRoutingDecided(input, prUrl, headSha);

    automatedLifecycleId = input.parentSessionId?.trim() || null;
    if (automatedLifecycleId) {
      const existingBinding = await getQaLoopBinding(db, prUrl, automatedLifecycleId);
      if (existingBinding) {
        const reusable = await isReusableLifecycleVerifier(input, prUrl, existingBinding.qaSessionId);
        if (reusable) {
          verificationSessionId = existingBinding.qaSessionId;
          createdSession = true;
          reusingLifecycleVerifier = true;
        } else {
          await closeQaLoopBinding(db, {
            prUrl,
            automatedLifecycleId,
            qaSessionId: existingBinding.qaSessionId,
            status: "expired",
          }).catch((closeError) => {
            input.logger.warn(
              {
                error: String(closeError),
                prUrl,
                headSha,
                automatedLifecycleId,
                verificationSessionId: existingBinding.qaSessionId,
              },
              "Failed to expire stale automatic QA lifecycle binding",
            );
          });
        }
      }
    }

    // ARC-1330 W11 D-52: the per-head `verification_session_requests` claim is DROPPED (with the
    // per-PR lock D-51 already removed). The single-verifier admission boundary is now the FSM-native
    // spawn idempotency anchor (W11-V4) in `spawnVerificationChildExecutor` (the committed spine read +
    // `stampVerificationChildId`'s `verification_child_id IS NULL` first-writer-wins claim). The advisory
    // `findActiveVerificationSession` check below is the only remaining entry-point dedup here — a
    // NON-ATOMIC advisory (it is the sole belt for the legacy callers that don't ride the FSM anchor:
    // the review-loop-done webhook + done-state + stopped-verifier rerun). Accepted D-52 cost: a
    // truly-concurrent spawn window CAN create a SECOND verifier session — single recorded verdict (the
    // loser fails run-scoped freshness once the record leaves VERIFYING), no cap burn, the extra session
    // parks per #6310.
    // A forced manual rerun (ARC-1514) skips this advisory decline: the coordinator already superseded
    // the in-flight verifier (forced `verification.requested` edge → kill_verification(active) + null
    // child slot), and teardown is best-effort, so this read can still see the just-killed child. The
    // FSM-native `verification_child_id IS NULL` spawn anchor remains the atomic single-verifier boundary.
    const activeVerifier = input.forceNewSession
      ? null
      : await findActiveVerificationSession(input.env, input.logger, prUrl);
    if (activeVerifier && activeVerifier.sessionId !== verificationSessionId) {
      return { scheduled: false, reason: "active_verification_session_exists" };
    }

    const runLimit = await checkVerificationRunLimit(input.env, input.logger, prUrl, {
      parentSessionId: input.parentSessionId ?? null,
    });
    // FSM-native callers arrive after the row is already committed VERIFYING, so this check should agree
    // with the dispatch-edge cap. Keep the log-only stance for defense-in-depth: a decline here must not
    // strand an already-admitted verifier run.
    if (!runLimit.allowed) {
      input.logger.info(
        { prUrl, currentRuns: runLimit.currentRuns, maxRuns: runLimit.maxRuns },
        "verification run limit exceeded after FSM admission — advisory only",
      );
    }
    let currentRuns = runLimit.currentRuns;
    if (automatedLifecycleId) {
      const lifecycleAttemptCount = await getLifecycleVerificationAttemptCount(input, prUrl, automatedLifecycleId);
      if (lifecycleAttemptCount !== null) {
        currentRuns = currentRuns === null ? lifecycleAttemptCount : Math.max(currentRuns, lifecycleAttemptCount);
      }
      if (currentRuns !== null && currentRuns >= runLimit.maxRuns) {
        input.logger.info(
          { prUrl, currentRuns, maxRuns: runLimit.maxRuns, automatedLifecycleId },
          "lifecycle attempt limit exceeded after FSM admission — advisory only",
        );
      }
    }
    verificationAttemptCount = currentRuns === null ? null : Math.max(1, currentRuns);

    const agentRuntime = resolveAgentRuntimeMetadata({ qa: true, targetPrUrl: prUrl });
    const repoContext =
      input.repoOwner?.trim() && input.repoName?.trim()
        ? { repoOwner: input.repoOwner.trim(), repoName: input.repoName.trim() }
        : undefined;
    if (!createdSession) {
      // Match the verifier to the parent (built) session backend/model when the
      // pair is known and valid. The recovery path for an already-created verifier
      // session (createdSession === true) skips this block entirely, so a recovered
      // session keeps its originally resolved backend/model. Falls back to the
      // Codex default when the parent session can't be loaded or has an invalid
      // model/backend pair.
      let parentSessionForModel: SessionState | null = null;
      if (input.parentSessionId) {
        try {
          parentSessionForModel = await getSessionState(input.env, input.parentSessionId, input.requestId ?? undefined);
        } catch (error) {
          input.logger.warn(
            { prUrl, headSha, parentSessionId: input.parentSessionId, error: String(error) },
            "Failed to load parent session for verifier runtime; using default verifier runtime",
          );
        }
      }
      // Manual QA with no explicit/parent model verifies on the requesting user's
      // stored default model (loaded here, gated on `allowUserDefaultModel`). A
      // settings-load failure is non-fatal: it leaves the default null so the
      // resolver falls back to the global Codex default rather than blocking QA.
      let userDefaultModel: string | null = null;
      if (input.allowUserDefaultModel && !input.modelId) {
        const ownerUserIdNumber = Number(input.ownerUserId);
        if (Number.isFinite(ownerUserIdNumber)) {
          try {
            const ownerSettings = await getUserSettingsIfExists(db, ownerUserIdNumber);
            userDefaultModel = ownerSettings?.default_model ?? null;
          } catch (error) {
            input.logger.warn(
              { prUrl, headSha, ownerUserId: input.ownerUserId, error: String(error) },
              "Failed to load owner default model for manual verification; using default verifier runtime",
            );
          }
        }
      }
      const baseModel = resolveVerificationModel(
        {
          parentModel: input.modelId ?? parentSessionForModel?.model,
          parentAgentRuntimeBackend: input.agentRuntimeBackend ?? parentSessionForModel?.agentRuntimeBackend,
        },
        userDefaultModel,
      );
      resolvedVerifierBackend = baseModel.agentRuntimeBackend;
      resolvedVerifierModel = baseModel.currentModel;
      // Re-derive the reasoning-effort default from the RESOLVED model when the
      // caller didn't pin one: a user default on a different backend needs its
      // own backend's valid effort, not one computed from the forced default.
      const resolvedReasoningEffort =
        input.reasoningEffort ?? MODEL_REASONING_CONFIG[baseModel.currentModel]?.default ?? null;
      input.logger.info(
        {
          prUrl,
          headSha,
          verificationSessionId,
          parentSessionId: input.parentSessionId ?? null,
          parentModel: input.modelId ?? parentSessionForModel?.model ?? null,
          parentBackend: input.agentRuntimeBackend ?? parentSessionForModel?.agentRuntimeBackend ?? null,
          verifierBackend: baseModel.agentRuntimeBackend,
          verifierModel: baseModel.currentModel,
        },
        "Resolved automatic verification runtime",
      );
      const created = await createSessionState(input.env, verificationSessionId, input.ownerUserId, {
        sessionKind: "repo",
        entrypoint: SessionEntrypoint.AUTO_QA,
        repoContext,
        requestId: input.requestId,
        installationId: input.installationId ?? undefined,
        businessId: input.businessId ?? undefined,
        model: baseModel.currentModel,
        agentRuntimeBackend: baseModel.agentRuntimeBackend,
        reasoningEffort: resolvedReasoningEffort ?? undefined,
        agentRole: agentRuntime.agentRole,
        agentProfile: agentRuntime.agentProfile,
        harnessKind: agentRuntime.harnessKind,
        runtimeStartupProfile: agentRuntime.runtimeStartupProfile,
        verificationRuntimeMode: "none",
        targetPrUrl: agentRuntime.targetPrUrl ?? null,
        callbackContext: input.callbackContext ?? undefined,
        waitUntil: input.waitUntil,
      });
      createdSession = true;
      createdSessionThisAttempt = true;

      await syncSessionProjection({
        db,
        sessionId: verificationSessionId,
        session: created.session,
        replay: created.replay,
        richStatus: "idle",
        parentContext: parentContext(input),
        logger: input.logger,
        source: "verification-auto-scheduler.create",
        requestId: input.requestId ?? null,
        userId: input.ownerUserId,
      });
      await upsertSessionWebhookRef(db, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl, verificationSessionId);
    }

    const prompt = buildAutoVerificationPrompt(prUrl, headSha, reusingLifecycleVerifier, input.verifierPrompt);
    const enqueueResult = await enqueueSessionPrompt(input.env, verificationSessionId, prompt, input.ownerUserId, {
      agent: VERIFY_AGENT_NAME,
      requestId: input.requestId,
      // ARC-1330 §17-A (PR 47): thread the committed run token onto THIS run's prompt — the child DO
      // persists it per prompt (verifier reuse serves multiple runs) and the verdict-back echoes it as
      // `VerifierTerminalResult.verificationRunId`, closing the run-scoped freshness loop. Absent for
      // legacy callers that don't carry one (their verdicts self-source in shadow / reject at live).
      verificationRunId: input.verificationRunId,
      verificationCoordinatorSessionId: input.parentSessionId ?? null,
    });
    if (!enqueueResult.ok || !enqueueResult.payload) {
      throw new Error(enqueueResult.error ?? `Verifier prompt enqueue failed with status ${enqueueResult.status}`);
    }
    promptEnqueued = true;
    if (automatedLifecycleId) {
      try {
        let bindingReady = reusingLifecycleVerifier;
        if (!bindingReady) {
          const binding = await createQaLoopBinding(db, {
            prUrl,
            automatedLifecycleId,
            qaSessionId: verificationSessionId,
            parentSessionId: automatedLifecycleId,
            lastScheduledHeadSha: null,
            activePromptId: null,
          });
          bindingReady = binding?.qaSessionId === verificationSessionId;
        }
        if (bindingReady) {
          const marked = await markQaLoopBindingPromptEnqueued(db, {
            prUrl,
            automatedLifecycleId,
            qaSessionId: verificationSessionId,
            lastScheduledHeadSha: headSha,
            activePromptId: enqueueResult.payload.prompt?.promptId ?? null,
          });
          if (!marked) {
            input.logger.warn(
              { prUrl, headSha, verificationSessionId, automatedLifecycleId },
              "Automatic verification lifecycle binding prompt update did not modify a row",
            );
          }
        } else {
          input.logger.warn(
            { prUrl, headSha, verificationSessionId, automatedLifecycleId },
            "Automatic verification lifecycle binding was not created",
          );
        }
      } catch (bindingError) {
        input.logger.warn(
          { error: String(bindingError), prUrl, headSha, verificationSessionId, automatedLifecycleId },
          "Failed to persist automatic verification lifecycle binding after prompt enqueue",
        );
      }
    }
    await syncVerificationStateForPr(input.env, {
      prUrl,
      state: "verification-in-progress",
      sessionIds: input.parentSessionId ? [input.parentSessionId] : [],
      attemptCount: verificationAttemptCount,
      installationId: input.installationId ?? null,
      repoOwner: input.repoOwner ?? null,
      repoName: input.repoName ?? null,
      requestId: input.requestId ?? null,
      logger: input.logger,
    });
    // Nothing else ever resets verificationResult, so without this an outdated needs-work from run N
    // would keep reading as the verdict while run N+1 is in progress. Clear it the moment the new
    // run starts. Non-fatal: the prompt is already enqueued, so throwing here would surface
    // schedule_failed (and a DO 500) for a run that IS live; and consumers trust the result only
    // at verification-done, so an uncleaned outdated result is masked by verification-in-progress
    // until the run's own terminal sync overwrites it.
    await syncVerificationResultForPr(input.env, {
      prUrl,
      result: null,
      sessionIds: input.parentSessionId ? [input.parentSessionId] : [],
      requestId: input.requestId ?? null,
      logger: input.logger,
    }).catch((error) => {
      input.logger.warn(
        { prUrl, headSha, verificationSessionId, error: String(error) },
        "Failed to clear verification result after scheduling; outdated result masked until verification-done",
      );
    });

    try {
      await syncSessionProjection({
        db,
        sessionId: verificationSessionId,
        session: enqueueResult.payload.session,
        replay: enqueueResult.payload.replay,
        logger: input.logger,
        source: "verification-auto-scheduler.enqueue",
        requestId: input.requestId ?? null,
        userId: input.ownerUserId,
      });
    } catch (projectionError) {
      input.logger.warn(
        { error: String(projectionError), prUrl, headSha, verificationSessionId },
        "Failed to sync auto-verification projection after enqueue",
      );
    }

    return { scheduled: true, sessionId: verificationSessionId };
  } catch (error) {
    if (createdSessionThisAttempt && !promptEnqueued) {
      await rollbackCreatedVerifier(input, verificationSessionId).catch((rollbackError) => {
        input.logger.warn(
          { error: String(rollbackError), prUrl, headSha, verificationSessionId },
          "Failed to roll back auto-verification session after scheduling failure",
        );
      });
    }
    if (db && automatedLifecycleId && reusingLifecycleVerifier && !promptEnqueued) {
      await closeQaLoopBinding(db, {
        prUrl,
        automatedLifecycleId,
        qaSessionId: verificationSessionId,
        status: "expired",
      }).catch((closeError) => {
        input.logger.warn(
          { error: String(closeError), prUrl, headSha, verificationSessionId, automatedLifecycleId },
          "Failed to expire reused automatic QA lifecycle binding after scheduling failure",
        );
      });
    }
    const message = stringifyError(error);
    input.logger.warn(
      {
        error: message,
        prUrl,
        headSha,
        verificationSessionId,
        parentSessionId: input.parentSessionId ?? null,
        verifierBackend: resolvedVerifierBackend,
        verifierModel: resolvedVerifierModel,
      },
      "Automatic verification scheduling failed",
    );
    // Structured telemetry for the schedule-failed terminal. The pino warn above never reaches
    // Datadog (control-plane logpush is off), so without this the failure is invisible to metrics and
    // monitors and the review loop silently retries it every sweep (the 2026-06-23 stuck-loop class).
    // Fire-and-forget on the caller's waitUntil (detach on cron paths that have none); the emit
    // no-ops without DD_API_KEY and swallows POST failures, so it never blocks scheduling.
    const scheduleFailedTelemetry = emitVerificationScheduleFailedEvent(input.env, {
      reasonCode: classifyVerificationScheduleFailureReason(error),
      error: message,
      repo: input.repoOwner && input.repoName ? `${input.repoOwner}/${input.repoName}` : null,
      ownerUserId: Number(input.ownerUserId),
      sessionId: input.parentSessionId ?? null,
      verificationSessionId,
      verifierBackend: resolvedVerifierBackend,
      verifierModel: resolvedVerifierModel,
      prUrl,
      headSha,
    });
    if (input.waitUntil) input.waitUntil(scheduleFailedTelemetry);
    else void scheduleFailedTelemetry.catch(() => {});
    return {
      scheduled: false,
      reason: "schedule_failed",
      error: message,
      failureStage: promptEnqueued ? "post_enqueue" : "pre_enqueue",
      verificationSessionId: createdSessionThisAttempt || promptEnqueued ? verificationSessionId : undefined,
    };
  }
}
