import { REVIEW_AGENT_NAME, REVIEW_AGENT_ROLE } from "../../../../shared/agent/constants.js";
import { PLAN_AGENT_NAME, reviewVerificationExemptReason } from "../../../../shared/agent/constants.js";
import { MODEL_REASONING_CONFIG } from "../../../../shared/constants/models.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { canResolveProviderKeyForSpawn } from "../integrations/runtime.js";
import { createLogger } from "../logger.js";
import { getPrReviewModelPairing } from "../observability/review-loop-events.js";
import {
  associatePrReviewTriggerSession,
  claimPrReviewTrigger,
  completePrReviewTrigger,
  releasePrReviewTrigger,
} from "../session/pr-review-claims-db.js";
import { closeSessionState, createSessionState, enqueueSessionPrompt, type RepoContext } from "../session/state.js";
import type { Env, InternalAuthContext } from "../types.js";
import { isCycloidMember } from "./internal-feature-gate.js";
import { admitSessionCreate } from "./session-admission.js";
import { persistInitialSessionProjection } from "./session-create.js";
import { resolvePrReviewModel } from "./session-model-routing.js";

const log = createLogger({ bindings: { component: "pr-review-trigger-spawn" } });

export type PrReviewTriggerAuthorization = { mode: "webhook_actor"; actorLogin: string } | { mode: "trusted_auto" };

export type PrReviewTriggerSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; kind: "skip"; reason: "claim_contended" }
  | { ok: false; kind: "retryable"; reason: "admission_failed" | "spawn_failed" };

export function isEligibleForAutomaticPrReview(
  session: { agentRole?: string | null; agentProfile?: string | null; agentRuntimeBackend?: string | null },
  owner: { businessId?: string | null } | null,
  countCreateMetric: boolean,
): boolean {
  return (
    countCreateMetric &&
    isCycloidMember(owner) &&
    reviewVerificationExemptReason(session) === null &&
    session.agentProfile !== REVIEW_AGENT_NAME &&
    session.agentProfile !== PLAN_AGENT_NAME
  );
}

export interface PrReviewTriggerSpawnInput {
  env: Env;
  ownerUserId: string;
  businessId: string;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  claimToken: string;
  triggerCommentId: number;
  triggerSource: "webhook" | "auto";
  authorization: PrReviewTriggerAuthorization;
  focus: string | null;
  /** Auto-publish supplies the author session pair; webhook reviews may target external PRs. */
  authorModel?: string | null;
  authorAgentRuntimeBackend?: import("../../../../shared/agent/agent-runtime-backend.js").AgentRuntimeBackend | null;
  repoContext?: RepoContext;
  sessionId?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Shared review-session orchestration. The claim is associated before enqueue
 * and uses the opaque attempt token so a stale takeover cannot mutate another
 * attempt. We keep create/projection split here to retain the initialized
 * session for compensation if projection, association, or enqueue fails.
 */
export async function spawnPrReviewTrigger(input: PrReviewTriggerSpawnInput): Promise<PrReviewTriggerSpawnResult> {
  const claim = await claimPrReviewTrigger(input.env.DB, {
    prUrl: input.prUrl,
    triggerCommentId: input.triggerCommentId,
    claimToken: input.claimToken,
    triggerSource: input.triggerSource,
  });
  if (!claim.won) return { ok: false, kind: "skip", reason: "claim_contended" };

  let sessionId: string | null = null;
  try {
    const admission = await admitSessionCreate({ db: input.env.DB, env: input.env, businessId: input.businessId });
    if (!admission.ok) {
      await releasePrReviewTrigger(input.env.DB, { prUrl: input.prUrl, claimToken: input.claimToken });
      return { ok: false, kind: "retryable", reason: "admission_failed" };
    }

    sessionId = input.sessionId ?? crypto.randomUUID();
    const auth: InternalAuthContext = {
      userId: input.ownerUserId,
      businessId: input.businessId,
      canAccessAllSessions: false,
    };
    const anthropicAvailable = await canResolveProviderKeyForSpawn(input.env.DB, {
      env: input.env,
      ownerUserId: input.ownerUserId,
      businessId: input.businessId,
      provider: "anthropic",
    });
    const model = resolvePrReviewModel(
      {
        authorModel: input.authorModel,
        authorAgentRuntimeBackend: input.authorAgentRuntimeBackend,
      },
      { anthropicAvailable },
    );
    const reasoningEffort =
      model.agentRuntimeBackend === "claude_code" &&
      MODEL_REASONING_CONFIG[model.currentModel]?.efforts.includes("high")
        ? "high"
        : (MODEL_REASONING_CONFIG[model.currentModel]?.default ?? null);
    const created = await createSessionState(input.env, sessionId, input.ownerUserId, {
      entrypoint: input.triggerSource === "auto" ? SessionEntrypoint.AUTO_PR_REVIEW : SessionEntrypoint.GITHUB,
      sessionKind: "repo",
      repoContext: input.repoContext ?? { repoOwner: input.repoOwner, repoName: input.repoName },
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      targetPrUrl: input.prUrl,
      installationId: input.installationId,
      agentRole: REVIEW_AGENT_ROLE,
      agentProfile: REVIEW_AGENT_NAME,
      autoVerify: false,
      adoptedExternalPr: true,
      businessId: input.businessId,
      auth,
      model: model.currentModel,
      reasoningEffort,
      waitUntil: input.waitUntil,
    });
    await persistInitialSessionProjection(input.env, {
      session: created.session,
      replay: created.replay,
      sessionKind: "repo",
      projectionSource: `services.pr-review-trigger.${input.triggerSource}`,
      projectionUserId: input.ownerUserId,
    });

    const association = await associatePrReviewTriggerSession(input.env.DB, {
      prUrl: input.prUrl,
      claimToken: input.claimToken,
      sessionId,
    });
    if (!association.updated) throw new Error("PR review trigger claim ownership was lost");

    const focus = input.focus ? `\n\nReviewer focus: ${input.focus}` : "";
    const enqueued = await enqueueSessionPrompt(
      input.env,
      sessionId,
      `Review pull request ${input.prUrl} at its current head.${focus}`,
      input.ownerUserId,
      { auth },
    );
    if (!enqueued.ok) throw new Error(`PR review prompt enqueue failed: ${enqueued.status}`);
    const completed = await completePrReviewTrigger(input.env.DB, {
      prUrl: input.prUrl,
      claimToken: input.claimToken,
    });
    if (!completed.updated) {
      log.warn(
        {
          event: "pr_review_trigger",
          triggerSource: input.triggerSource,
          outcome: "completion_ownership_lost",
          sessionId,
        },
        "PR review trigger claim ownership was lost after enqueue",
      );
      return { ok: true, sessionId };
    }

    const createdLog = Promise.resolve(
      log.info(
        {
          event: "pr_review_trigger",
          triggerSource: input.triggerSource,
          outcome: "created",
          sessionId,
          model_pairing: getPrReviewModelPairing(input.authorAgentRuntimeBackend, model.agentRuntimeBackend),
          reviewer_model: model.currentModel,
          author_backend: input.authorAgentRuntimeBackend ?? "unknown",
        },
        "Created PR review",
      ),
    );
    if (input.waitUntil) input.waitUntil(createdLog);
    else void createdLog;
    return { ok: true, sessionId };
  } catch (error) {
    // Best-effort terminalization prevents a projected reviewer from remaining
    // active when a later phase failed. The token-scoped release cannot delete
    // a newer attempt's claim after a stale takeover.
    try {
      if (sessionId) {
        const closed = await closeSessionState(input.env, sessionId, undefined, {
          reason: "pr_review_trigger_spawn_failed",
        });
        void closed;
      }
    } catch {
      // The original failure is the retry signal; compensation is best effort.
    }
    await releasePrReviewTrigger(input.env.DB, { prUrl: input.prUrl, claimToken: input.claimToken });
    log.error(
      { event: "pr_review_trigger", triggerSource: input.triggerSource, outcome: "spawn_failed", error: String(error) },
      "Failed to create PR review",
    );
    return { ok: false, kind: "retryable", reason: "spawn_failed" };
  }
}
