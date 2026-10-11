import { useRef, useState } from "react";

import { PR_STATE_CHIP_LABELS, PR_STATE_CHIP_STATUS } from "../../constants/session-pr";
import { useSyncEffect } from "../../hooks/useEffects";
import type { SessionDetail } from "../../types";
import { safeHttpsUrl } from "../../utils/safe-url";
import { MarkdownEventContent } from "../MarkdownEventContent";
import { buttonClasses, cx, StatusChip } from "../ui";
import { derivePrState } from "./panels/PrPanel";
import { parsePrNumber } from "./workbench";

type Props = {
  session: SessionDetail;
  /** Publish-failure message from session state (no-PR sessions only). */
  prError: string | null;
};

/**
 * Compact one-line PR result row at the end of the thread.
 * It surfaces PR state and links the PR number out to GitHub, while the PR
 * object itself (branches, provenance, QA verify, review loop) lives on the
 * PR tab.
 * For sessions that ended without a PR it surfaces the outcome or publish
 * failure inline, since a failure must not hide behind a tab.
 */
export function SessionPrRow({ session, prError }: Props) {
  const prHref = safeHttpsUrl(session.prUrl);
  const state = prHref ? derivePrState(session) : null;
  const prNumber = parsePrNumber(session.prUrl);

  // One-time settle when the review loop lands a done state (merge ready /
  // merged) while this row is mounted. Keyed to the observed transition — a
  // session opened already-done plays nothing, and streaming re-renders that
  // keep the same state never retrigger it.
  const isDoneState = state === "merge_ready" || state === "merged";
  const prevStateRef = useRef(state);
  const [settled, setSettled] = useState(false);
  useSyncEffect(() => {
    const previous = prevStateRef.current;
    prevStateRef.current = state;
    if (state === previous) return;
    setSettled(isDoneState && previous !== null);
  }, [state, isDoneState]);

  if (prHref && state) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2" data-session-pr-row>
        <StatusChip
          status={PR_STATE_CHIP_STATUS[state]}
          label={PR_STATE_CHIP_LABELS[state]}
          className={settled ? "review-loop-settle" : undefined}
        />
        <a
          href={prHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open PR #${prNumber ?? ""} in a new tab`}
          className={buttonClasses({ variant: "ghost", size: "sm", className: "numeral" })}
        >
          {prNumber !== null ? `PR #${prNumber}` : "PR"}
        </a>
      </div>
    );
  }

  const inlinePrMessage = prError ?? session.publishError ?? null;
  if (!inlinePrMessage && !session.outcome) return null;

  return (
    <div className="session-stack-surface session-stack-dense mb-3 flex flex-col items-start gap-3">
      {session.outcome && (
        <div
          className={cx(
            "w-full border px-4 py-3 text-sm",
            session.outcome.tone === "error"
              ? "border-error-soft-border bg-error-soft text-error"
              : "border-border bg-surface-2 text-text-secondary",
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
        <span className="text-error text-xs">
          <MarkdownEventContent content={inlinePrMessage} renderAsPlainText={false} variant="inline" />
        </span>
      )}
    </div>
  );
}
