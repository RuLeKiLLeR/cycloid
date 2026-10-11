import { GITHUB_REVIEW_ACK_REACTION, postIssueCommentReaction, postReviewCommentReaction } from "../github/issues";
import { createInstallationToken } from "../github/octokit";
import { getPrReviewComments } from "../github/pr";
import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  isBotOrAppAuthor,
  knownReviewBotIdForActorLogin,
  normalizeGitHubActorLogin,
} from "../github/pr-review-bots";
import { classifyReviewLoopNoise } from "../github/review-loop-noise-gate";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "review-ack-reaction" } });

export type ReviewAckSkipReason = "owned" | "noise";

/**
 * Pure ack decision: given the review/comment author and the body we would react to, decide whether to
 * leave a 👀. Skips Cycloid-owned authors (incl. the cycloid-qa[bot] QA verdict, which IS admitted to
 * ingest via a carve-out) and a KNOWN review bot's no-findings / in-progress placeholder (via the same
 * `classifyReviewLoopNoise` the worklist uses). Humans and custom bots always react — the classifier
 * fail-opens on both, and the residual guard keeps "lgtm, but see comments" reactable.
 */
export function decideReviewAckReaction(params: {
  actorLogin: string | null | undefined;
  actorType: string | null | undefined;
  body: string | null | undefined;
}): { react: true } | { react: false; reason: ReviewAckSkipReason } {
  const login = params.actorLogin ? normalizeGitHubActorLogin(params.actorLogin) : null;
  if (login && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(login)) {
    return { react: false, reason: "owned" };
  }
  // Only a bot/app author can be a known review bot; humans are never noise-gated.
  const knownId = isBotOrAppAuthor(params.actorType) ? knownReviewBotIdForActorLogin(login) : null;
  const botKey = knownId ? `known:${knownId}` : null;
  if (classifyReviewLoopNoise({ botKey, body: params.body }).gated) {
    return { react: false, reason: "noise" };
  }
  return { react: true };
}

export const REVIEW_ACK_INLINE_CAP = 50;

export type ReviewAckSurface =
  | { kind: "issue_comment"; commentId: number; body: string | null }
  | { kind: "review_comment"; commentId: number; body: string | null }
  | {
      kind: "review_submission";
      reviewId: number | null;
      reviewBody: string | null;
      prNumber: number;
      // When the caller already fetched the review's inline comments (human loop), pass them to avoid a
      // second GET. Omitted (bot path) → fetched inside the deferred task and filtered to reviewId.
      inlineComments?: readonly { id: number | null; reviewId: number | null }[];
    };

export interface ReviewAckInput {
  installationId: number | null | undefined;
  owner: string;
  repo: string;
  actorLogin: string | null;
  actorType: string | null;
  surface: ReviewAckSurface;
}

export interface ReviewAckResult {
  posted: number;
  skipped: ReviewAckSkipReason | null;
  cappedFrom: number | null;
}

/** Awaitable core: resolve targets, apply the decision, cap, and post. Thrown errors propagate to the
 *  fire-and-forget wrapper's `.catch`. */
export async function runReviewAckReaction(env: Env, input: ReviewAckInput): Promise<ReviewAckResult> {
  const empty: ReviewAckResult = { posted: 0, skipped: null, cappedFrom: null };
  if (input.installationId == null) return empty;

  // The review_submission surface is gated on owned-author ONLY (body: null → owned-only decision):
  // inline comments are genuine feedback by construction, and a real no-findings summary simply has
  // zero inline targets, so it is still not acked. The noise gate keeps binding the single-body
  // surfaces (issue_comment / review_comment) where placeholder noise actually appears.
  const bodyForDecision = input.surface.kind === "review_submission" ? null : input.surface.body;
  const decision = decideReviewAckReaction({
    actorLogin: input.actorLogin,
    actorType: input.actorType,
    body: bodyForDecision,
  });
  if (!decision.react) return { posted: 0, skipped: decision.reason, cappedFrom: null };

  if (input.surface.kind === "issue_comment") {
    await postIssueCommentReaction(
      env,
      input.installationId,
      input.owner,
      input.repo,
      input.surface.commentId,
      GITHUB_REVIEW_ACK_REACTION,
    );
    return { posted: 1, skipped: null, cappedFrom: null };
  }
  if (input.surface.kind === "review_comment") {
    await postReviewCommentReaction(
      env,
      input.installationId,
      input.owner,
      input.repo,
      input.surface.commentId,
      GITHUB_REVIEW_ACK_REACTION,
    );
    return { posted: 1, skipped: null, cappedFrom: null };
  }

  // review_submission: resolve the review's inline comments, then react to each (capped).
  const reviewId = input.surface.reviewId;
  // Guard a null reviewId: without it, `c.reviewId === reviewId` below would match every comment whose
  // reviewId is also null (a latent wildcard). Callers already guard, so this is defensive-only.
  if (reviewId == null) return empty;
  const installationId = input.installationId;
  const all =
    input.surface.inlineComments ??
    (await getPrReviewComments(
      await createInstallationToken(env, installationId),
      input.owner,
      input.repo,
      input.surface.prNumber,
    ));
  const ids = Array.from(
    new Set(all.filter((c) => c.id != null && c.reviewId === reviewId).map((c) => c.id as number)),
  );
  const capped = ids.slice(0, REVIEW_ACK_INLINE_CAP);
  const cappedFrom = ids.length > REVIEW_ACK_INLINE_CAP ? ids.length : null;
  if (cappedFrom !== null) {
    log.warn(
      { owner: input.owner, repo: input.repo, reviewId, total: ids.length, cap: REVIEW_ACK_INLINE_CAP },
      "Capping review ack 👀 reactions to the inline fan-out limit",
    );
  }
  // Isolate each post: one rejection (e.g. a 404 on a comment deleted between the webhook and this
  // deferred task) must not strand the rest — there is no redelivery retry (the webhook returned 200).
  const results = await Promise.allSettled(
    capped.map((commentId) =>
      postReviewCommentReaction(env, installationId, input.owner, input.repo, commentId, GITHUB_REVIEW_ACK_REACTION),
    ),
  );
  const posted = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.length - posted;
  if (rejected > 0) {
    log.warn(
      { owner: input.owner, repo: input.repo, reviewId, attempted: results.length, rejected },
      "Some review ack 👀 reactions failed to post",
    );
  }
  return { posted, skipped: null, cappedFrom };
}

/** Fire-and-forget: never awaited on the response path, never throws into ingest. */
export function scheduleReviewAckReaction(
  env: Env,
  executionCtx: ExecutionContext | undefined,
  input: ReviewAckInput,
): void {
  const task = runReviewAckReaction(env, input).catch((err) => {
    log.warn(
      {
        error: String(err),
        owner: input.owner,
        repo: input.repo,
        surface: input.surface.kind,
        actorLogin: input.actorLogin,
      },
      "Failed to post review ack 👀 reaction",
    );
  });
  if (executionCtx) executionCtx.waitUntil(task);
}
