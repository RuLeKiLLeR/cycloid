import { businessIdsMatch } from "../constants/businesses";
import { SessionEntrypoint } from "../enums/session-entrypoint";
import { actorCanWriteToRepo, getActorRepoPermissionLevel } from "../github/repo-permission";
import { createLogger } from "../logger";
import {
  emitMentionBootstrapOutcomeMetric,
  type MentionBootstrapOutcome,
} from "../observability/mention-bootstrap-metrics";
import { getSessionIndexAgentRoleBusinessRows } from "../session/db";
import { applyEvent } from "../session/fsm/apply-event";
import { insertGenesisRecord } from "../session/fsm/genesis";
import { liveFsmSinks } from "../session/fsm/live-side-effects";
import { buildPublishPrOpenedEmission, publishShadowResolver } from "../session/fsm/publish-producer";
import { claimMentionBootstrap, releaseMentionBootstrap } from "../session/mention-bootstrap-claims-db";
import { getTrackingSessionIdForPrUrl } from "../session/pr-coordination-db";
import { createSessionState } from "../session/state";
import type { Env } from "../types";
import { listSessionIdsByWebhookRef, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR } from "../webhooks/db";
import { admitSessionCreate } from "./session-admission";
import { resolveSessionContinuation, SessionContinuationError } from "./session-continuation";
import { persistInitialSessionProjection } from "./session-create";

const log = createLogger({ bindings: { component: "github-mention-bootstrap" } });

export type EligibleSessionResult =
  | { kind: "eligible"; sessionId: string }
  | { kind: "other_business"; sessionId: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

export type BootstrapMentionSessionArgs = {
  actorUserId: string;
  actorLogin: string;
  actorBusinessId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  prUrl: string;
  directiveText: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type BootstrapMentionSessionResult =
  | { kind: "created"; sessionId: string }
  | { kind: "handed_off"; sessionId: string }
  | { kind: "skip"; reason: "ambiguous" }
  | {
      kind: "rejected";
      reason: "other_business" | "no_write_permission" | "fork" | "closed" | "unsafe_head_ref" | "admission_rejected";
      publicMessage: string;
    }
  | { kind: "retry"; reason: "github_fetch_failed" | "claim_contended" | "permission_indeterminate" };

export async function resolveEligibleImplementationSession(
  env: Pick<Env, "DB">,
  args: { prUrl: string; actorBusinessId: string },
): Promise<EligibleSessionResult> {
  const trackingSessionId = await getTrackingSessionIdForPrUrl(env.DB, args.prUrl);
  const boundSessionIds = trackingSessionId
    ? [trackingSessionId]
    : await listSessionIdsByWebhookRef(env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, args.prUrl);
  const candidateSessionIds = [...new Set(boundSessionIds)];
  if (candidateSessionIds.length === 0) return { kind: "none" };

  const rows = await getSessionIndexAgentRoleBusinessRows(env.DB, candidateSessionIds);
  const rowsBySessionId = new Map(rows.map((row) => [row.sessionId, row]));
  const implementationSessions = candidateSessionIds.flatMap((sessionId) => {
    const row = rowsBySessionId.get(sessionId);
    return row && (row.agentRole === null || row.agentRole === "implementation") ? [row] : [];
  });

  const sameBusinessSessions = implementationSessions.filter((row) =>
    businessIdsMatch(row.businessId, args.actorBusinessId),
  );
  if (sameBusinessSessions.length > 1) return { kind: "ambiguous" };
  const sameBusinessSession = sameBusinessSessions[0];
  if (sameBusinessSession) return { kind: "eligible", sessionId: sameBusinessSession.sessionId };
  const otherBusinessSession = implementationSessions[0];
  if (otherBusinessSession) return { kind: "other_business", sessionId: otherBusinessSession.sessionId };
  return { kind: "none" };
}

export async function bootstrapMentionSession(
  env: Env,
  args: BootstrapMentionSessionArgs,
): Promise<BootstrapMentionSessionResult> {
  const logResult = (fields: Record<string, unknown>, message: string): void => {
    log.info(
      {
        event: "github_mention_bootstrap",
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
        ...fields,
      },
      message,
    );
  };
  const resolveEligible = () =>
    resolveEligibleImplementationSession(env, {
      prUrl: args.prUrl,
      actorBusinessId: args.actorBusinessId,
    });
  const emitOutcome = (outcome: MentionBootstrapOutcome): void => {
    const promise = emitMentionBootstrapOutcomeMetric(env, outcome).catch(() => {});
    if (args.waitUntil) args.waitUntil(promise);
    else void promise;
  };

  const existing = await resolveEligible();
  if (existing.kind === "eligible") {
    logResult({ outcome: "handed_off", sessionId: existing.sessionId }, "GitHub mention bootstrap handed off");
    emitOutcome("handed_off");
    return { kind: "handed_off", sessionId: existing.sessionId };
  }
  if (existing.kind === "other_business") {
    log.warn(
      {
        event: "github_mention_bootstrap",
        outcome: "rejected",
        reason: "other_business",
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
      },
      "GitHub mention bootstrap rejected",
    );
    emitOutcome("other_business");
    return {
      kind: "rejected",
      reason: "other_business",
      publicMessage: "This pull request is already managed by another Cycloid workspace.",
    };
  }
  if (existing.kind === "ambiguous") {
    log.warn(
      {
        event: "github_mention_bootstrap",
        outcome: "skip",
        reason: "ambiguous",
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
      },
      "GitHub mention bootstrap skipped",
    );
    emitOutcome("skip_ambiguous");
    return { kind: "skip", reason: "ambiguous" };
  }

  const permissionLevel = await getActorRepoPermissionLevel(env, {
    installationId: args.installationId,
    repoOwner: args.repoOwner,
    repoName: args.repoName,
    actorLogin: args.actorLogin,
  });
  if (permissionLevel === null) {
    log.warn(
      {
        event: "github_mention_bootstrap_permission_indeterminate",
        outcome: "retry",
        reason: "permission_indeterminate",
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
      },
      "GitHub mention bootstrap permission lookup returned no level",
    );
    emitOutcome("retry_permission_indeterminate");
    return { kind: "retry", reason: "permission_indeterminate" };
  }
  if (!actorCanWriteToRepo(permissionLevel)) {
    log.warn(
      {
        event: "github_mention_bootstrap",
        outcome: "rejected",
        reason: "no_write_permission",
        permissionLevel,
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
      },
      "GitHub mention bootstrap rejected",
    );
    emitOutcome("no_write_permission");
    return {
      kind: "rejected",
      reason: "no_write_permission",
      publicMessage: "You need write access to this repository for Cycloid to update the pull request.",
    };
  }

  const claim = await claimMentionBootstrap(env.DB, {
    businessId: args.actorBusinessId,
    prUrl: args.prUrl,
  });
  if (!claim.won) {
    const winner = await resolveEligible();
    if (winner.kind === "eligible") {
      logResult(
        { outcome: "handed_off", reason: "claim_lost", sessionId: winner.sessionId },
        "GitHub mention bootstrap handed off after claim contention",
      );
      emitOutcome("handed_off");
      return { kind: "handed_off", sessionId: winner.sessionId };
    }
    log.warn(
      {
        event: "github_mention_bootstrap",
        outcome: "retry",
        reason: "claim_contended",
        resolution: winner.kind,
        actorUserId: args.actorUserId,
        businessId: args.actorBusinessId,
        repoOwner: args.repoOwner,
        repoName: args.repoName,
      },
      "GitHub mention bootstrap claim contended",
    );
    emitOutcome("retry_claim_contended");
    return { kind: "retry", reason: "claim_contended" };
  }

  let claimHeld = true;
  const releaseClaim = async (): Promise<void> => {
    if (!claimHeld) return;
    await releaseMentionBootstrap(env.DB, {
      businessId: args.actorBusinessId,
      prUrl: args.prUrl,
    });
    claimHeld = false;
  };

  try {
    const winner = await resolveEligible();
    if (winner.kind === "eligible") {
      await releaseClaim();
      logResult(
        { outcome: "handed_off", reason: "claim_won_recheck", sessionId: winner.sessionId },
        "GitHub mention bootstrap handed off after winning claim",
      );
      emitOutcome("handed_off");
      return { kind: "handed_off", sessionId: winner.sessionId };
    }
    if (winner.kind === "other_business") {
      await releaseClaim();
      log.warn(
        {
          event: "github_mention_bootstrap",
          outcome: "rejected",
          reason: "other_business",
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
        },
        "GitHub mention bootstrap rejected after winning claim",
      );
      emitOutcome("other_business");
      return {
        kind: "rejected",
        reason: "other_business",
        publicMessage: "This pull request is already managed by another Cycloid workspace.",
      };
    }
    if (winner.kind === "ambiguous") {
      await releaseClaim();
      log.warn(
        {
          event: "github_mention_bootstrap",
          outcome: "skip",
          reason: "ambiguous",
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
        },
        "GitHub mention bootstrap skipped after winning claim",
      );
      emitOutcome("skip_ambiguous");
      return { kind: "skip", reason: "ambiguous" };
    }

    const admission = await admitSessionCreate({
      db: env.DB,
      env,
      businessId: args.actorBusinessId,
    });
    if (!admission.ok) {
      await releaseClaim();
      log.warn(
        {
          event: "github_mention_bootstrap",
          outcome: "rejected",
          reason: "admission_rejected",
          code: admission.code,
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
        },
        "GitHub mention bootstrap rejected",
      );
      emitOutcome("admission_rejected");
      return {
        kind: "rejected",
        reason: "admission_rejected",
        publicMessage: admission.message,
      };
    }

    const sessionId = crypto.randomUUID();
    let continuation: Awaited<ReturnType<typeof resolveSessionContinuation>>;
    try {
      continuation = await resolveSessionContinuation({
        env,
        sessionId,
        prompt: args.directiveText,
        continuePrUrl: args.prUrl,
        continueMode: "update-pr",
        allowPromptInference: false,
        repoContext: { repoOwner: args.repoOwner, repoName: args.repoName },
        installationId: args.installationId,
        logger: log,
      });
    } catch (error) {
      await releaseClaim();
      if (error instanceof SessionContinuationError) {
        const rejectionReason =
          error.reasonCode === "fork_pr"
            ? "fork"
            : error.reasonCode === "closed_pr"
              ? "closed"
              : error.reasonCode === "unsafe_head_ref"
                ? "unsafe_head_ref"
                : null;
        if (rejectionReason) {
          log.warn(
            {
              event: "github_mention_bootstrap",
              outcome: "rejected",
              reason: rejectionReason,
              actorUserId: args.actorUserId,
              businessId: args.actorBusinessId,
              repoOwner: args.repoOwner,
              repoName: args.repoName,
            },
            "GitHub mention bootstrap rejected",
          );
          emitOutcome(rejectionReason);
          return { kind: "rejected", reason: rejectionReason, publicMessage: error.publicMessage };
        }
      }
      log.warn(
        {
          event: "github_mention_bootstrap",
          outcome: "retry",
          reason: "github_fetch_failed",
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
        },
        "GitHub mention bootstrap continuation failed",
      );
      emitOutcome("retry_github_fetch_failed");
      return { kind: "retry", reason: "github_fetch_failed" };
    }

    const adoptedPrMetadata = continuation.adoptedPrMetadata;
    if (!adoptedPrMetadata?.headSha || !continuation.prUrl || continuation.prNumber === null) {
      await releaseClaim();
      log.warn(
        {
          event: "github_mention_bootstrap",
          outcome: "retry",
          reason: "github_fetch_failed",
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
        },
        "GitHub mention bootstrap continuation was incomplete",
      );
      emitOutcome("retry_github_fetch_failed");
      return { kind: "retry", reason: "github_fetch_failed" };
    }

    const { session, replay } = await createSessionState(env, sessionId, args.actorUserId, {
      entrypoint: SessionEntrypoint.GITHUB,
      sessionKind: "repo",
      repoContext: continuation.repoContext,
      prUrl: continuation.prUrl,
      prNumber: continuation.prNumber,
      installationId: args.installationId,
      autoVerify: false,
      adoptedExternalPr: true,
      businessId: args.actorBusinessId,
      waitUntil: args.waitUntil,
    });

    await persistInitialSessionProjection(env, {
      session,
      replay,
      sessionKind: "repo",
      projectionSource: "webhooks.github.mention_bootstrap",
      projectionUserId: args.actorUserId,
      webhookRef: {
        source: SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR,
        externalRef: continuation.prUrl,
      },
      adoptedPrMetadata,
    });

    await insertGenesisRecord({ db: env.DB, now: Date.now }, sessionId);

    const emission = buildPublishPrOpenedEmission(adoptedPrMetadata.headSha);
    const applyResult = await applyEvent(
      {
        db: env.DB,
        env,
        now: Date.now,
        resolver: publishShadowResolver(sessionId, continuation.prUrl),
        ...liveFsmSinks(env, { waitUntil: args.waitUntil }),
        businessId: args.actorBusinessId,
      },
      {
        sessionId,
        event: emission.event,
        metadata: emission.metadata,
        actor: emission.actor,
      },
    );
    if (applyResult.outcome !== "handled" || applyResult.to !== "REVIEW") {
      throw new Error(
        `GitHub mention bootstrap FSM adoption failed for session ${sessionId}: ${applyResult.outcome}/${applyResult.to}`,
      );
    }

    await releaseClaim();
    logResult({ outcome: "created", sessionId }, "GitHub mention bootstrap created session");
    emitOutcome("created");
    return { kind: "created", sessionId };
  } catch (error) {
    try {
      await releaseClaim();
    } catch (releaseError) {
      log.warn(
        {
          event: "github_mention_bootstrap_claim_release_failed",
          actorUserId: args.actorUserId,
          businessId: args.actorBusinessId,
          repoOwner: args.repoOwner,
          repoName: args.repoName,
          error: String(releaseError),
        },
        "GitHub mention bootstrap claim release failed after bootstrap error",
      );
    }
    throw error;
  }
}
