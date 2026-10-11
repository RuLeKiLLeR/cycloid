import type { Logger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import type { Env } from "../types";
import { listSessionIdsByWebhookRef, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR } from "../webhooks/db";
import { updateSessionPrMetadataDraft } from "./pr-metadata-db";
import { updateSessionPrDraftState } from "./state";

export type ReconcilePrDraftStateResult = {
  sessionCount: number;
  updated: number;
  skipped: number;
  failed: number;
};

export async function reconcilePrDraftStateForPr(args: {
  env: Env;
  logger: Logger;
  prUrl: string;
  draft: boolean;
  manualReviewReason?: string | null;
  requestId?: string | null;
}): Promise<ReconcilePrDraftStateResult> {
  const sessionIds = await listSessionIdsByWebhookRef(args.env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, args.prUrl);
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const result = await updateSessionPrDraftState(
          args.env,
          sessionId,
          {
            prUrl: args.prUrl,
            draft: args.draft,
            manualReviewReason: args.manualReviewReason ?? null,
          },
          args.requestId ?? null,
        );
        if (result.ok && result.payload?.updated === true) {
          await runWithSentryTag(
            "pr_draft_reconciliation.update_session_pr_metadata",
            () =>
              updateSessionPrMetadataDraft(args.env.DB, {
                sessionId,
                prUrl: args.prUrl,
                prDraft: args.draft,
              }),
            args.logger,
            {
              message: "Failed to update session PR metadata draft state",
              logFields: { sessionId, prUrl: args.prUrl },
            },
          );
          updated += 1;
          return;
        }
        if (!result.ok) {
          failed += 1;
          args.logger.warn(
            { sessionId, prUrl: args.prUrl, status: result.status },
            "PR draft-state reconciliation failed for session",
          );
          return;
        }
        skipped += 1;
      } catch (error) {
        failed += 1;
        args.logger.warn(
          { sessionId, prUrl: args.prUrl, error: String(error) },
          "PR draft-state reconciliation threw for session",
        );
      }
    }),
  );

  return { sessionCount: sessionIds.length, updated, skipped, failed };
}
