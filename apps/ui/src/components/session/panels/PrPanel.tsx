import {
  CYCLOID_DONE_REASON_LABELS,
  PR_STATE_CHIP_LABELS,
  PR_STATE_CHIP_STATUS,
  type PrStateKey,
  REVIEW_LOOP_STATE_DETAILS,
  REVIEW_LOOP_STATE_LABELS,
} from "../../../constants/session-pr";
import type { SessionDetail } from "../../../types";
import { safeHttpsUrl } from "../../../utils/safe-url";
import { SpinnerIcon } from "../../icons";
import { MarkdownEventContent } from "../../MarkdownEventContent";
import { BranchCopyButton } from "../../prs/BranchCopyButton";
import { cycloidDoneChip } from "../../prs/bucket-config";
import { getManualReviewReason, isDraftPr } from "../../PrSection";
import { ArtifactChip, Badge, Button, buttonClasses, cx, StatusChip } from "../../ui";
import { parsePrNumber } from "../workbench";

export type PrPanelProps = {
  session: SessionDetail;
  prError: string | null;
  qaTestSessionUrl: string | null;
  canTriggerQaVerification: boolean;
  qaVerificationLoading: boolean;
  qaVerificationError: string | null;
  onTriggerQaVerification?: () => void;
  onViewPr: () => void;
  readOnly: boolean;
};

/**
 * Map the FSM projection onto the panel's PR state chip. `uiLifecycleStage` is
 * the strongest signal; archived sessions that predate the stage cutover fall
 * back to `closeReason`, then draft detection, then plain open. Null when the
 * session has no PR.
 */
export function derivePrState(session: SessionDetail): PrStateKey | null {
  if (!session.prUrl) return null;
  switch (session.uiLifecycleStage) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "superseded":
      return "superseded";
    case "merge_ready":
      return "merge_ready";
    case "verifying":
      return "verifying";
  }
  if (session.phase === "archived") {
    if (session.closeReason === "pr_merged") return "merged";
    if (session.closeReason === "pr_closed") return "closed";
  }
  if (isDraftPr(session)) return "draft";
  return "open";
}

/**
 * Post-publish QA-verification chip for the Checks section. Distinct signal
 * from the pre-publish test-gate outcome (`verificationSummary`) ChecksPanel
 * renders: it carries the QTA loop's lifecycle (queued/running/stopped/
 * exhausted) and, once done, its verdict (merge ready vs needs work). Null when
 * the loop never made a claim.
 */
/**
 * PR tab — the session's publish object as a first-class card: number, state
 * chip, branches, provenance, real actions (open PR, QA verify), review-loop
 * status from the FSM projection. Verification evidence lives in the fixed
 * Checks tab so it remains available before a PR exists.
 * sessions without a PR it surfaces the outcome or publish failure instead.
 */
export function PrPanel({
  session,
  prError,
  qaTestSessionUrl,
  canTriggerQaVerification,
  qaVerificationLoading,
  qaVerificationError,
  onTriggerQaVerification,
  onViewPr,
  readOnly,
}: PrPanelProps) {
  const prHref = safeHttpsUrl(session.prUrl);
  const state = prHref ? derivePrState(session) : null;
  const prNumber = parsePrNumber(session.prUrl);
  const headBranch = session.publishedBranch?.trim() || session.lastBranch?.trim() || null;
  const baseBranch = session.baseBranch?.trim() || null;
  const title = session.title?.trim() || null;
  const manualReviewReason = getManualReviewReason(session);
  const showVerify = canTriggerQaVerification && !qaTestSessionUrl && !readOnly && Boolean(onTriggerQaVerification);

  const reviewLoopState = session.reviewLoopDoneState ?? null;
  // Render the cycloid-done aggregate only once it makes a claim ("done");
  // the default "working" value pre-publish carries no information.
  const doneChip =
    session.cycloidDoneState === "done"
      ? cycloidDoneChip({
          state: "done",
          outcome: session.cycloidDoneOutcome ?? null,
          reasons: session.cycloidDoneReasons ?? [],
        })
      : null;
  const doneReasons = (session.cycloidDoneReasons ?? []).map((reason) => CYCLOID_DONE_REASON_LABELS[reason]);

  // Publish-failure message; only meaningful while there is no PR to show.
  const inlinePrMessage = prHref ? null : (prError ?? session.publishError ?? null);

  return (
    <div className="flex flex-col gap-5">
      {prHref && state ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">{prNumber !== null ? `PR #${prNumber}` : "PR"}</p>
            <StatusChip status={PR_STATE_CHIP_STATUS[state]} label={PR_STATE_CHIP_LABELS[state]} />
          </div>
          {/* Session title — the closest persisted proxy; the live GitHub PR title is not stored. */}
          {title && <p className="text-md font-medium text-text-primary">{title}</p>}
          {(headBranch || baseBranch) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {headBranch && <BranchCopyButton branch={headBranch} />}
              {headBranch && baseBranch && (
                <span aria-hidden className="font-mono-tabular text-xs text-text-muted">
                  →
                </span>
              )}
              {baseBranch && <BranchCopyButton branch={baseBranch} />}
            </div>
          )}
          {(session.ownerLogin || session.initiationMode === "automation") && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              {session.ownerLogin && <span>Opened as {session.ownerLogin}</span>}
              {session.initiationMode === "automation" && (
                <ArtifactChip
                  kind="text"
                  label={session.ruleNameSnapshot ? `Automation · ${session.ruleNameSnapshot}` : "Automation"}
                />
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={prHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onViewPr}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              {state === "draft" ? "View draft" : "Open PR"}
            </a>
            {qaTestSessionUrl && (
              <a href={qaTestSessionUrl} className={buttonClasses({ variant: "ghost", size: "sm" })}>
                View QA test
              </a>
            )}
            {showVerify && (
              <Button
                type="button"
                onClick={onTriggerQaVerification}
                disabled={qaVerificationLoading}
                variant="ghost"
                size="sm"
              >
                {qaVerificationLoading && <SpinnerIcon className="h-4 w-4" />}
                {qaVerificationLoading ? "Triggering QA" : "Verify PR"}
              </Button>
            )}
          </div>
          {manualReviewReason && (
            <div className="max-w-2xl text-xs text-warning">
              <MarkdownEventContent content={manualReviewReason} renderAsPlainText={false} />
            </div>
          )}
          {qaVerificationError && <p className="max-w-2xl text-xs text-error">{qaVerificationError}</p>}
        </section>
      ) : (
        (session.outcome || inlinePrMessage) && (
          <section className="flex flex-col gap-3">
            {session.outcome && (
              <div
                className={cx(
                  "border px-4 py-3 text-sm",
                  session.outcome.tone === "error"
                    ? "border-error-soft-border bg-error-soft text-error"
                    : "border-border bg-surface-1 text-text-secondary",
                )}
              >
                <div className="font-medium">{session.outcome.title}</div>
                {session.outcome.detail && (
                  <div className="mt-1 text-xs opacity-90">
                    <MarkdownEventContent content={session.outcome.detail} renderAsPlainText={false} />
                  </div>
                )}
              </div>
            )}
            {inlinePrMessage && (
              <span className="text-xs text-error">
                <MarkdownEventContent content={inlinePrMessage} renderAsPlainText={false} variant="inline" />
              </span>
            )}
          </section>
        )
      )}

      {(reviewLoopState || doneChip) && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Review loop</p>
          {reviewLoopState && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="default">{REVIEW_LOOP_STATE_LABELS[reviewLoopState]}</Badge>
              <span className="text-xs text-text-muted">{REVIEW_LOOP_STATE_DETAILS[reviewLoopState]}</span>
            </div>
          )}
          {doneChip && (
            <div className="flex flex-wrap items-center gap-2">
              <ArtifactChip kind={doneChip.kind} label={doneChip.label} />
              {doneReasons.length > 0 && <span className="text-xs text-text-secondary">{doneReasons.join(", ")}</span>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
